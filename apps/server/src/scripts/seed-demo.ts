/**
 * Seed the demo user with two strategies and ~200 historical alerts over 14 days.
 *   pnpm --filter @hermes/server seed:demo
 * Deterministic (seeded PRNG) except for the strategy secrets. Re-running replaces the demo user's data.
 */
import { existsSync } from "node:fs";
import {
  MARKETS,
  RiskLimits,
  hiresNowMs,
  slippageBps,
  tradeDirection,
  type AlertStatus,
  type BlockReason,
  type MarketSymbol,
  type NormalizedAlert,
  type Side,
} from "@hermes/shared";
import { DEMO_PRIVY_DID, DEMO_USER_ID, demoWalletAddress } from "../auth/verifier";
import { loadConfig } from "../config";
import { encrypt, generateSecret, shortId } from "../crypto";
import { openDb } from "../db/connection";
import { createRepos, utcDay, type Repos } from "../db/repos";
import { SIM_START_BALANCE_AUSD, generateSimCredentials } from "../perpl/sim-keys";

const DAY = 86_400_000;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface StrategySpec {
  name: string;
  market: MarketSymbol;
  alerts: number;
  basePrice: number;
  sizeRange: [number, number];
  leverage: number;
  winRate: number;
  winMove: [number, number];
  lossMove: [number, number];
}

const SPECS: StrategySpec[] = [
  { name: "BTC trend 15m", market: "BTC", alerts: 108, basePrice: 112_000, sizeRange: [500, 2000], leverage: 3, winRate: 0.6, winMove: [0.002, 0.011], lossMove: [0.0015, 0.007] },
  { name: "ETH mean reversion 5m", market: "ETH", alerts: 94, basePrice: 3_900, sizeRange: [400, 1500], leverage: 2, winRate: 0.54, winMove: [0.0015, 0.008], lossMove: [0.002, 0.009] },
];

async function main() {
  for (const f of [".env", "apps/server/.env"]) if (existsSync(f)) process.loadEnvFile(f);
  const config = loadConfig(process.env, { devKeyFile: true });
  const db = openDb(config.databasePath);
  const repos = createRepos(db);
  const rng = mulberry32(20261011);
  const between = (lo: number, hi: number) => lo + (hi - lo) * rng();
  const chance = (p: number) => rng() < p;
  const now = Date.now();

  // --- user, connection, limits ---
  const user = repos.users.upsertByPrivyDid(DEMO_PRIVY_DID, {
    id: DEMO_USER_ID,
    email: "demo@hermes.local",
    walletAddress: demoWalletAddress(),
  });
  for (const s of repos.strategies.listByUser(user.id)) repos.strategies.delete(s.id); // cascades alerts/orders/fills/approvals
  db.prepare("DELETE FROM positions WHERE user_id = ?").run(user.id);
  db.prepare("DELETE FROM daily_pnl WHERE user_id = ?").run(user.id);
  db.prepare("DELETE FROM orders WHERE user_id = ?").run(user.id);

  const limits = repos.limits.put(
    user.id,
    RiskLimits.parse({
      allowedMarkets: ["BTC", "ETH", "SOL"],
      maxPositionUsd: 5000,
      maxLeverage: 10,
      dailyLossStopUsd: 250,
      approvalThresholdUsd: 2500,
    }),
  );
  // PERPL_MODE=sim: connect the demo user to a simulated Perpl account (fresh Ed25519 key, account 1001, 10,000 AUSD),
  // stored exactly like a pasted key. The server enrolls it with the in-process simulator at boot, so after
  // `seed:demo` + `dev` the dashboard is live (heartbeats, head block, positions). PERPL_MODE=live: there is no key to
  // invent, so the demo user starts unconnected and pastes a real one.
  let connectedAs = "not connected (PERPL_MODE=live: paste a Perpl API key in the app)";
  if (config.perplMode === "sim") {
    const creds = generateSimCredentials(1001);
    repos.connections.upsert({
      userId: user.id,
      accountId: creds.accountId,
      apiKeyPublic: creds.apiKeyPublic,
      apiKeyPrivateEnc: encrypt(creds.apiKeyPrivate, config.masterKey),
      collateral: SIM_START_BALANCE_AUSD,
    });
    connectedAs = `simulated Perpl account ${creds.accountId} (${SIM_START_BALANCE_AUSD} AUSD)`;
  } else {
    repos.connections.delete(user.id);
  }

  const dailyPnl = new Map<string, number>();
  const stats = { alerts: 0, filled: 0, blocked: 0, failed: 0, other: 0 };
  const created: { id: string; name: string; secret: string }[] = [];
  const finalPositions: Parameters<Repos["positions"]["replaceAll"]>[1] = [];

  for (const [specIdx, spec] of SPECS.entries()) {
    const secret = generateSecret();
    const strategy = repos.strategies.create({
      id: shortId(12),
      userId: user.id,
      name: spec.name,
      secretEnc: encrypt(secret, config.masterKey),
      enabled: true,
      defaultMarket: spec.market,
      defaultSizeUsd: Math.round((spec.sizeRange[0] + spec.sizeRange[1]) / 2 / 50) * 50,
      defaultLeverage: spec.leverage,
      createdAt: now - 14 * DAY - 3600_000,
    });
    created.push({ id: strategy.id, name: spec.name, secret });

    const priceAt = (t: number) => {
      const x = t / DAY;
      return spec.basePrice * (1 + 0.035 * Math.sin(x / 2.3 + specIdx) + 0.008 * Math.sin(x * 9.1));
    };

    // alert times, sorted; last one a few minutes ago so the UI looks live
    const times = Array.from({ length: spec.alerts }, () => now - between(4 * 60_000, 14 * DAY)).sort((a, b) => a - b);
    const authFailAt = new Set([Math.floor(spec.alerts * 0.2), Math.floor(spec.alerts * 0.55)]);
    const invalidAt = new Set([Math.floor(spec.alerts * 0.35), Math.floor(spec.alerts * 0.8)]);
    // Large opening orders that wait for human approval: taken by the first clean "open" at/after each index.
    const approvalQueue: { idx: number; mode: "approved" | "expired" | "rejected" }[] = [
      { idx: Math.floor(spec.alerts * 0.3), mode: "approved" },
      { idx: Math.floor(spec.alerts * 0.55), mode: "approved" },
      { idx: Math.floor(spec.alerts * 0.72), mode: "expired" },
      ...(specIdx === 1 ? [{ idx: Math.floor(spec.alerts * 0.9), mode: "rejected" as const }] : []),
    ];

    let pos = null as { side: Side; size: number; entry: number } | null;
    let nextSide: Side = specIdx === 0 ? "long" : "short";
    let prev: { id: string; t: number; body: string } | null = null;

    for (const [i, t] of times.entries()) {
      stats.alerts++;
      const kind: "open" | "close" = pos ? "close" : chance(0.06) ? "close" : "open"; // the strategy sometimes signals a close that has nothing to close
      const side: Side = kind === "open" ? nextSide : (pos?.side ?? (nextSide === "long" ? "short" : "long"));
      const day = utcDay(t);
      const alertId = `alr_${shortId(14)}`;
      const recvMs = Math.round(t * 1000) / 1000 + 0.137;
      const entryRef = priceAt(t);
      let alertPrice = entryRef;
      let sizeUsd = Math.round(between(...spec.sizeRange) / 50) * 50;
      let leverage = spec.leverage;
      const action = kind === "open" ? side : side === "long" ? "close_long" : "close_short";
      let marketForAlert: string = spec.market;

      // --- terminal decision ---
      let status: AlertStatus = "filled";
      let reason: BlockReason | null = null;
      let errorCode: string | null = null;
      let detail: Record<string, unknown> = {};
      let ageSec = between(0.2, 2.5);

      if (kind === "open" && chance(0.035)) {
        status = "blocked";
        reason = "size_above_max";
        sizeUsd = Math.round(between(5500, 7500) / 50) * 50;
        detail = { detail: `Resulting ${spec.market} position ${sizeUsd}.00 USD exceeds the maximum ${limits.maxPositionUsd} USD.` };
      } else if (kind === "open" && chance(0.015)) {
        status = "blocked";
        reason = "leverage_above_max";
        leverage = 25;
        detail = { detail: "Leverage 25x exceeds the maximum 10x." };
      } else if (kind === "open" && chance(0.02)) {
        status = "blocked";
        reason = "market_not_allowed";
        marketForAlert = "ZEC";
        alertPrice = between(40, 52);
        detail = { detail: "ZEC is not in your allowed markets (BTC, ETH, SOL)." };
      } else if (chance(0.03)) {
        status = "blocked";
        reason = "stale_alert";
        ageSec = between(75, 280);
        detail = { detail: `Alert is ${ageSec.toFixed(1)}s old; the maximum is ${limits.maxAlertAgeSec}s.` };
      } else if (chance(0.008)) {
        status = "blocked";
        reason = "rate_limited";
        detail = { detail: "30 orders in the last minute; the maximum is 30." };
      } else if (kind === "open" && (dailyPnl.get(day) ?? 0) <= -limits.dailyLossStopUsd) {
        status = "blocked";
        reason = "daily_loss_stop_hit";
        detail = { detail: `Realised PnL today is ${(dailyPnl.get(day) ?? 0).toFixed(2)} USD; the stop is -${limits.dailyLossStopUsd}.` };
      } else if (kind === "close" && !pos) {
        status = "blocked";
        reason = "no_position_to_close";
        detail = { detail: `No open ${spec.market} position.` };
      } else if (chance(0.04)) {
        status = "failed";
        errorCode = chance(0.6) ? "order_rejected" : "timeout";
      }
      let approval: "approved" | "expired" | "rejected" | undefined;
      const head = approvalQueue[0];
      if (head && i >= head.idx && kind === "open" && status === "filled" && !authFailAt.has(i) && !invalidAt.has(i)) {
        approval = head.mode;
        approvalQueue.shift();
        sizeUsd = specIdx === 0 ? 3000 : 2800;
        if (approval === "expired") {
          status = "expired";
          reason = "approval_expired";
        } else if (approval === "rejected") {
          status = "blocked";
          reason = "approval_rejected";
        }
      }
      if (authFailAt.has(i)) status = "rejected_auth";
      else if (invalidAt.has(i)) status = "invalid";

      const body = JSON.stringify({
        secret: "[redacted]",
        action,
        market: `${marketForAlert}USDT.P`,
        ...(kind === "open" ? { size_usd: sizeUsd } : {}),
        price: Number(alertPrice.toFixed(2)),
        time: new Date(t - ageSec * 1000).toISOString(),
        id: `seed-${specIdx}-${i}`,
      });
      repos.alerts.insert({ id: alertId, strategyId: strategy.id, userId: user.id, rawBody: body, status: "received", receivedAtMs: recvMs, createdAt: Math.round(t) });
      const ev = (st: AlertStatus, atMs: number, d?: Record<string, unknown>) => repos.alerts.addEvent(alertId, st, Math.round(atMs * 1000) / 1000, d ?? null);
      ev("received", recvMs, { source: "webhook" });

      // duplicates: re-delivery of the previous alert a moment later
      if (prev && chance(0.03)) {
        const dupId = `alr_${shortId(14)}`;
        repos.alerts.insert({ id: dupId, strategyId: strategy.id, userId: user.id, rawBody: prev.body, status: "duplicate", receivedAtMs: prev.t + 410.3, createdAt: Math.round(prev.t) + 410 });
        repos.alerts.addEvent(dupId, "received", prev.t + 410.3, { source: "webhook" });
        repos.alerts.addEvent(dupId, "duplicate", prev.t + 411.2, { duplicateOf: prev.id });
        stats.other++;
        stats.alerts++;
      }
      prev = { id: alertId, t: recvMs, body };

      if (status === "rejected_auth") {
        ev("rejected_auth", recvMs + 0.9, { why: "secret_mismatch" });
        repos.alerts.patch(alertId, { status });
        stats.other++;
        continue;
      }
      if (status === "invalid") {
        ev("invalid", recvMs + 1.1, { issues: [{ path: "size_usd", message: "exactly one of size_usd or size is required for an opening order" }] });
        repos.alerts.patch(alertId, { status });
        stats.other++;
        continue;
      }

      const parsed: NormalizedAlert = {
        action,
        intent: { side, kind },
        market: marketForAlert,
        orderType: "market",
        price: Number(alertPrice.toFixed(2)),
        ...(kind === "open" ? { sizeUsd, leverage } : {}),
      };
      repos.alerts.patch(alertId, {
        idempotencyKey: `id:seed-${specIdx}-${i}`,
        parsedJson: JSON.stringify(parsed),
        market: marketForAlert,
        side,
        kind,
        sizeUsd: kind === "open" ? sizeUsd : null,
        alertPrice: Number(alertPrice.toFixed(2)),
      });
      ev("verified", recvMs + between(0.8, 1.9), { key: "id" });
      const tRisk = recvMs + between(2.4, 4.5);

      if (status === "blocked" && reason !== "approval_rejected") {
        ev("blocked", tRisk, { reason, ...detail });
        repos.alerts.patch(alertId, { status, blockReason: reason });
        stats.blocked++;
        continue;
      }
      ev("risk_checked", tRisk, { needsApproval: Boolean(approval && kind === "open"), notionalUsd: sizeUsd });

      let tExec = tRisk;
      if (approval && kind === "open") {
        const aprId = `apr_${shortId(14)}`;
        const expiresAt = Math.round(recvMs + 120_000);
        ev("pending_approval", tRisk + 1.2, { approvalId: aprId, expiresAt });
        repos.approvals.insert({ id: aprId, alertId, userId: user.id, createdAt: Math.round(recvMs), expiresAt });
        if (approval === "expired") {
          repos.approvals.decide(aprId, "expired", expiresAt);
          ev("expired", expiresAt, { approvalId: aprId });
          repos.alerts.patch(alertId, { status: "expired", blockReason: "approval_expired" });
          stats.blocked++;
          continue;
        }
        if (approval === "rejected") {
          const decidedAt = Math.round(recvMs + between(9_000, 30_000));
          repos.approvals.decide(aprId, "rejected", decidedAt);
          ev("blocked", decidedAt, { approvalId: aprId, reason: "approval_rejected" });
          repos.alerts.patch(alertId, { status: "blocked", blockReason: "approval_rejected" });
          stats.blocked++;
          continue;
        }
        const decidedAt = Math.round(recvMs + between(6_000, 14_000));
        repos.approvals.decide(aprId, "approved", decidedAt);
        tExec = decidedAt;
      }

      // --- order ---
      const latency = 300 + 600 * Math.pow(rng(), 1.7); // 300..900 ms, skewed to the low end
      const marketId = MARKETS[spec.market].id;
      const tSent = tExec + latency * 0.22;
      const tAccepted = tExec + latency * 0.55;
      const tFill = tExec + latency;
      const sizeBase = kind === "open" ? sizeUsd / alertPrice : (pos?.size ?? 0);
      const order = repos.orders.insert({
        alertId,
        userId: user.id,
        marketId,
        side,
        kind,
        type: "market",
        size: sizeBase,
        price: null,
        leverage: kind === "open" ? leverage : null,
        createdAt: Math.round(tExec + 5),
      });
      const rq = 5000 + stats.alerts * 2;
      const sn = (stats.alerts % 60000) + 1;
      const lb = 9_000_000 + Math.floor((t - (now - 14 * DAY)) / 400);
      ev("sent", tSent, { orderId: order.id, rq, sn, lb });

      if (status === "failed") {
        ev("failed", tFill + (errorCode === "timeout" ? 4_000 : 0), { orderId: order.id, code: errorCode, message: errorCode === "timeout" ? "No status from Perpl before lb expired" : "Order rejected by Perpl" });
        db.prepare("UPDATE orders SET rq=?, sn=?, lb=?, status='failed', error_code=?, updated_at=? WHERE id=?").run(rq, sn, lb, errorCode, Math.round(tFill), order.id);
        repos.alerts.patch(alertId, { status: "failed", errorCode });
        stats.failed++;
        continue;
      }

      // slippage 0..12 bps worse than the alert price, mostly 1..5
      const slip = chance(0.07) ? between(6, 12) : chance(0.06) ? 0 : between(0.8, 5.2);
      const dirSign: number = tradeDirection(side, kind) === "buy" ? 1 : -1;
      let realized: number | null = null;
      if (kind === "close" && pos) {
        const win = chance(spec.winRate);
        const move = (win ? between(...spec.winMove) : -between(...spec.lossMove)) * 1.8;
        alertPrice = pos.entry * (1 + (pos.side === "long" ? 1 : -1) * move); // where the strategy's exit signal fired
      }
      const alertPx = Number(alertPrice.toFixed(2));
      const fillPrice: number = Number((alertPx * (1 + (dirSign * slip) / 1e4)).toFixed(2));
      const sizeFilled: number = kind === "open" ? sizeUsd / fillPrice : sizeBase;
      const fee = Number((sizeFilled * fillPrice * 0.0002).toFixed(4));
      if (kind === "close" && pos) {
        realized = Number(((pos.side === "long" ? fillPrice - pos.entry : pos.entry - fillPrice) * sizeFilled).toFixed(4));
        dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + realized);
        repos.dailyPnl.add(user.id, day, realized);
      }
      // keep the stored alert price in sync when the close price was derived from the entry
      repos.alerts.patch(alertId, { alertPrice: alertPx });
      const txHash = `0x${Buffer.from(shortId(32)).toString("hex").slice(0, 64)}`;
      ev("accepted", tAccepted, { orderId: order.id, perplOrderId: String(700_000 + stats.alerts) });
      repos.fills.insert({
        orderId: order.id,
        alertId,
        userId: user.id,
        externalId: `seed-${stats.alerts}`,
        price: fillPrice,
        size: sizeFilled,
        fee,
        realizedPnl: realized,
        txHash,
        block: lb + 2,
        atMs: Math.round(tFill * 1000) / 1000,
      });
      ev("filled", tFill, { orderId: order.id, price: fillPrice, size: sizeFilled, txHash });
      db.prepare("UPDATE orders SET rq=?, sn=?, lb=?, perpl_order_id=?, status='filled', tx_hash=?, price=?, updated_at=? WHERE id=?").run(
        rq, sn, lb, String(700_000 + stats.alerts), txHash, fillPrice, Math.round(tFill), order.id,
      );
      repos.alerts.patch(alertId, { status: "filled" });
      stats.filled++;

      if (kind === "open") {
        pos = { side, size: sizeFilled, entry: fillPrice };
        nextSide = side === "long" ? "short" : "long";
      } else {
        pos = null;
      }
      void slippageBps; // (slippage is derived by the report card from alert vs fill price)
    }

    if (pos) {
      const mark = priceAt(now);
      finalPositions.push({
        market: spec.market,
        side: pos.side,
        size: pos.size,
        entryPrice: pos.entry,
        markPrice: mark,
        upnl: (pos.side === "long" ? mark - pos.entry : pos.entry - mark) * pos.size,
        updatedAt: now,
      });
    }
  }

  repos.positions.replaceAll(user.id, finalPositions);
  // Seeded alerts are history, live ones land on top. Make sure a bad seeded day cannot trip today's daily loss stop
  // and block the live demo: never let today's seeded realised PnL sit below 40% of the stop.
  const today = utcDay(now);
  const floor = -limits.dailyLossStopUsd * 0.4;
  const todayPnl = repos.dailyPnl.get(user.id, today);
  if (todayPnl < floor) repos.dailyPnl.add(user.id, today, floor - todayPnl);
  const total = db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE user_id = ?").get(user.id) as { n: number };

  console.log(`Seeded demo user ${user.id} into ${config.databasePath} at ${new Date(hiresNowMs()).toISOString()}`);
  console.log(`  perpl: ${connectedAs}`);
  console.log(`  alerts: ${total.n} (filled ${stats.filled}, blocked/expired ${stats.blocked}, failed ${stats.failed}, other ${stats.other})`);
  for (const c of created) {
    console.log(`  ${c.name}: ${config.publicBaseUrl}/hooks/${c.id}   secret: ${c.secret}`);
  }
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
