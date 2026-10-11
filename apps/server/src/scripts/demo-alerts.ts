/**
 * Fire a realistic stream of TradingView-style alerts at the local Hermes server so the dashboard is lively for
 * screenshots and the demo video.
 *
 *   pnpm --filter @hermes/server demo:alerts                 # until Ctrl-C
 *   pnpm --filter @hermes/server demo:alerts -- --duration 60
 *   pnpm --filter @hermes/server demo:alerts -- --count 20 --speed 2
 *
 * Options (or env): --url (HERMES_URL, default http://127.0.0.1:$PORT), --duration <s>, --count <n>, --speed <x>
 * (divides the 3-8 s gaps), --sim-url (PERPL_SIM_URL, default http://127.0.0.1:$PERPL_SIM_PORT/api, for chart prices).
 *
 * It reads the real webhook secrets from the database (same DATABASE_PATH / HERMES_MASTER_KEY as the server) and POSTs
 * to `/hooks/:strategyId` exactly like TradingView does. The first seven alerts are scripted so a short run already
 * shows every interesting outcome: two opens, a duplicate re-delivery, one over-limit size, one disallowed market, then
 * two closes. After that it opens and closes positions at random with an occasional duplicate.
 */
import { existsSync } from "node:fs";
import { PerplRest } from "@hermes/perpl";
import { MARKETS, isMarketSymbol, type MarketSymbol, type Side } from "@hermes/shared";
import { DEMO_USER_ID } from "../auth/verifier";
import { loadConfig } from "../config";
import { decrypt } from "../crypto";
import { openDb } from "../db/connection";
import { createRepos } from "../db/repos";

function arg(name: string, env?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--")) return process.argv[i + 1];
  return env ? process.env[env] : undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)] as T;
const round50 = (n: number) => Math.max(50, Math.round(n / 50) * 50);

const FALLBACK_PRICES: Record<string, number> = { BTC: 112_000, ETH: 4_100, SOL: 210, MON: 0.04, ZEC: 60 };

async function main() {
  for (const f of [".env", "apps/server/.env"]) if (existsSync(f)) process.loadEnvFile(f);
  const config = loadConfig(process.env, { devKeyFile: true });
  const db = openDb(config.databasePath);
  const repos = createRepos(db);
  const base = (arg("url", "HERMES_URL") ?? `http://127.0.0.1:${config.port}`).replace(/\/+$/, "");
  const speed = Math.max(0.1, Number(arg("speed") ?? 1));
  const durationMs = arg("duration") ? Number(arg("duration")) * 1000 : Infinity;
  const maxCount = arg("count") ? Number(arg("count")) : Infinity;
  const userId = DEMO_USER_ID;

  const strategies = repos.strategies
    .listByUser(userId)
    .filter((s) => s.enabled)
    .map((s) => ({ ...s, secret: decrypt(s.secretEnc, config.masterKey) }));
  if (strategies.length === 0) {
    console.error("No strategies for the demo user. Run `pnpm --filter @hermes/server seed:demo` first.");
    process.exit(1);
  }
  const limits = repos.limits.get(userId);

  // Chart prices: the simulator's mark when reachable, otherwise a plain random walk around the usual levels.
  const simUrl = arg("sim-url", "PERPL_SIM_URL") ?? `http://127.0.0.1:${config.perplSimPort}/api`;
  const rest = new PerplRest({ baseUrl: simUrl, chainId: 10143, timeoutMs: 1500, maxRetries: 0 });
  const walk = new Map<string, number>();
  let decimals: Map<number, number> | undefined;
  async function priceOf(symbol: string): Promise<number> {
    try {
      const id = isMarketSymbol(symbol) ? MARKETS[symbol].id : undefined;
      if (id !== undefined) {
        decimals ??= new Map((await rest.getContext()).markets.map((m) => [m.id, m.priceDecimals]));
        const t = (await rest.getMarketTicker(id)).d[String(id)];
        const dec = decimals.get(id);
        if (t && dec !== undefined) return Number((t.mrk / 10 ** dec).toPrecision(8));
      }
    } catch {
      /* simulator not reachable: fall through */
    }
    const last = walk.get(symbol) ?? FALLBACK_PRICES[symbol] ?? 100;
    const next = last * (1 + between(-0.0008, 0.0008));
    walk.set(symbol, next);
    return Number(next.toPrecision(8));
  }

  const runId = Date.now().toString(36);
  let n = 0;
  let lastBody: { strategy: (typeof strategies)[number]; body: Record<string, unknown> } | undefined;

  async function post(
    s: (typeof strategies)[number],
    body: Record<string, unknown>,
    label: string,
    contentType: "text/plain" | "application/json" = Math.random() < 0.5 ? "text/plain" : "application/json",
  ): Promise<void> {
    n++;
    const t0 = performance.now();
    let status: number;
    let alertId = "";
    let note = "";
    try {
      const res = await fetch(`${base}/hooks/${s.id}`, {
        method: "POST",
        headers: { "content-type": contentType },
        body: JSON.stringify({ secret: s.secret, ...body }),
      });
      status = res.status;
      const j = (await res.json().catch(() => ({}))) as { alertId?: string; duplicate?: boolean };
      alertId = j.alertId ?? "";
      if (j.duplicate) note = " (duplicate)";
    } catch (err) {
      console.error(`#${n} POST failed: ${(err as Error).message}. Is the server running at ${base}?`);
      return;
    }
    console.log(`#${String(n).padStart(2)} ${s.name.padEnd(22)} ${label.padEnd(34)} -> HTTP ${status}${note} ${alertId} (${(performance.now() - t0).toFixed(0)} ms)`);
    // report the outcome a moment later, straight from the database
    if (alertId) {
      setTimeout(() => {
        const a = repos.alerts.get(alertId);
        if (a) console.log(`    ${alertId}: ${a.status}${a.blockReason ? ` (${a.blockReason})` : ""}${a.errorCode ? ` (${a.errorCode})` : ""}`);
      }, 2200).unref();
    }
  }

  const sym = (s: (typeof strategies)[number]): MarketSymbol => (s.defaultMarket && isMarketSymbol(s.defaultMarket) ? s.defaultMarket : "BTC");
  const tvTicker = (m: string) => pick([`${m}USDT.P`, `BINANCE:${m}USDT.P`, `${m}USD`]);
  const openSize = (s: (typeof strategies)[number]) =>
    Math.min(round50((s.defaultSizeUsd ?? 800) * between(0.6, 1.4)), round50(limits.approvalThresholdUsd > 0 ? limits.approvalThresholdUsd * 0.8 : 2000), limits.maxPositionUsd);

  /** Open position of the strategy's market according to the dashboard's own snapshot (the truth). */
  const openSide = (s: (typeof strategies)[number]): Side | undefined => repos.positions.list(userId).find((p) => p.market === sym(s))?.side;
  const lastSide = new Map<string, Side>();

  async function openAlert(s: (typeof strategies)[number], over: { sizeUsd?: number; side?: Side } = {}) {
    const m = sym(s);
    const side: Side = over.side ?? (lastSide.get(s.id) === "long" ? "short" : "long");
    lastSide.set(s.id, side);
    const price = await priceOf(m);
    const size = over.sizeUsd ?? openSize(s);
    const explicit = Math.random() < 0.5;
    const body: Record<string, unknown> = {
      action: explicit ? side : side === "long" ? "buy" : "sell",
      ...(explicit ? {} : { market_position: side }),
      market: tvTicker(m),
      size_usd: size,
      price,
      leverage: s.defaultLeverage ?? 2,
      time: new Date().toISOString(),
      id: `demo-${runId}-${n + 1}`,
      comment: `${s.name} signal`,
    };
    lastBody = { strategy: s, body };
    await post(s, body, `open ${side} ${m} $${size}`);
  }

  async function closeAlert(s: (typeof strategies)[number], side?: Side) {
    const m = sym(s);
    const sd = side ?? openSide(s) ?? "long";
    const price = await priceOf(m);
    const style = pick(["explicit", "strategy", "generic"] as const);
    const body: Record<string, unknown> = {
      action: style === "explicit" ? `close_${sd}` : style === "strategy" ? (sd === "long" ? "sell" : "buy") : "close",
      ...(style === "strategy" ? { market_position: "flat" } : {}),
      market: tvTicker(m),
      price,
      time: new Date().toISOString(),
      id: `demo-${runId}-${n + 1}`,
    };
    lastBody = { strategy: s, body };
    await post(s, body, `close ${sd} ${m}`);
  }

  const s0 = strategies[0]!;
  const s1 = strategies[1] ?? s0;

  const script: Array<() => Promise<void>> = [
    () => openAlert(s0),
    () => openAlert(s1),
    // the same message delivered twice (TradingView retries) -> must not trade twice
    async () => {
      if (lastBody) await post(lastBody.strategy, lastBody.body, "re-delivery of the previous alert");
    },
    // far above the user's max position size -> blocked by the risk limits
    () => openAlert(s0, { sizeUsd: round50(limits.maxPositionUsd * 1.6), side: openSide(s0) ?? "long" }),
    // a market that is not in the user's allowed list -> blocked
    async () => {
      const price = await priceOf("ZEC");
      await post(
        s1,
        { action: "buy", market: "ZECUSDT.P", size_usd: 300, price, leverage: 2, time: new Date().toISOString(), id: `demo-${runId}-${n + 1}` },
        "open long ZEC $300 (not allowed)",
      );
    },
    () => closeAlert(s0),
    () => closeAlert(s1),
  ];

  const started = Date.now();
  const endAt = started + durationMs;
  console.log(`Posting alerts to ${base}/hooks/<strategyId> for ${strategies.map((s) => `"${s.name}"`).join(" and ")} (Ctrl-C to stop)`);
  let stop = false;
  process.on("SIGINT", () => (stop = true));
  process.on("SIGTERM", () => (stop = true));

  let i = 0;
  while (!stop && i < maxCount && Date.now() < endAt) {
    const scripted = script[i];
    if (scripted) {
      await scripted();
    } else {
      const s = pick(strategies);
      if (lastBody && Math.random() < 0.08) {
        await post(lastBody.strategy, lastBody.body, "re-delivery of the previous alert");
      } else if (openSide(s)) {
        await closeAlert(s);
      } else {
        await openAlert(s);
      }
    }
    i++;
    if (i >= maxCount || Date.now() >= endAt) break;
    await sleep((between(3, 8) * 1000) / speed);
  }
  await sleep(2600); // let the last outcome line print
  console.log(`Done: ${n} alerts posted.`);
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
