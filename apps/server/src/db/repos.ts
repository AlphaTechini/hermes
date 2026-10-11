import { randomUUID } from "node:crypto";
import {
  MARKETS,
  MARKET_SYMBOLS,
  RiskLimits,
  slippageBpsFor,
  type AlertDetail,
  type AlertEventDTO,
  type AlertRecord,
  type AlertStatus,
  type Approval,
  type ApprovalStatus,
  type BlockReason,
  type Fill,
  type Order,
  type OrderStatus,
  type Position,
  type Side,
} from "@hermes/shared";
import type { Db } from "./connection";

const MARKET_BY_ID = new Map<number, string>(MARKET_SYMBOLS.map((s) => [MARKETS[s].id, s]));

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string;
  privyDid: string;
  email: string | null;
  walletAddress: string | null;
  createdAt: number;
}

export interface PerplConnectionRow {
  userId: string;
  accountId: string;
  apiKeyPublic: string;
  apiKeyPrivateEnc: string;
  collateral: number | null;
  createdAt: number;
  lastRq: number;
}

export interface StrategyRow {
  id: string;
  userId: string;
  name: string;
  secretEnc: string;
  enabled: boolean;
  defaultMarket: string | null;
  defaultSizeUsd: number | null;
  defaultLeverage: number | null;
  createdAt: number;
}

export interface AlertRow {
  id: string;
  strategyId: string;
  userId: string;
  idempotencyKey: string | null;
  rawBody: string;
  parsedJson: string | null;
  status: AlertStatus;
  blockReason: BlockReason | null;
  errorCode: string | null;
  market: string | null;
  side: Side | null;
  kind: "open" | "close" | null;
  sizeUsd: number | null;
  alertPrice: number | null;
  receivedAtMs: number;
  createdAt: number;
}

export interface NewAlert {
  id: string;
  strategyId: string;
  userId: string;
  rawBody: string;
  status: AlertStatus;
  receivedAtMs: number;
  createdAt?: number;
}

export interface AlertPatch {
  status?: AlertStatus;
  blockReason?: BlockReason | null;
  errorCode?: string | null;
  idempotencyKey?: string | null;
  parsedJson?: string | null;
  market?: string | null;
  side?: Side | null;
  kind?: "open" | "close" | null;
  sizeUsd?: number | null;
  alertPrice?: number | null;
}

export interface AlertFilter {
  userId: string;
  strategyId?: string | undefined;
  status?: AlertStatus | undefined;
  limit: number;
  cursor?: { receivedAtMs: number; id: string } | undefined;
}

export interface NewOrder {
  id?: string;
  alertId: string | null;
  userId: string;
  marketId: number;
  side: Side;
  kind: "open" | "close";
  type: "market" | "limit";
  size: number | null;
  price: number | null;
  leverage: number | null;
  status?: OrderStatus;
  createdAt?: number;
}

export interface OrderPatch {
  rq?: number | null;
  sn?: number | null;
  lb?: number | null;
  size?: number | null;
  price?: number | null;
  perplOrderId?: string | null;
  status?: OrderStatus;
  errorCode?: string | null;
  txHash?: string | null;
}

export interface NewFill {
  id?: string;
  orderId: string;
  alertId: string | null;
  userId: string;
  externalId?: string | null;
  price: number;
  size: number;
  fee: number;
  realizedPnl?: number | null;
  txHash?: string | null;
  block?: number | null;
  atMs: number;
}

export interface ApprovalRow {
  id: string;
  alertId: string;
  userId: string;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
}

/** Everything the report card needs, flattened per alert. */
export interface ReportAlertInput {
  id: string;
  status: AlertStatus;
  blockReason: BlockReason | null;
  errorCode: string | null;
  market: string | null;
  side: Side | null;
  kind: "open" | "close" | null;
  alertPrice: number | null;
  receivedAtMs: number;
  /** hi-res `received` event time (falls back to receivedAtMs). */
  receivedEventAtMs: number;
  /** hi-res time of the first filled/partially_filled event. */
  firstFillEventAtMs: number | null;
  fills: { price: number; size: number; fee: number; realizedPnl: number | null; atMs: number }[];
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const toUser = (r: Raw): UserRow => ({
  id: String(r.id),
  privyDid: String(r.privy_did),
  email: str(r.email),
  walletAddress: str(r.wallet_address),
  createdAt: Number(r.created_at),
});

const toStrategy = (r: Raw): StrategyRow => ({
  id: String(r.id),
  userId: String(r.user_id),
  name: String(r.name),
  secretEnc: String(r.secret_enc),
  enabled: Number(r.enabled) === 1,
  defaultMarket: str(r.default_market),
  defaultSizeUsd: num(r.default_size_usd),
  defaultLeverage: num(r.default_leverage),
  createdAt: Number(r.created_at),
});

const toAlertRow = (r: Raw): AlertRow => ({
  id: String(r.id),
  strategyId: String(r.strategy_id),
  userId: String(r.user_id),
  idempotencyKey: str(r.idempotency_key),
  rawBody: String(r.raw_body),
  parsedJson: str(r.parsed_json),
  status: String(r.status) as AlertStatus,
  blockReason: str(r.block_reason) as BlockReason | null,
  errorCode: str(r.error_code),
  market: str(r.market),
  side: str(r.side) as Side | null,
  kind: str(r.kind) as "open" | "close" | null,
  sizeUsd: num(r.size_usd),
  alertPrice: num(r.alert_price),
  receivedAtMs: Number(r.received_at_ms),
  createdAt: Number(r.created_at),
});

const parseJsonObject = (s: string | null): Record<string, unknown> | null => {
  if (!s) return null;
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const toEvent = (r: Raw): AlertEventDTO => ({
  id: Number(r.id),
  alertId: String(r.alert_id),
  status: String(r.status) as AlertStatus,
  atMs: Number(r.at_ms),
  detail: parseJsonObject(str(r.detail_json)),
});

const toOrder = (r: Raw, market: string | null): Order => ({
  id: String(r.id),
  alertId: str(r.alert_id),
  market,
  marketId: Number(r.market_id),
  side: String(r.side) as Side,
  kind: String(r.kind) as "open" | "close",
  type: String(r.type) as "market" | "limit",
  size: num(r.size),
  price: num(r.price),
  leverage: num(r.leverage),
  rq: num(r.rq),
  sn: num(r.sn),
  lb: num(r.lb),
  perplOrderId: str(r.perpl_order_id),
  status: String(r.status) as OrderStatus,
  errorCode: str(r.error_code),
  txHash: str(r.tx_hash),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const toApprovalRow = (r: Raw): ApprovalRow => ({
  id: String(r.id),
  alertId: String(r.alert_id),
  userId: String(r.user_id),
  status: String(r.status) as ApprovalStatus,
  createdAt: Number(r.created_at),
  expiresAt: Number(r.expires_at),
  decidedAt: num(r.decided_at),
});

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export function createRepos(db: Db) {
  // --- users ---
  const qUserById = db.prepare("SELECT * FROM users WHERE id = ?");
  const qUserByDid = db.prepare("SELECT * FROM users WHERE privy_did = ?");
  const qUserInsert = db.prepare(
    "INSERT INTO users (id, privy_did, email, wallet_address, created_at) VALUES (@id, @privy_did, @email, @wallet_address, @created_at)",
  );
  const qUserSetWallet = db.prepare(
    "UPDATE users SET wallet_address = @wallet, email = COALESCE(@email, email) WHERE id = @id",
  );
  const qUserSetEmail = db.prepare("UPDATE users SET email = @email WHERE id = @id");

  const users = {
    getById(id: string): UserRow | undefined {
      const r = qUserById.get(id) as Raw | undefined;
      return r ? toUser(r) : undefined;
    },
    getByPrivyDid(did: string): UserRow | undefined {
      const r = qUserByDid.get(did) as Raw | undefined;
      return r ? toUser(r) : undefined;
    },
    /** Find-or-create by Privy DID (also used for the dev demo user). */
    upsertByPrivyDid(did: string, init: { id?: string; email?: string | null; walletAddress?: string | null } = {}): UserRow {
      const existing = users.getByPrivyDid(did);
      if (existing) {
        if (init.email && !existing.email) qUserSetEmail.run({ id: existing.id, email: init.email });
        return users.getByPrivyDid(did) as UserRow;
      }
      const id = init.id ?? `usr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      qUserInsert.run({
        id,
        privy_did: did,
        email: init.email ?? null,
        wallet_address: init.walletAddress ?? null,
        created_at: Date.now(),
      });
      return users.getById(id) as UserRow;
    },
    setWallet(id: string, walletAddress: string, email?: string | null): UserRow | undefined {
      qUserSetWallet.run({ id, wallet: walletAddress, email: email ?? null });
      return users.getById(id);
    },
  };

  // --- perpl connections ---
  const qConnGet = db.prepare("SELECT * FROM perpl_connections WHERE user_id = ?");
  const qConnUpsert = db.prepare(`
    INSERT INTO perpl_connections (user_id, account_id, api_key_public, api_key_private_enc, collateral, created_at, last_rq)
    VALUES (@user_id, @account_id, @api_key_public, @api_key_private_enc, @collateral, @created_at, 0)
    ON CONFLICT(user_id) DO UPDATE SET
      account_id = excluded.account_id,
      api_key_public = excluded.api_key_public,
      api_key_private_enc = excluded.api_key_private_enc,
      collateral = COALESCE(excluded.collateral, perpl_connections.collateral),
      last_rq = CASE WHEN perpl_connections.account_id = excluded.account_id THEN perpl_connections.last_rq ELSE 0 END`);
  const qConnDelete = db.prepare("DELETE FROM perpl_connections WHERE user_id = ?");
  const qConnCollateral = db.prepare("UPDATE perpl_connections SET collateral = ? WHERE user_id = ?");
  const qConnLastRq = db.prepare("UPDATE perpl_connections SET last_rq = MAX(last_rq, ?) WHERE user_id = ?");
  const qConnAll = db.prepare("SELECT user_id FROM perpl_connections");

  const connections = {
    get(userId: string): PerplConnectionRow | undefined {
      const r = qConnGet.get(userId) as Raw | undefined;
      if (!r) return undefined;
      return {
        userId: String(r.user_id),
        accountId: String(r.account_id),
        apiKeyPublic: String(r.api_key_public),
        apiKeyPrivateEnc: String(r.api_key_private_enc),
        collateral: num(r.collateral),
        createdAt: Number(r.created_at),
        lastRq: Number(r.last_rq),
      };
    },
    upsert(c: { userId: string; accountId: string; apiKeyPublic: string; apiKeyPrivateEnc: string; collateral?: number | null }): void {
      qConnUpsert.run({
        user_id: c.userId,
        account_id: c.accountId,
        api_key_public: c.apiKeyPublic,
        api_key_private_enc: c.apiKeyPrivateEnc,
        collateral: c.collateral ?? null,
        created_at: Date.now(),
      });
    },
    delete(userId: string): void {
      qConnDelete.run(userId);
    },
    setCollateral(userId: string, collateral: number): void {
      qConnCollateral.run(collateral, userId);
    },
    /** Persist the highest `rq` used; the executor seeds from max(this, Perpl `lfr`). */
    setLastRq(userId: string, rq: number): void {
      qConnLastRq.run(rq, userId);
    },
    allUserIds(): string[] {
      return (qConnAll.all() as { user_id: string }[]).map((r) => r.user_id);
    },
  };

  // --- strategies ---
  const qStratGet = db.prepare("SELECT * FROM strategies WHERE id = ?");
  const qStratList = db.prepare("SELECT * FROM strategies WHERE user_id = ? ORDER BY created_at ASC");
  const qStratInsert = db.prepare(`
    INSERT INTO strategies (id, user_id, name, secret_enc, enabled, default_market, default_size_usd, default_leverage, created_at)
    VALUES (@id, @user_id, @name, @secret_enc, @enabled, @default_market, @default_size_usd, @default_leverage, @created_at)`);
  const qStratUpdate = db.prepare(`
    UPDATE strategies SET name = @name, enabled = @enabled, default_market = @default_market,
      default_size_usd = @default_size_usd, default_leverage = @default_leverage WHERE id = @id`);
  const qStratSecret = db.prepare("UPDATE strategies SET secret_enc = ? WHERE id = ?");
  const qStratDelete = db.prepare("DELETE FROM strategies WHERE id = ?");
  const qStratStats = db.prepare(
    "SELECT COUNT(*) AS n, MAX(received_at_ms) AS last FROM alerts WHERE strategy_id = ?",
  );

  const strategies = {
    get(id: string): StrategyRow | undefined {
      const r = qStratGet.get(id) as Raw | undefined;
      return r ? toStrategy(r) : undefined;
    },
    listByUser(userId: string): StrategyRow[] {
      return (qStratList.all(userId) as Raw[]).map(toStrategy);
    },
    create(s: Omit<StrategyRow, "createdAt"> & { createdAt?: number }): StrategyRow {
      qStratInsert.run({
        id: s.id,
        user_id: s.userId,
        name: s.name,
        secret_enc: s.secretEnc,
        enabled: s.enabled ? 1 : 0,
        default_market: s.defaultMarket,
        default_size_usd: s.defaultSizeUsd,
        default_leverage: s.defaultLeverage,
        created_at: s.createdAt ?? Date.now(),
      });
      return strategies.get(s.id) as StrategyRow;
    },
    update(
      id: string,
      patch: Partial<Pick<StrategyRow, "name" | "enabled" | "defaultMarket" | "defaultSizeUsd" | "defaultLeverage">>,
    ): StrategyRow | undefined {
      const cur = strategies.get(id);
      if (!cur) return undefined;
      const next = { ...cur, ...patch };
      qStratUpdate.run({
        id,
        name: next.name,
        enabled: next.enabled ? 1 : 0,
        default_market: next.defaultMarket,
        default_size_usd: next.defaultSizeUsd,
        default_leverage: next.defaultLeverage,
      });
      return strategies.get(id);
    },
    setSecret(id: string, secretEnc: string): void {
      qStratSecret.run(secretEnc, id);
    },
    delete(id: string): void {
      qStratDelete.run(id);
    },
    stats(id: string): { alertCount: number; lastAlertAt: number | null } {
      const r = qStratStats.get(id) as { n: number; last: number | null };
      return { alertCount: r.n, lastAlertAt: r.last === null ? null : Math.round(r.last) };
    },
  };

  // --- risk limits ---
  const qLimGet = db.prepare("SELECT json FROM risk_limits WHERE user_id = ?");
  const qLimPut = db.prepare(
    "INSERT INTO risk_limits (user_id, json) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json",
  );
  const limits = {
    /** Returns stored limits merged over defaults. */
    get(userId: string): RiskLimits {
      const r = qLimGet.get(userId) as { json: string } | undefined;
      if (!r) return RiskLimits.parse({});
      try {
        return RiskLimits.parse(JSON.parse(r.json));
      } catch {
        return RiskLimits.parse({});
      }
    },
    put(userId: string, value: RiskLimits): RiskLimits {
      const clean = RiskLimits.parse(value);
      qLimPut.run(userId, JSON.stringify(clean));
      return clean;
    },
  };

  // --- alerts + events ---
  const qAlertInsert = db.prepare(`
    INSERT INTO alerts (id, strategy_id, user_id, raw_body, status, received_at_ms, created_at)
    VALUES (@id, @strategy_id, @user_id, @raw_body, @status, @received_at_ms, @created_at)`);
  const qAlertGet = db.prepare("SELECT * FROM alerts WHERE id = ?");
  const qAlertPatch = db.prepare(`
    UPDATE alerts SET
      status = COALESCE(@status, status),
      block_reason = CASE WHEN @set_block = 1 THEN @block_reason ELSE block_reason END,
      error_code = CASE WHEN @set_error = 1 THEN @error_code ELSE error_code END,
      idempotency_key = CASE WHEN @set_key = 1 THEN @idempotency_key ELSE idempotency_key END,
      parsed_json = CASE WHEN @set_parsed = 1 THEN @parsed_json ELSE parsed_json END,
      market = CASE WHEN @set_market = 1 THEN @market ELSE market END,
      side = CASE WHEN @set_side = 1 THEN @side ELSE side END,
      kind = CASE WHEN @set_kind = 1 THEN @kind ELSE kind END,
      size_usd = CASE WHEN @set_size = 1 THEN @size_usd ELSE size_usd END,
      alert_price = CASE WHEN @set_price = 1 THEN @alert_price ELSE alert_price END
    WHERE id = @id`);
  const qAlertByKey = db.prepare(
    "SELECT id, received_at_ms FROM alerts WHERE strategy_id = ? AND idempotency_key = ?",
  );
  const qAlertExpireKey = db.prepare(
    "UPDATE alerts SET idempotency_key = NULL WHERE strategy_id = ? AND idempotency_key = ? AND received_at_ms < ?",
  );
  const qAlertList = db.prepare(`
    SELECT * FROM alerts
    WHERE user_id = @user_id
      AND (@strategy_id IS NULL OR strategy_id = @strategy_id)
      AND (@status IS NULL OR status = @status)
      AND (@cursor_ms IS NULL OR received_at_ms < @cursor_ms OR (received_at_ms = @cursor_ms AND id < @cursor_id))
    ORDER BY received_at_ms DESC, id DESC
    LIMIT @limit`);
  const qEventInsert = db.prepare(
    "INSERT INTO alert_events (alert_id, status, at_ms, detail_json) VALUES (?, ?, ?, ?)",
  );
  const qEvents = db.prepare("SELECT * FROM alert_events WHERE alert_id = ? ORDER BY at_ms ASC, id ASC");
  const qEventLast = db.prepare("SELECT * FROM alert_events WHERE id = ?");
  const qStrategyName = db.prepare("SELECT name FROM strategies WHERE id = ?");
  const qFillsByAlert = db.prepare("SELECT * FROM fills WHERE alert_id = ? ORDER BY at_ms ASC");

  function buildAlertRecord(row: AlertRow): AlertRecord {
    const events = (qEvents.all(row.id) as Raw[]).map(toEvent);
    const fills = (qFillsByAlert.all(row.id) as Raw[]).map((f) => ({
      price: Number(f.price),
      size: Number(f.size),
    }));
    const receivedEv = events.find((e) => e.status === "received");
    const firstFill = events.find((e) => e.status === "partially_filled" || e.status === "filled");
    const latencyMs =
      firstFill && receivedEv ? Math.round((firstFill.atMs - receivedEv.atMs) * 1000) / 1000 : null;
    const totalSize = fills.reduce((a, f) => a + f.size, 0);
    const avgFillPrice = totalSize > 0 ? fills.reduce((a, f) => a + f.price * f.size, 0) / totalSize : null;
    let slippage: number | null = null;
    if (avgFillPrice !== null && row.alertPrice && row.side && row.kind) {
      const s = slippageBpsFor(row.alertPrice, avgFillPrice, row.side, row.kind);
      slippage = Number.isFinite(s) ? Math.round(s * 100) / 100 : null;
    }
    const strat = qStrategyName.get(row.strategyId) as { name: string } | undefined;
    return {
      id: row.id,
      strategyId: row.strategyId,
      strategyName: strat?.name ?? null,
      idempotencyKey: row.idempotencyKey,
      status: row.status,
      blockReason: row.blockReason,
      errorCode: row.errorCode,
      market: row.market,
      side: row.side,
      kind: row.kind,
      sizeUsd: row.sizeUsd,
      alertPrice: row.alertPrice,
      receivedAt: Math.round(row.receivedAtMs),
      createdAt: row.createdAt,
      events,
      latencyMs,
      avgFillPrice,
      slippageBps: slippage,
    };
  }

  const alerts = {
    insert(a: NewAlert): AlertRow {
      qAlertInsert.run({
        id: a.id,
        strategy_id: a.strategyId,
        user_id: a.userId,
        raw_body: a.rawBody,
        status: a.status,
        received_at_ms: a.receivedAtMs,
        created_at: a.createdAt ?? Date.now(),
      });
      return alerts.get(a.id) as AlertRow;
    },
    get(id: string): AlertRow | undefined {
      const r = qAlertGet.get(id) as Raw | undefined;
      return r ? toAlertRow(r) : undefined;
    },
    patch(id: string, p: AlertPatch): void {
      const has = (k: keyof AlertPatch) => (k in p ? 1 : 0);
      qAlertPatch.run({
        id,
        status: p.status ?? null,
        set_block: has("blockReason"),
        block_reason: p.blockReason ?? null,
        set_error: has("errorCode"),
        error_code: p.errorCode ?? null,
        set_key: has("idempotencyKey"),
        idempotency_key: p.idempotencyKey ?? null,
        set_parsed: has("parsedJson"),
        parsed_json: p.parsedJson ?? null,
        set_market: has("market"),
        market: p.market ?? null,
        set_side: has("side"),
        side: p.side ?? null,
        set_kind: has("kind"),
        kind: p.kind ?? null,
        set_size: has("sizeUsd"),
        size_usd: p.sizeUsd ?? null,
        set_price: has("alertPrice"),
        alert_price: p.alertPrice ?? null,
      });
    },
    findByKey(strategyId: string, key: string): { id: string; receivedAtMs: number } | undefined {
      const r = qAlertByKey.get(strategyId, key) as { id: string; received_at_ms: number } | undefined;
      return r ? { id: r.id, receivedAtMs: r.received_at_ms } : undefined;
    },
    /** Detach keys older than the idempotency window so the unique index lets a fresh alert claim the key. */
    expireKey(strategyId: string, key: string, olderThanMs: number): void {
      qAlertExpireKey.run(strategyId, key, olderThanMs);
    },
    addEvent(alertId: string, status: AlertStatus, atMs: number, detail?: Record<string, unknown> | null): AlertEventDTO {
      const info = qEventInsert.run(alertId, status, atMs, detail ? JSON.stringify(detail) : null);
      return toEvent(qEventLast.get(info.lastInsertRowid) as Raw);
    },
    events(alertId: string): AlertEventDTO[] {
      return (qEvents.all(alertId) as Raw[]).map(toEvent);
    },
    record(id: string): AlertRecord | undefined {
      const row = alerts.get(id);
      return row ? buildAlertRecord(row) : undefined;
    },
    list(f: AlertFilter): { items: AlertRecord[]; nextCursor: string | null } {
      const rows = (
        qAlertList.all({
          user_id: f.userId,
          strategy_id: f.strategyId ?? null,
          status: f.status ?? null,
          cursor_ms: f.cursor?.receivedAtMs ?? null,
          cursor_id: f.cursor?.id ?? null,
          limit: f.limit + 1,
        }) as Raw[]
      ).map(toAlertRow);
      const page = rows.slice(0, f.limit);
      const last = page[page.length - 1];
      const nextCursor = rows.length > f.limit && last ? `${last.receivedAtMs}:${last.id}` : null;
      return { items: page.map(buildAlertRecord), nextCursor };
    },
  };

  // --- orders ---
  const qOrderInsert = db.prepare(`
    INSERT INTO orders (id, alert_id, user_id, market_id, side, kind, type, size, price, leverage, status, created_at, updated_at)
    VALUES (@id, @alert_id, @user_id, @market_id, @side, @kind, @type, @size, @price, @leverage, @status, @created_at, @created_at)`);
  const qOrderGet = db.prepare("SELECT * FROM orders WHERE id = ?");
  const qOrderPatch = db.prepare(`
    UPDATE orders SET
      rq = CASE WHEN @set_rq = 1 THEN @rq ELSE rq END,
      sn = CASE WHEN @set_sn = 1 THEN @sn ELSE sn END,
      lb = CASE WHEN @set_lb = 1 THEN @lb ELSE lb END,
      size = CASE WHEN @set_size = 1 THEN @size ELSE size END,
      price = CASE WHEN @set_price = 1 THEN @price ELSE price END,
      perpl_order_id = CASE WHEN @set_poid = 1 THEN @perpl_order_id ELSE perpl_order_id END,
      status = COALESCE(@status, status),
      error_code = CASE WHEN @set_err = 1 THEN @error_code ELSE error_code END,
      tx_hash = CASE WHEN @set_tx = 1 THEN @tx_hash ELSE tx_hash END,
      updated_at = @updated_at
    WHERE id = @id`);
  const qOrdersByAlert = db.prepare("SELECT * FROM orders WHERE alert_id = ? ORDER BY created_at ASC");
  const qOrdersList = db.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?");
  const qOrdersSince = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND created_at >= ?");

  const marketOfId = (id: number): string | null => MARKET_BY_ID.get(id) ?? null;

  const orders = {
    insert(o: NewOrder): Order {
      const id = o.id ?? `ord_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      qOrderInsert.run({
        id,
        alert_id: o.alertId,
        user_id: o.userId,
        market_id: o.marketId,
        side: o.side,
        kind: o.kind,
        type: o.type,
        size: o.size,
        price: o.price,
        leverage: o.leverage,
        status: o.status ?? "pending",
        created_at: o.createdAt ?? Date.now(),
      });
      return orders.get(id) as Order;
    },
    get(id: string): Order | undefined {
      const r = qOrderGet.get(id) as Raw | undefined;
      return r ? toOrder(r, marketOfId(Number(r.market_id))) : undefined;
    },
    patch(id: string, p: OrderPatch): Order | undefined {
      const has = (k: keyof OrderPatch) => (k in p ? 1 : 0);
      qOrderPatch.run({
        id,
        set_rq: has("rq"),
        rq: p.rq ?? null,
        set_sn: has("sn"),
        sn: p.sn ?? null,
        set_lb: has("lb"),
        lb: p.lb ?? null,
        set_size: has("size"),
        size: p.size ?? null,
        set_price: has("price"),
        price: p.price ?? null,
        set_poid: has("perplOrderId"),
        perpl_order_id: p.perplOrderId ?? null,
        status: p.status ?? null,
        set_err: has("errorCode"),
        error_code: p.errorCode ?? null,
        set_tx: has("txHash"),
        tx_hash: p.txHash ?? null,
        updated_at: Date.now(),
      });
      return orders.get(id);
    },
    byAlert(alertId: string): Order[] {
      return (qOrdersByAlert.all(alertId) as Raw[]).map((r) => toOrder(r, marketOfId(Number(r.market_id))));
    },
    list(userId: string, limit: number): Order[] {
      return (qOrdersList.all(userId, limit) as Raw[]).map((r) => toOrder(r, marketOfId(Number(r.market_id))));
    },
    countSince(userId: string, sinceMs: number): number {
      return (qOrdersSince.get(userId, sinceMs) as { n: number }).n;
    },
  };

  // --- fills ---
  const qFillInsert = db.prepare(`
    INSERT OR IGNORE INTO fills (id, order_id, alert_id, user_id, external_id, price, size, fee, realized_pnl, tx_hash, block, at_ms)
    VALUES (@id, @order_id, @alert_id, @user_id, @external_id, @price, @size, @fee, @realized_pnl, @tx_hash, @block, @at_ms)`);
  const qFillGet = db.prepare(`
    SELECT f.*, o.market_id AS o_market_id, o.side AS o_side, o.kind AS o_kind
    FROM fills f JOIN orders o ON o.id = f.order_id WHERE f.id = ?`);
  const qFillsList = db.prepare(`
    SELECT f.*, o.market_id AS o_market_id, o.side AS o_side, o.kind AS o_kind
    FROM fills f JOIN orders o ON o.id = f.order_id
    WHERE f.user_id = ? ORDER BY f.at_ms DESC, f.id DESC LIMIT ?`);
  const qFillsByAlertJoined = db.prepare(`
    SELECT f.*, o.market_id AS o_market_id, o.side AS o_side, o.kind AS o_kind
    FROM fills f JOIN orders o ON o.id = f.order_id WHERE f.alert_id = ? ORDER BY f.at_ms ASC`);

  const toFill = (r: Raw): Fill => ({
    id: String(r.id),
    orderId: String(r.order_id),
    alertId: str(r.alert_id),
    market: marketOfId(Number(r.o_market_id)),
    side: str(r.o_side) as Side | null,
    kind: str(r.o_kind) as "open" | "close" | null,
    price: Number(r.price),
    size: Number(r.size),
    fee: Number(r.fee),
    realizedPnl: num(r.realized_pnl),
    txHash: str(r.tx_hash),
    block: num(r.block),
    atMs: Number(r.at_ms),
  });

  const fills = {
    /** Returns the inserted fill, or undefined if (order, external id) was already recorded. */
    insert(f: NewFill): Fill | undefined {
      const id = f.id ?? `fil_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const info = qFillInsert.run({
        id,
        order_id: f.orderId,
        alert_id: f.alertId,
        user_id: f.userId,
        external_id: f.externalId ?? null,
        price: f.price,
        size: f.size,
        fee: f.fee,
        realized_pnl: f.realizedPnl ?? null,
        tx_hash: f.txHash ?? null,
        block: f.block ?? null,
        at_ms: f.atMs,
      });
      if (info.changes === 0) return undefined;
      return toFill(qFillGet.get(id) as Raw);
    },
    list(userId: string, limit: number): Fill[] {
      return (qFillsList.all(userId, limit) as Raw[]).map(toFill);
    },
    byAlert(alertId: string): Fill[] {
      return (qFillsByAlertJoined.all(alertId) as Raw[]).map(toFill);
    },
  };

  // --- positions ---
  const qPosList = db.prepare("SELECT * FROM positions WHERE user_id = ? ORDER BY market ASC");
  const qPosDeleteAll = db.prepare("DELETE FROM positions WHERE user_id = ?");
  const qPosUpsert = db.prepare(`
    INSERT INTO positions (user_id, market, side, size, entry_price, mark_price, upnl, updated_at)
    VALUES (@user_id, @market, @side, @size, @entry_price, @mark_price, @upnl, @updated_at)
    ON CONFLICT(user_id, market) DO UPDATE SET side = excluded.side, size = excluded.size,
      entry_price = excluded.entry_price, mark_price = excluded.mark_price, upnl = excluded.upnl, updated_at = excluded.updated_at`);

  const positions = {
    list(userId: string): Position[] {
      return (qPosList.all(userId) as Raw[]).map((r) => ({
        market: String(r.market),
        side: String(r.side) as Side,
        size: Number(r.size),
        entryPrice: Number(r.entry_price),
        markPrice: Number(r.mark_price),
        upnl: Number(r.upnl),
        notionalUsd: Number(r.size) * Number(r.mark_price),
        updatedAt: Number(r.updated_at),
      }));
    },
    /** Replace the user's whole position snapshot atomically (zero-size entries are dropped). */
    replaceAll(userId: string, list: Omit<Position, "notionalUsd">[]): void {
      db.transaction(() => {
        qPosDeleteAll.run(userId);
        for (const p of list) {
          if (!(p.size > 0)) continue;
          qPosUpsert.run({
            user_id: userId,
            market: p.market,
            side: p.side,
            size: p.size,
            entry_price: p.entryPrice,
            mark_price: p.markPrice,
            upnl: p.upnl,
            updated_at: p.updatedAt,
          });
        }
      })();
    },
  };

  // --- approvals ---
  const qApprInsert = db.prepare(
    "INSERT INTO approvals (id, alert_id, user_id, status, created_at, expires_at) VALUES (@id, @alert_id, @user_id, 'pending', @created_at, @expires_at)",
  );
  const qApprGet = db.prepare("SELECT * FROM approvals WHERE id = ?");
  const qApprByAlert = db.prepare("SELECT * FROM approvals WHERE alert_id = ?");
  const qApprList = db.prepare(
    "SELECT * FROM approvals WHERE user_id = @user_id AND (@status IS NULL OR status = @status) ORDER BY created_at DESC LIMIT @limit",
  );
  const qApprPending = db.prepare("SELECT * FROM approvals WHERE status = 'pending'");
  /** Compare-and-set: only a still-pending approval can be decided. */
  const qApprDecide = db.prepare(
    "UPDATE approvals SET status = @status, decided_at = @decided_at WHERE id = @id AND status = 'pending'",
  );

  const approvals = {
    insert(a: { id: string; alertId: string; userId: string; createdAt: number; expiresAt: number }): ApprovalRow {
      qApprInsert.run({ id: a.id, alert_id: a.alertId, user_id: a.userId, created_at: a.createdAt, expires_at: a.expiresAt });
      return approvals.get(a.id) as ApprovalRow;
    },
    get(id: string): ApprovalRow | undefined {
      const r = qApprGet.get(id) as Raw | undefined;
      return r ? toApprovalRow(r) : undefined;
    },
    byAlert(alertId: string): ApprovalRow | undefined {
      const r = qApprByAlert.get(alertId) as Raw | undefined;
      return r ? toApprovalRow(r) : undefined;
    },
    list(userId: string, status: ApprovalStatus | undefined, limit: number): ApprovalRow[] {
      return (qApprList.all({ user_id: userId, status: status ?? null, limit }) as Raw[]).map(toApprovalRow);
    },
    allPending(): ApprovalRow[] {
      return (qApprPending.all() as Raw[]).map(toApprovalRow);
    },
    /** Returns true if this call changed the status (i.e. it won the race). */
    decide(id: string, status: Exclude<ApprovalStatus, "pending">, decidedAt: number): boolean {
      return qApprDecide.run({ id, status, decided_at: decidedAt }).changes === 1;
    },
  };

  // --- daily pnl ---
  const qPnlAdd = db.prepare(`
    INSERT INTO daily_pnl (user_id, day, realized_usd) VALUES (?, ?, ?)
    ON CONFLICT(user_id, day) DO UPDATE SET realized_usd = realized_usd + excluded.realized_usd`);
  const qPnlGet = db.prepare("SELECT realized_usd FROM daily_pnl WHERE user_id = ? AND day = ?");
  const dailyPnl = {
    add(userId: string, day: string, usd: number): void {
      qPnlAdd.run(userId, day, usd);
    },
    get(userId: string, day: string): number {
      const r = qPnlGet.get(userId, day) as { realized_usd: number } | undefined;
      return r?.realized_usd ?? 0;
    },
  };

  // --- report inputs ---
  const qReportAlerts = db.prepare(
    "SELECT * FROM alerts WHERE strategy_id = ? AND received_at_ms >= ? ORDER BY received_at_ms ASC",
  );
  const qReportEvents = db.prepare(
    "SELECT status, MIN(at_ms) AS at_ms FROM alert_events WHERE alert_id = ? AND status IN ('received','partially_filled','filled') GROUP BY status",
  );
  const reports = {
    alertsForStrategy(strategyId: string, sinceMs: number): ReportAlertInput[] {
      const rows = (qReportAlerts.all(strategyId, sinceMs) as Raw[]).map(toAlertRow);
      return rows.map((a) => {
        const evs = qReportEvents.all(a.id) as { status: string; at_ms: number }[];
        const received = evs.find((e) => e.status === "received")?.at_ms ?? a.receivedAtMs;
        const fillTimes = evs.filter((e) => e.status !== "received").map((e) => e.at_ms);
        return {
          id: a.id,
          status: a.status,
          blockReason: a.blockReason,
          errorCode: a.errorCode,
          market: a.market,
          side: a.side,
          kind: a.kind,
          alertPrice: a.alertPrice,
          receivedAtMs: a.receivedAtMs,
          receivedEventAtMs: received,
          firstFillEventAtMs: fillTimes.length ? Math.min(...fillTimes) : null,
          fills: (qFillsByAlert.all(a.id) as Raw[]).map((f) => ({
            price: Number(f.price),
            size: Number(f.size),
            fee: Number(f.fee),
            realizedPnl: num(f.realized_pnl),
            atMs: Number(f.at_ms),
          })),
        };
      });
    },
  };

  /** Full alert detail for GET /api/alerts/:id. */
  function alertDetail(id: string): AlertDetail | undefined {
    const row = alerts.get(id);
    if (!row) return undefined;
    const rec = buildAlertRecord(row);
    const appr = approvals.byAlert(id);
    return {
      ...rec,
      rawBody: row.rawBody,
      parsed: parseJsonObject(row.parsedJson),
      orders: orders.byAlert(id),
      fills: fills.byAlert(id),
      approval: appr ? toApprovalDto(appr, rec) : null,
    };
  }

  function toApprovalDto(a: ApprovalRow, rec?: AlertRecord): Approval {
    const r = rec ?? alerts.record(a.alertId);
    return {
      id: a.id,
      alertId: a.alertId,
      status: a.status,
      createdAt: a.createdAt,
      expiresAt: a.expiresAt,
      decidedAt: a.decidedAt,
      strategyName: r?.strategyName ?? null,
      market: r?.market ?? null,
      side: r?.side ?? null,
      kind: r?.kind ?? null,
      notionalUsd: r?.sizeUsd ?? null,
    };
  }

  return {
    db,
    users,
    connections,
    strategies,
    limits,
    alerts,
    orders,
    fills,
    positions,
    approvals,
    dailyPnl,
    reports,
    alertDetail,
    toApprovalDto,
    /** Run several repo calls atomically. */
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
  };
}

export type Repos = ReturnType<typeof createRepos>;
