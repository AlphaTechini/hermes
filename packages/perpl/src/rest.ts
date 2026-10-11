/**
 * Perpl REST client (docs/research/perpl.md sections 2 and 7).
 *
 * Base URL is `https://testnet.perpl.xyz/api`; request targets start `/v1/...`. Signed requests sign the target WITHOUT
 * the `/api` prefix. Typed results, graceful errors with status codes:
 *
 *  - 451 is surfaced as {@link PerplGeoBlockedError}: Perpl refuses trading endpoints from US datacenter IPs (and the
 *    `geo_block` countries), so the backend must run in an allowed region and the browser must never call Perpl directly.
 *  - 429 / 503 are retried with exponential back-off (503 = the service is warming up, 429 = rate limited).
 */
import { z } from "zod";
import {
  accountEventSchema,
  fillSchema,
  orderSchema,
  parseBatchStatus,
  parseHistoryPage,
  parseSnapshot,
  positionSchema,
  type AccountEvent,
  type BatchStatusResponse,
  type Fill,
  type HistoryPage,
  type MarketStateFrame,
  type Order,
  type OrderSpec,
  type OrdersFrame,
  type Position,
  type PositionsFrame,
  type WalletFrame,
  toOrderSpec,
  L2BookFrame,
  parseServerFrame,
} from "./protocol";
import type { MarketSpec } from "./scaling";
import { Ed25519Signer, signRestRequest } from "./signing";

// ---------------------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------------------

export class PerplHttpError extends Error {
  readonly status: number;
  readonly method: string;
  readonly target: string;
  readonly body: unknown;
  constructor(message: string, p: { status: number; method: string; target: string; body: unknown }) {
    super(message);
    this.name = "PerplHttpError";
    this.status = p.status;
    this.method = p.method;
    this.target = p.target;
    this.body = p.body;
  }
  /** 404 on wallet/state endpoints means the wallet has no exchange account yet. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

/** HTTP 451: region / IP blocked by Perpl. */
export class PerplGeoBlockedError extends PerplHttpError {
  constructor(p: { method: string; target: string; body: unknown }) {
    super(
      "Perpl refused the request with HTTP 451 (geo / IP block). Perpl blocks US datacenter IPs and the countries in " +
        "pub/context geo_block; run the Hermes backend in an allowed region (for example an EU one).",
      { status: 451, ...p },
    );
    this.name = "PerplGeoBlockedError";
  }
}

export class PerplNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PerplNetworkError";
  }
}

export class PerplAuthError extends Error {
  constructor(message = "this endpoint needs an API key: construct PerplRest with apiKey and apiSecret") {
    super(message);
    this.name = "PerplAuthError";
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------------------------------

const intLike = z.union([z.number(), z.string().trim().regex(/^-?\d+$/).transform(Number)]);
const amountLike = z.union([z.string(), z.number().transform((n) => String(n))]);

const contextSchema = z.looseObject({
  chain: z.looseObject({
    ver: intLike.optional(),
    chain_id: intLike,
    name: z.string().optional(),
    block_explorer_urls: z.array(z.string()).optional(),
    gas: z.looseObject({ h: intLike.optional() }).optional(),
  }),
  instances: z
    .array(
      z.looseObject({
        id: intLike,
        address: z.string(),
        collateral_token_id: intLike,
        min_account_open_amount: amountLike.default("0"),
        min_deposit_amount: amountLike.default("0"),
        min_withdraw_amount: amountLike.optional(),
        max_account_equity: amountLike.optional(),
      }),
    )
    .default([]),
  tokens: z
    .array(
      z.looseObject({
        id: intLike.optional(),
        address: z.string().optional(),
        symbol: z.string(),
        name: z.string().optional(),
        decimals: intLike,
        display_precision: intLike.optional(),
      }),
    )
    .default([]),
  markets: z
    .array(
      z.looseObject({
        id: intLike,
        instance_id: intLike,
        perpetual_id: intLike.default(0),
        symbol: z.string(),
        name: z.string().default(""),
        funding_interval_blocks: intLike.default(0),
        order_ttl_blocks: intLike.default(20),
        order_retry_blocks: intLike.default(0),
        order_max_market_slippage_bps: intLike.default(100),
        order_max_neg_pnl_collat_bps: intLike.default(0),
        config: z.looseObject({
          is_open: z.boolean().default(true),
          price_decimals: intLike,
          size_decimals: intLike,
          initial_margin: intLike,
          maintenance_margin: intLike.default(0),
          maker_fee: intLike.default(0),
          taker_fee: intLike.default(0),
          maker_fees: z.array(intLike).optional(),
          taker_fees: z.array(intLike).optional(),
          recycle_fee: amountLike.default("0"),
        }),
      }),
    )
    .default([]),
  features: z.record(z.string(), z.unknown()).optional(),
  geo_block: z.array(z.string()).optional(),
});

export type RawContext = z.infer<typeof contextSchema>;

export interface CollateralInfo {
  tokenId: number;
  address: string;
  symbol: string;
  decimals: number;
}

/** Parsed `GET /v1/pub/context`, reduced to what Hermes needs. `raw` keeps the full parsed payload. */
export interface PerplContext {
  chainId: number;
  /** Chain head block at the time of the call, when reported (`chain.gas.h`). */
  headBlock?: number | undefined;
  /** First protocol instance (testnet has exactly one, id 12). */
  instance: { id: number; exchangeAddress: string; collateralTokenId: number };
  collateral: CollateralInfo;
  /** `min_account_open_amount` in collateral units x 10^decimals (testnet: 100 AUSD = 100000000). */
  minAccountOpenAmount: bigint;
  /** `min_deposit_amount` (testnet: 10 AUSD). */
  minDepositAmount: bigint;
  markets: MarketSpec[];
  /** ISO-3166 alpha-2 country codes Perpl blocks. */
  geoBlock: string[];
  features: Record<string, unknown>;
  raw: RawContext;
}

export function marketSpecFromRaw(m: RawContext["markets"][number]): MarketSpec {
  const c = m.config;
  return {
    id: m.id,
    symbol: m.symbol,
    name: m.name,
    instanceId: m.instance_id,
    perpetualId: m.perpetual_id,
    priceDecimals: c.price_decimals,
    sizeDecimals: c.size_decimals,
    maxLeverageHdths: c.initial_margin,
    maintenanceMarginHdths: c.maintenance_margin,
    orderTtlBlocks: m.order_ttl_blocks,
    orderRetryBlocks: m.order_retry_blocks,
    maxSlippageBps: m.order_max_market_slippage_bps,
    maxNegPnlCollatBps: m.order_max_neg_pnl_collat_bps,
    isOpen: c.is_open,
    makerFeesMicros: c.maker_fees ?? [],
    takerFeesMicros: c.taker_fees ?? [],
    makerFeeMicros: c.maker_fee,
    takerFeeMicros: c.taker_fee,
    recycleFee: c.recycle_fee,
    fundingIntervalBlocks: m.funding_interval_blocks,
  };
}

export function parseContext(raw: unknown): PerplContext {
  const r = contextSchema.safeParse(raw);
  if (!r.success) {
    const msg = r.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid /v1/pub/context payload: ${msg}`);
  }
  const ctx = r.data;
  const instance = ctx.instances[0];
  if (!instance) throw new Error("pub/context has no protocol instance");
  const token = ctx.tokens.find((t) => t.id === instance.collateral_token_id);
  if (!token || !token.address) throw new Error(`pub/context: collateral token ${instance.collateral_token_id} not found`);
  return {
    chainId: ctx.chain.chain_id,
    headBlock: ctx.chain.gas?.h,
    instance: { id: instance.id, exchangeAddress: instance.address, collateralTokenId: instance.collateral_token_id },
    collateral: { tokenId: instance.collateral_token_id, address: token.address, symbol: token.symbol, decimals: token.decimals },
    minAccountOpenAmount: BigInt(instance.min_account_open_amount || "0"),
    minDepositAmount: BigInt(instance.min_deposit_amount || "0"),
    markets: ctx.markets.map(marketSpecFromRaw),
    geoBlock: ctx.geo_block ?? [],
    features: ctx.features ?? {},
    raw: ctx,
  };
}

/** Find a market by id or case-insensitive symbol. */
export function findMarket(markets: readonly MarketSpec[], idOrSymbol: number | string): MarketSpec | undefined {
  if (typeof idOrSymbol === "number") return markets.find((m) => m.id === idOrSymbol);
  const up = idOrSymbol.toUpperCase();
  return markets.find((m) => m.symbol.toUpperCase() === up);
}

// ---------------------------------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------------------------------

export interface PerplRestOptions {
  /** `https://testnet.perpl.xyz/api`. Paths start `/v1/...`. */
  baseUrl: string;
  chainId: number;
  /** `X-API-Key` token. Needed for the signed endpoints. */
  apiKey?: string;
  /** Private key: a signer or any string accepted by `parseEd25519Seed`. */
  apiSecret?: string | Ed25519Signer;
  /** Inject for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Per-attempt timeout. Default 10 s. */
  timeoutMs?: number;
  /** Retries for 429/503 and network errors. Default 2. */
  maxRetries?: number;
  /** First back-off delay. Doubles per retry. Default 500 ms. */
  retryBaseMs?: number;
  /** Injected sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Clock for signatures (tests). */
  nowMs?: () => number;
  /** Extra headers on every request (for example a User-Agent). Do NOT set Origin. */
  headers?: Record<string, string>;
}

export type HistoryKind = "fills" | "order-history" | "position-history" | "account-history";
export interface PageQuery {
  /** 1..100, default 50. */
  count?: number;
  /** Cursor from the previous page's `np`. */
  page?: string;
}

export class PerplRest {
  readonly baseUrl: string;
  readonly chainId: number;
  private readonly apiKey: string | undefined;
  private readonly signer: Ed25519Signer | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly nowMs: (() => number) | undefined;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: PerplRestOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.chainId = opts.chainId;
    this.apiKey = opts.apiKey;
    this.signer = opts.apiSecret === undefined ? undefined : typeof opts.apiSecret === "string" ? Ed25519Signer.fromSecret(opts.apiSecret) : opts.apiSecret;
    this.fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.nowMs = opts.nowMs;
    this.extraHeaders = opts.headers ?? {};
  }

  get hasCredentials(): boolean {
    return Boolean(this.apiKey && this.signer);
  }

  // ---- core -------------------------------------------------------------------------------------------------------

  /** Low-level request returning the parsed JSON body. `target` starts with `/v1/` and includes the query string. */
  async request(method: "GET" | "POST", target: string, opts: { signed: boolean; body?: unknown } = { signed: false }): Promise<unknown> {
    if (!target.startsWith("/v1/")) throw new Error(`target must start with /v1/: ${target}`);
    if (opts.signed && !(this.apiKey && this.signer)) throw new PerplAuthError();
    const bodyStr = opts.body === undefined ? "" : JSON.stringify(opts.body);

    let attempt = 0;
    for (;;) {
      try {
        return await this.once(method, target, bodyStr, opts.signed);
      } catch (e) {
        const retryable = (e instanceof PerplHttpError && e.isRetryable) || e instanceof PerplNetworkError;
        if (!retryable || attempt >= this.maxRetries) throw e;
        await this.sleep(this.retryBaseMs * 2 ** attempt);
        attempt++;
      }
    }
  }

  private async once(method: string, target: string, bodyStr: string, signed: boolean): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json", ...this.extraHeaders };
    if (bodyStr) headers["content-type"] = "application/json";
    if (signed && this.apiKey && this.signer) {
      Object.assign(
        headers,
        signRestRequest(
          this.signer,
          { chainId: this.chainId, apiKey: this.apiKey, method, target, ...(bodyStr ? { body: bodyStr } : {}) },
          this.nowMs ? { nowMs: this.nowMs() } : {},
        ),
      );
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + target, { method, headers, ...(bodyStr ? { body: bodyStr } : {}), signal: ac.signal });
    } catch (e) {
      const aborted = (e as Error)?.name === "AbortError";
      throw new PerplNetworkError(aborted ? `${method} ${target} timed out after ${this.timeoutMs} ms` : `${method} ${target} failed: ${(e as Error)?.message ?? e}`, { cause: e });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text().catch(() => "");
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    if (res.ok) return json;
    if (res.status === 451) throw new PerplGeoBlockedError({ method, target, body: json });
    const detail = typeof json === "string" ? json : json && typeof json === "object" ? ((json as { error?: string; message?: string }).error ?? (json as { message?: string }).message ?? JSON.stringify(json)) : "";
    throw new PerplHttpError(`Perpl ${method} ${target} -> HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 300)}` : ""}`, {
      status: res.status,
      method,
      target,
      body: json,
    });
  }

  // ---- public -----------------------------------------------------------------------------------------------------

  /** `GET /v1/pub/context`: collateral token, minimum deposits, markets (+ instance_id, decimals, order_ttl_blocks), geo_block. */
  async getContext(): Promise<PerplContext> {
    return parseContext(await this.request("GET", "/v1/pub/context"));
  }

  /** `GET /v1/market-data/ticker`: state of all markets. `sn` is the newest block. 503 until warm (retried). */
  async getTicker(): Promise<MarketStateFrame> {
    return parseSnapshot<MarketStateFrame>(await this.request("GET", "/v1/market-data/ticker"), 9);
  }

  /** `GET /v1/market-data/:id/ticker`: a map with a single entry. */
  async getMarketTicker(marketId: number): Promise<MarketStateFrame> {
    return parseSnapshot<MarketStateFrame>(await this.request("GET", `/v1/market-data/${marketId}/ticker`), 9);
  }

  /** `GET /v1/market-data/:id/book?levels=n` (max 100 per side). */
  async getBook(marketId: number, levels = 10): Promise<L2BookFrame> {
    const raw = await this.request("GET", `/v1/market-data/${marketId}/book?levels=${Math.max(1, Math.min(100, levels))}`);
    return parseSnapshot<L2BookFrame>(raw, 15);
  }

  // ---- signed state -----------------------------------------------------------------------------------------------

  /** `GET /v1/trading/wallet`. 404 (PerplHttpError.isNotFound) = the wallet has no exchange account. */
  async getWallet(): Promise<WalletFrame> {
    return parseSnapshot<WalletFrame>(await this.request("GET", "/v1/trading/wallet", { signed: true }), 19);
  }

  /** Like {@link getWallet} but returns null on 404 (no exchange account). */
  async getWalletOrNull(): Promise<WalletFrame | null> {
    try {
      return await this.getWallet();
    } catch (e) {
      if (e instanceof PerplHttpError && e.isNotFound) return null;
      throw e;
    }
  }

  /** `GET /v1/trading/orders`: open + untriggered orders. */
  async getOrders(): Promise<OrdersFrame> {
    return parseSnapshot<OrdersFrame>(await this.request("GET", "/v1/trading/orders", { signed: true }), 23);
  }

  /** `GET /v1/trading/positions`: open positions. */
  async getPositions(): Promise<PositionsFrame> {
    return parseSnapshot<PositionsFrame>(await this.request("GET", "/v1/trading/positions", { signed: true }), 26);
  }

  // ---- signed history ---------------------------------------------------------------------------------------------

  private historyTarget(kind: HistoryKind, q: PageQuery): string {
    const params = new URLSearchParams();
    params.set("count", String(Math.max(1, Math.min(100, q.count ?? 50))));
    if (q.page) params.set("page", q.page);
    return `/v1/trading/${kind}?${params.toString()}`;
  }

  /** `GET /v1/trading/fills`, newest first. */
  async getFills(q: PageQuery = {}): Promise<HistoryPage<Fill>> {
    return parseHistoryPage(await this.request("GET", this.historyTarget("fills", q), { signed: true }), fillSchema);
  }

  /** `GET /v1/trading/order-history`, newest first. */
  async getOrderHistory(q: PageQuery = {}): Promise<HistoryPage<Order>> {
    return parseHistoryPage(await this.request("GET", this.historyTarget("order-history", q), { signed: true }), orderSchema);
  }

  /** `GET /v1/trading/position-history`, newest first. */
  async getPositionHistory(q: PageQuery = {}): Promise<HistoryPage<Position>> {
    return parseHistoryPage(await this.request("GET", this.historyTarget("position-history", q), { signed: true }), positionSchema);
  }

  /** `GET /v1/trading/account-history`, newest first (deposits, withdrawals, settlements, funding). */
  async getAccountHistory(q: PageQuery = {}): Promise<HistoryPage<AccountEvent>> {
    return parseHistoryPage(await this.request("GET", this.historyTarget("account-history", q), { signed: true }), accountEventSchema);
  }

  /** Follow `np` cursors until empty or `maxPages` (default 10). There is no server-side filtering by market or date. */
  async fetchAllPages<T>(fetchPage: (q: PageQuery) => Promise<HistoryPage<T>>, opts: { maxPages?: number; count?: number; stopWhen?: (item: T) => boolean } = {}): Promise<T[]> {
    const out: T[] = [];
    let page: string | undefined;
    for (let i = 0; i < (opts.maxPages ?? 10); i++) {
      const res = await fetchPage({ count: opts.count ?? 100, ...(page ? { page } : {}) });
      for (const item of res.d) {
        out.push(item);
        if (opts.stopWhen?.(item)) return out;
      }
      if (!res.np || res.d.length === 0) break;
      page = res.np;
    }
    return out;
  }

  /** `GET /v1/trading/portfolio/{equity|pnl}/{all|day|week|2weeks|month}`. */
  async getPortfolio(kind: "equity" | "pnl", period: "all" | "day" | "week" | "2weeks" | "month"): Promise<{ at?: { b?: number; t?: number }; chart: Array<{ t: number; v: string }> }> {
    const raw = await this.request("GET", `/v1/trading/portfolio/${kind}/${period}`, { signed: true });
    const r = z
      .looseObject({
        at: z.looseObject({ b: intLike.optional(), t: intLike.optional() }).optional(),
        chart: z.array(z.looseObject({ t: intLike, v: amountLike })).default([]),
      })
      .safeParse(raw);
    if (!r.success) throw new Error("invalid portfolio payload");
    return r.data as { at?: { b?: number; t?: number }; chart: Array<{ t: number; v: string }> };
  }

  // ---- signed trade -----------------------------------------------------------------------------------------------

  /**
   * `POST /v1/trading/orders`: one-shot order transport with the same rq/lb semantics as the WebSocket. HTTP 200 means
   * "judged", read every element of `statuses` (positional). `lb` should be 0 (an HTTP client has no heartbeat head).
   */
  async postOrders(specs: OrderSpec[], sn?: number): Promise<BatchStatusResponse> {
    if (specs.length < 1 || specs.length > 100) throw new RangeError("1..100 orders per batch");
    const body = { ...(sn ? { sn } : {}), d: specs.map(toOrderSpec) };
    try {
      return parseBatchStatus(await this.request("POST", "/v1/trading/orders", { signed: true, body }));
    } catch (e) {
      // batch-level refusals are repeated as the HTTP status; surface the structured status when present
      if (e instanceof PerplHttpError && e.body && typeof e.body === "object") {
        try {
          return parseBatchStatus(e.body);
        } catch {
          // not a status body
        }
      }
      throw e;
    }
  }

  /** Head block over HTTP: the `sn` of the ticker (any trading-state response also carries it). */
  async getHeadBlock(): Promise<number | undefined> {
    const t = await this.getTicker();
    return t.sn;
  }

  /** Convenience for reconciliation: look an rq up in open orders, then in order-history (first `maxPages` pages). */
  async findOrdersByRq(rq: number, accountId?: number, maxPages = 3): Promise<Order[]> {
    const matches = (o: Order): boolean => o.rq === rq && (accountId === undefined || o.acc === accountId);
    const found: Order[] = [];
    const open = await this.getOrders();
    found.push(...open.d.filter(matches));
    const hist = await this.fetchAllPages((q) => this.getOrderHistory(q), { maxPages, count: 100 });
    found.push(...hist.filter(matches));
    return found;
  }
}

// keep `parseServerFrame` reachable for consumers that want to parse raw REST frames
export { parseServerFrame };
