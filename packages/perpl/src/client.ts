/**
 * High-level Perpl client for ONE user account: signed REST + trading WebSocket + order tracker + market data.
 *
 * ```ts
 * const client = new PerplClient({ restUrl, wsUrl, apiKey, apiSecret, lastRq, onRqAdvance });
 * await client.connect();
 * const outcome = await client.placeMarketOrder({ market: "BTC", side: "long", kind: "open", sizeUsd: 500, leverage: 3, maxSlippageBps: 50 });
 * ```
 * `toServerClient()` (server-adapter.ts) wraps it in the `PerplClient` interface of apps/server/src/perpl/types.ts.
 */
import {
  OrderFlag,
  OrderStatus,
  OrderType,
  PositionStatus,
  PositionStatusReason,
  PositionType,
  type Account,
  type Fill,
  type Order,
  type Position,
  type StatusResponseFrame,
  type WalletFrame,
} from "./protocol";
import { PerplMarketData, type MarkPrice } from "./market-data";
import { OrderTracker, selectAccountForMarket, type OrderIntent, type OrderLifecycleHandlers, type OrderOutcome, type OrderTrackerOptions } from "./order-tracker";
import { PerplRest, findMarket, type PerplContext } from "./rest";
import { cnsToAusd, fromScaled, leverageToHundredths, lotsForNotional, sizeToLots, type MarketSpec } from "./scaling";
import { Ed25519Signer } from "./signing";
import { PerplTradingSocket, type TradingSocketOptions } from "./trading-ws";
import { TypedEmitter, noopLogger, sleep, type Logger } from "./util";

export const TESTNET_REST_URL = "https://testnet.perpl.xyz/api";
export const TESTNET_WS_URL = "wss://testnet.perpl.xyz";
export const TESTNET_CHAIN_ID = 10143;

export interface PerplClientOptions {
  /** REST base including `/api`. Default `https://testnet.perpl.xyz/api`. */
  restUrl?: string;
  /** WebSocket base. Default `wss://testnet.perpl.xyz`. */
  wsUrl?: string;
  /** Default 10143. */
  chainId?: number;
  /** `X-API-Key` token. */
  apiKey: string;
  /** Ed25519 private key (hex / base64 / base64url / PEM) or a signer. */
  apiSecret: string | Ed25519Signer;
  /** Pin the exchange account id. Default: the account whose `in` equals each market's `instance_id`. */
  accountId?: number;
  /** Persisted rq high-water mark for this account (the server stores `onRqAdvance` values). */
  lastRq?: number;
  /** Called with every new rq BEFORE it is sent. Persist it. */
  onRqAdvance?: (rq: number, accountId: number) => void | Promise<void>;
  logger?: Logger;
  fetch?: typeof fetch;
  /** Subscribe to the market-data socket for mark prices. Default true; REST ticker is always the fallback. */
  marketDataSocket?: boolean;
  /** Default leverage for opens that do not pass one. Default 1. */
  defaultLeverage?: number;
  /** Default `ms` in bps. Default 50. */
  defaultMaxSlippageBps?: number;
  tracker?: Partial<Omit<OrderTrackerOptions, "socket" | "getMarket" | "onRqAdvance" | "initialRq" | "reconcile" | "refreshAccounts">>;
  socket?: Partial<Pick<TradingSocketOptions, "reconnect" | "backoffMs" | "jitter" | "random" | "maxRequestsPerMinute" | "authTimeoutMs" | "heartbeatTimeoutMs" | "pingIntervalMs" | "createSocket">>;
}

export interface PlaceMarketOrderParams {
  /** Symbol (`"BTC"`, case-insensitive) or Perpl market id. */
  market: string | number;
  /** Position side acted on: open a long / short, or close the long / short. */
  side: "long" | "short";
  kind: "open" | "close";
  /** Base-asset size (for example 0.01 BTC). Rounded DOWN to the lot size. */
  sizeBase?: number;
  /** Notional in USD, converted with the current mark price. Rounded DOWN to the lot size. */
  sizeUsd?: number;
  /** For `kind: "close"` without a size: close the whole open position. Implied when no size is given. */
  closeAll?: boolean;
  /** Leverage multiple for opens (3 = 3x). */
  leverage?: number;
  /** Max slippage in bps (`ms`), clamped to the market maximum. */
  maxSlippageBps?: number;
  /** Echoed in every callback (for example the alert id). */
  tag?: string;
  /** Lifecycle callbacks: sent, accepted, partially_filled, filled, failed, timeout, retry. */
  handlers?: OrderLifecycleHandlers;
  /** Resend an in-flight order with this exact rq (idempotent retry). */
  rq?: number;
}

/** Outcome plus realised PnL for closes (net of fees, AUSD) once Perpl reported the position event. */
export interface PerplOrderResult extends OrderOutcome {
  market: string;
  side: "long" | "short";
  kind: "open" | "close";
  realizedPnlUsd?: number | undefined;
}

export interface PerplPosition {
  market: string;
  marketId: number;
  accountId: number;
  positionId: number;
  side: "long" | "short";
  /** Base units. */
  size: number;
  entryPrice: number;
  markPrice: number;
  /** Unrealised PnL in USD at the mark. */
  upnl: number;
  notionalUsd: number;
  /** Collateral locked in the position, USD. */
  collateralUsd: number;
  leverage: number;
  openedAtMs: number | undefined;
  updatedAtMs: number;
  raw: Position;
}

export interface PerplAccountSnapshot {
  connected: boolean;
  accountId: number | null;
  instanceId: number | null;
  /**
   * Free balance (`b`), USD. ASSUMPTION [perpl.md ?]: position collateral is held outside `b` (moved into the position
   * deposit when a position opens), so equity = b + sum(position collateral + upnl).
   */
  balanceUsd: number;
  lockedUsd: number;
  positionCollateralUsd: number;
  unrealizedPnlUsd: number;
  equityUsd: number;
  availableUsd: number;
  openNotionalUsd: number;
  /** Realised PnL (net of fees) since the client started, current UTC day. */
  realizedPnlTodayUsd: number;
  forwardingEnabled: boolean;
  frozen: boolean;
  feeTier: number;
  /** Last forwarded request id (`lfr`). */
  lastForwardedRq: number;
  updatedAtMs: number;
  /** True when the numbers came from the live socket just now. */
  live: boolean;
}

export interface PerplClientEvents {
  connected: { accountId: number | null; epoch: number };
  disconnected: { code: number; reason: string; willReconnect: boolean };
  account: Account;
  order: { order: Order; market: string };
  fill: { fill: Fill; market: string; price: number; size: number; fee: number; txHash?: string | undefined; block?: number | undefined };
  positions: PerplPosition[];
  realized: { rq: number; market: string; pnlUsd: number; atMs: number };
  status: StatusResponseFrame;
  heartbeat: { sn: number; head: number };
  warning: { code: string; detail: Record<string, unknown> };
  error: Error;
}

export class PerplNotConnectedError extends Error {
  constructor(message = "PerplClient is not connected; call connect() first") {
    super(message);
    this.name = "PerplNotConnectedError";
  }
}

function utcDayStart(ms: number): number {
  return Math.floor(ms / 86_400_000) * 86_400_000;
}

export class PerplClient extends TypedEmitter<PerplClientEvents> {
  readonly rest: PerplRest;
  readonly signer: Ed25519Signer;
  private readonly o: PerplClientOptions & { restUrl: string; wsUrl: string; chainId: number };
  private readonly log: Logger;
  private ctx: PerplContext | undefined;
  private socket: PerplTradingSocket | undefined;
  private tracker: OrderTracker | undefined;
  private marketData: PerplMarketData | undefined;
  private connected = false;
  private readonly accounts = new Map<number, Account>();
  private readonly positions = new Map<string, Position>();
  private positionsUpdatedAt = 0;
  private readonly realizedByRq = new Map<number, number>();
  private readonly realizedEvents: Array<{ atMs: number; pnl: number }> = [];
  private offs: Array<() => void> = [];

  constructor(opts: PerplClientOptions) {
    super();
    this.o = { ...opts, restUrl: opts.restUrl ?? TESTNET_REST_URL, wsUrl: opts.wsUrl ?? TESTNET_WS_URL, chainId: opts.chainId ?? TESTNET_CHAIN_ID };
    this.log = opts.logger ?? noopLogger;
    this.signer = typeof opts.apiSecret === "string" ? Ed25519Signer.fromSecret(opts.apiSecret) : opts.apiSecret;
    this.rest = new PerplRest({
      baseUrl: this.o.restUrl,
      chainId: this.o.chainId,
      apiKey: opts.apiKey,
      apiSecret: this.signer,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  protected override onListenerError(event: keyof PerplClientEvents, err: unknown): void {
    this.log.error("client listener threw", { event: String(event), error: (err as Error)?.message });
  }

  // ---- lifecycle --------------------------------------------------------------------------------------------------

  /**
   * Read the context, open the trading socket (sign-in, snapshots) and the market-data socket. Rejects with
   * `PerplGeoBlockedError` on HTTP 451 and `PerplSocketError` when the sign-in is refused (3401).
   */
  async connect(): Promise<void> {
    if (this.connected) return;
    this.ctx = await this.rest.getContext();
    this.log.info("perpl context", {
      chainId: this.ctx.chainId,
      collateral: this.ctx.collateral.address,
      minOpen: this.ctx.minAccountOpenAmount.toString(),
      markets: this.ctx.markets.map((m) => `${m.symbol}#${m.id}`).join(","),
      geoBlock: this.ctx.geoBlock,
    });
    if (this.ctx.chainId !== this.o.chainId) this.emit("warning", { code: "chain_id_mismatch", detail: { configured: this.o.chainId, context: this.ctx.chainId } });

    const sock = new PerplTradingSocket({
      wsUrl: this.o.wsUrl,
      chainId: this.o.chainId,
      apiKey: this.o.apiKey,
      signer: this.signer,
      logger: this.log,
      ...(this.o.socket ?? {}),
    });
    this.socket = sock;
    this.tracker = new OrderTracker({
      socket: sock,
      getMarket: (id) => this.ctx?.markets.find((m) => m.id === id),
      onRqAdvance: this.o.onRqAdvance,
      initialRq: this.o.lastRq,
      reconcile: (rq, acc) => this.rest.findOrdersByRq(rq, acc),
      refreshAccounts: async () => (await this.rest.getWallet()).as,
      onWarning: (code, detail) => this.emit("warning", { code, detail }),
      logger: this.log,
      ...(this.o.tracker ?? {}),
    });
    this.wire(sock);

    if (this.o.marketDataSocket !== false) {
      this.marketData = new PerplMarketData({ wsUrl: this.o.wsUrl, chainId: this.o.chainId, getMarket: (id) => this.getMarketSpec(id), rest: this.rest, logger: this.log });
      this.marketData.on("error", (e) => this.log.warn("market data", { error: e.message }));
    }

    await sock.connect();
    await sock.whenSnapshots(3000);
    this.connected = true;
    if (this.marketData) {
      // never fail connect() because of the price feed: REST is the fallback
      await Promise.race([this.marketData.start().catch((e: Error) => this.log.warn("market data socket unavailable, using REST ticker", { error: e.message })), sleep(3000)]);
    }
    const acc = this.pinnedOrDefaultAccount();
    if (!acc) {
      this.emit("warning", { code: "no_exchange_account", detail: { instanceId: this.ctx.instance.id, pinned: this.o.accountId ?? null, accounts: this.getAccounts().map((a) => a.id) } });
    }
    this.emit("connected", { accountId: acc?.id ?? null, epoch: sock.epoch });
  }

  async close(): Promise<void> {
    this.connected = false;
    for (const off of this.offs) off();
    this.offs = [];
    this.tracker?.dispose();
    await Promise.allSettled([this.socket?.close(), this.marketData?.stop()]);
    this.socket = undefined;
    this.marketData = undefined;
  }

  isConnected(): boolean {
    return this.connected && this.socket?.isReady() === true;
  }

  /** Parsed `pub/context` (after connect). */
  get context(): PerplContext {
    if (!this.ctx) throw new PerplNotConnectedError();
    return this.ctx;
  }
  get markets(): readonly MarketSpec[] {
    return this.ctx?.markets ?? [];
  }
  /** The order tracker (for advanced callers and tests). */
  get orderTracker(): OrderTracker {
    if (!this.tracker) throw new PerplNotConnectedError();
    return this.tracker;
  }
  get tradingSocket(): PerplTradingSocket {
    if (!this.socket) throw new PerplNotConnectedError();
    return this.socket;
  }

  getMarketSpec(idOrSymbol: number | string): MarketSpec | undefined {
    return findMarket(this.markets, idOrSymbol);
  }

  private requireMarket(idOrSymbol: number | string): MarketSpec {
    const m = this.getMarketSpec(idOrSymbol);
    if (!m) throw new Error(`unknown Perpl market ${idOrSymbol}`);
    return m;
  }

  private wire(sock: PerplTradingSocket): void {
    this.offs.push(
      sock.on("walletSnapshot", (w: WalletFrame) => {
        for (const a of w.as) this.accounts.set(a.id, a);
      }),
      sock.on("account", (a) => {
        this.accounts.set(a.id, a);
        this.emit("account", a);
        if (a.fw === false) this.emit("warning", { code: "forwarding_disabled", detail: { accountId: a.id } });
      }),
      sock.on("orders", ({ frame }) => {
        for (const order of frame.d) this.emit("order", { order, market: this.getMarketSpec(order.mkt)?.symbol ?? String(order.mkt) });
      }),
      sock.on("fills", (f) => {
        for (const fill of f.d) {
          const m = this.getMarketSpec(fill.mkt);
          this.emit("fill", {
            fill,
            market: m?.symbol ?? String(fill.mkt),
            price: m && fill.p !== undefined ? fromScaled(fill.p, m.priceDecimals) : 0,
            size: m ? fromScaled(fill.s, m.sizeDecimals) : fill.s,
            fee: cnsToAusd(fill.f),
            ...(fill.at.txid ? { txHash: fill.at.txid } : {}),
            ...(fill.at.b !== undefined ? { block: fill.at.b } : {}),
          });
        }
      }),
      sock.on("positions", ({ snapshot, frame }) => {
        this.applyPositions(frame.d, snapshot);
        void this.listPositions().then((p) => this.emit("positions", p)).catch(() => {});
      }),
      sock.on("status", (s) => this.emit("status", s)),
      sock.on("heartbeat", (h) => this.emit("heartbeat", { sn: h.sn, head: h.h })),
      sock.on("error", (e) => this.emit("error", e)),
      sock.on("disconnected", (d) => this.emit("disconnected", { code: d.code, reason: d.forced ?? d.reason, willReconnect: d.willReconnect })),
      sock.on("connected", (c) => {
        if (this.connected) this.emit("connected", { accountId: this.pinnedOrDefaultAccount()?.id ?? null, epoch: c.epoch });
      }),
    );
  }

  // ---- state ------------------------------------------------------------------------------------------------------

  private pinnedOrDefaultAccount(): Account | undefined {
    if (this.o.accountId !== undefined) return this.accounts.get(this.o.accountId);
    const instanceId = this.ctx?.instance.id;
    const all = [...this.accounts.values()];
    return all.find((a) => a.in === instanceId) ?? undefined;
  }

  private applyPositions(list: readonly Position[], snapshot: boolean): void {
    if (snapshot) this.positions.clear();
    for (const p of list) {
      this.recordRealized(p);
      const key = `${p.acc}:${p.mkt}`;
      if (p.st === PositionStatus.Open) this.positions.set(key, p);
      else this.positions.delete(key);
    }
    this.positionsUpdatedAt = Date.now();
  }

  private recordRealized(p: Position): void {
    const events = p.e && p.e.length > 0 ? p.e : p.st === PositionStatus.Open ? [] : [p];
    const exits: number[] = [PositionStatusReason.Closed, PositionStatusReason.Decreased, PositionStatusReason.Deleveraged, PositionStatusReason.Liquidated, PositionStatusReason.Unwound];
    for (const ev of events) {
      if (!exits.includes(ev.sr)) continue;
      // realised = dpnl + fnd - fee, `fee` already includes the closing fee `cfee` (types.md "Fees on a position")
      const pnl = cnsToAusd(BigInt(ev.dpnl ?? "0") + BigInt(ev.fnd ?? "0") - BigInt(ev.fee ?? "0"));
      const atMs = ev.at.t ?? p.at.t ?? Date.now();
      this.realizedByRq.set(ev.rq || p.rq, (this.realizedByRq.get(ev.rq || p.rq) ?? 0) + pnl);
      this.realizedEvents.push({ atMs, pnl });
      if (this.realizedEvents.length > 5000) this.realizedEvents.splice(0, this.realizedEvents.length - 5000);
      this.emit("realized", { rq: ev.rq || p.rq, market: this.getMarketSpec(p.mkt)?.symbol ?? String(p.mkt), pnlUsd: pnl, atMs });
    }
  }

  /** Realised PnL (USD, net of fees) booked by position events for an rq, if any arrived. */
  getRealizedPnlForRq(rq: number): number | undefined {
    return this.realizedByRq.get(rq);
  }

  private async ensureSnapshots(): Promise<void> {
    if (!this.socket) throw new PerplNotConnectedError();
    if (this.positionsUpdatedAt > 0) return;
    const ok = await this.socket.whenSnapshots(3000);
    if (!ok && this.positionsUpdatedAt === 0) {
      const frame = await this.rest.getPositions();
      this.applyPositions(frame.d, true);
    }
  }

  /** Current head block: heartbeat first, then market-data heartbeat, then the REST ticker's `sn`. */
  async headBlock(): Promise<number> {
    const h = this.socket?.head ?? this.marketData?.head;
    if (h !== undefined) return h;
    const rest = await this.rest.getHeadBlock();
    if (rest === undefined) throw new Error("head block unavailable");
    return rest;
  }

  /** Mark price in USD (WebSocket cache, REST ticker fallback). Accepts a market id or symbol. */
  async getMarkPrice(market: number | string): Promise<number> {
    const m = this.requireMarket(market);
    if (this.marketData) return this.marketData.getMarkPrice(m.id);
    const frame = await this.rest.getMarketTicker(m.id);
    const s = frame.d[String(m.id)];
    if (!s) throw new Error(`no ticker for ${m.symbol}`);
    return fromScaled(s.mrk, m.priceDecimals);
  }

  /** Full cached price record from the market-data feed. */
  getCachedPrice(market: number | string): MarkPrice | undefined {
    return this.marketData?.getCached(this.requireMarket(market).id);
  }

  /** Open positions in human units with mark-to-market PnL. */
  async getPositions(): Promise<PerplPosition[]> {
    await this.ensureSnapshots();
    return this.listPositions();
  }

  private async listPositions(): Promise<PerplPosition[]> {
    const out: PerplPosition[] = [];
    for (const p of this.positions.values()) {
      const m = this.getMarketSpec(p.mkt);
      if (!m) continue;
      let mark: number;
      try {
        mark = await this.getMarkPrice(m.id);
      } catch {
        mark = fromScaled(p.ep, m.priceDecimals);
      }
      const size = fromScaled(p.s, m.sizeDecimals);
      const entry = fromScaled(p.ep, m.priceDecimals);
      const dir = p.sd === PositionType.Short ? -1 : 1;
      out.push({
        market: m.symbol,
        marketId: m.id,
        accountId: p.acc,
        positionId: p.pid,
        side: p.sd === PositionType.Short ? "short" : "long",
        size,
        entryPrice: entry,
        markPrice: mark,
        upnl: (mark - entry) * size * dir,
        notionalUsd: size * mark,
        collateralUsd: cnsToAusd(p.c),
        leverage: p.lv / 100,
        openedAtMs: p.ots?.t,
        updatedAtMs: p.at.t ?? this.positionsUpdatedAt,
        raw: p,
      });
    }
    return out;
  }

  /** Account balances and mark-to-market equity. See {@link PerplAccountSnapshot} for the balance convention. */
  async getAccount(): Promise<PerplAccountSnapshot> {
    if (!this.socket) throw new PerplNotConnectedError();
    const acc = this.pinnedOrDefaultAccount();
    const positions = this.connected ? await this.getPositions() : [];
    const upnl = positions.reduce((a, p) => a + p.upnl, 0);
    const posCollateral = positions.reduce((a, p) => a + p.collateralUsd, 0);
    const notional = positions.reduce((a, p) => a + p.notionalUsd, 0);
    const balance = acc ? cnsToAusd(acc.b) : 0;
    const locked = acc ? cnsToAusd(acc.lb) : 0;
    const dayStart = utcDayStart(Date.now());
    const realizedToday = this.realizedEvents.filter((e) => e.atMs >= dayStart).reduce((a, e) => a + e.pnl, 0);
    return {
      connected: this.isConnected(),
      accountId: acc?.id ?? null,
      instanceId: acc?.in ?? null,
      balanceUsd: balance,
      lockedUsd: locked,
      positionCollateralUsd: posCollateral,
      unrealizedPnlUsd: upnl,
      equityUsd: balance + posCollateral + upnl,
      availableUsd: Math.max(0, balance - locked),
      openNotionalUsd: notional,
      realizedPnlTodayUsd: realizedToday,
      forwardingEnabled: acc?.fw ?? false,
      frozen: acc?.fr ?? false,
      feeTier: acc?.ft ?? 0,
      lastForwardedRq: acc?.lfr ?? 0,
      updatedAtMs: Date.now(),
      live: this.isConnected(),
    };
  }

  /** Raw accounts from the latest wallet snapshot / account updates. */
  getAccounts(): Account[] {
    return [...this.accounts.values()];
  }

  /** Re-read the wallet over REST (use after `allowOrderForwarding` / a deposit if the socket is quiet). */
  async refreshAccounts(): Promise<Account[]> {
    const w = await this.rest.getWallet();
    for (const a of w.as) this.accounts.set(a.id, a);
    this.orderTracker.setAccounts(w.as);
    return w.as;
  }

  // ---- trading ----------------------------------------------------------------------------------------------------

  /**
   * Market order = IOC with `p: 0` and a max slippage. Never throws for business failures: inspect `outcome.status`
   * (`filled`, `partially_filled`, `failed`, `timeout`) and `outcome.failure`.
   */
  async placeMarketOrder(p: PlaceMarketOrderParams): Promise<PerplOrderResult> {
    if (!this.tracker || !this.socket) throw new PerplNotConnectedError();
    const market = this.requireMarket(p.market);
    const handlers = p.handlers ?? {};
    const base = { market: market.symbol, side: p.side, kind: p.kind };
    const slippage = Math.min(p.maxSlippageBps ?? this.o.defaultMaxSlippageBps ?? 50, market.maxSlippageBps);
    const reject = async (code: string, message: string): Promise<PerplOrderResult> => {
      const out = await this.tracker!.reject({ marketId: market.id, type: OrderType.OpenLong, size: 0, leverage: 100, ...(p.tag ? { tag: p.tag } : {}) }, handlers, code, message);
      return { ...out, ...base };
    };

    let intent: OrderIntent;
    if (p.kind === "open") {
      let lots: number;
      try {
        if (p.sizeBase !== undefined) lots = sizeToLots(p.sizeBase, market.sizeDecimals, "floor");
        else if (p.sizeUsd !== undefined) lots = lotsForNotional(p.sizeUsd, await this.getMarkPrice(market.id), market.sizeDecimals, "floor");
        else return reject("invalid_order", "an open order needs sizeBase or sizeUsd");
      } catch (e) {
        return reject("invalid_order", `could not size the order: ${(e as Error).message}`);
      }
      if (lots <= 0) return reject("size_too_small", `size rounds to zero lots on ${market.symbol} (lot = 10^-${market.sizeDecimals})`);
      intent = {
        marketId: market.id,
        type: p.side === "long" ? OrderType.OpenLong : OrderType.OpenShort,
        size: lots,
        price: 0,
        flags: OrderFlag.ImmediateOrCancel,
        leverage: leverageToHundredths(p.leverage ?? this.o.defaultLeverage ?? 1),
        maxSlippageBps: slippage,
        lastExecBlock: 0,
        ...(this.o.accountId !== undefined ? { accountId: this.o.accountId } : {}),
        ...(p.rq !== undefined ? { rq: p.rq } : {}),
        ...(p.tag ? { tag: p.tag } : {}),
      };
    } else {
      await this.ensureSnapshots();
      const pos = [...this.positions.values()].find((x) => x.mkt === market.id && (x.sd === PositionType.Short ? "short" : "long") === p.side);
      if (!pos) return reject("no_position", `no open ${p.side} position on ${market.symbol} to close`);
      let lots = pos.s;
      if (p.sizeBase !== undefined || p.sizeUsd !== undefined) {
        try {
          const want = p.sizeBase !== undefined ? sizeToLots(p.sizeBase, market.sizeDecimals, "floor") : lotsForNotional(p.sizeUsd as number, await this.getMarkPrice(market.id), market.sizeDecimals, "floor");
          lots = Math.min(want, pos.s); // Close* orders are reduce-only and clamped to the position
        } catch (e) {
          return reject("invalid_order", `could not size the order: ${(e as Error).message}`);
        }
      }
      if (lots <= 0) return reject("size_too_small", `close size rounds to zero lots on ${market.symbol}`);
      intent = {
        marketId: market.id,
        type: p.side === "long" ? OrderType.CloseLong : OrderType.CloseShort,
        size: lots,
        price: 0,
        flags: OrderFlag.ImmediateOrCancel,
        leverage: 100,
        maxSlippageBps: slippage,
        lastExecBlock: 0,
        accountId: pos.acc,
        ...(p.rq !== undefined ? { rq: p.rq } : {}),
        ...(p.tag ? { tag: p.tag } : {}),
      };
    }

    const outcome = await this.tracker.placeOrder(intent, handlers);
    const result: PerplOrderResult = { ...outcome, ...base };
    if (p.kind === "close" && (outcome.status === "filled" || outcome.status === "partially_filled")) {
      result.realizedPnlUsd = await this.waitRealized(outcome.rq);
    }
    return result;
  }

  private async waitRealized(rq: number, timeoutMs = 1500): Promise<number | undefined> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = this.realizedByRq.get(rq);
      if (v !== undefined) return v;
      if (Date.now() >= end) return undefined;
      await sleep(25);
    }
  }

  /** Cancel a resting order. Resolves with the tracker outcome (`cancelled` on success). */
  async cancel(p: { market: string | number; orderId: number; handlers?: OrderLifecycleHandlers; tag?: string }): Promise<OrderOutcome> {
    if (!this.tracker) throw new PerplNotConnectedError();
    const market = this.requireMarket(p.market);
    return this.tracker.placeOrder(
      {
        marketId: market.id,
        type: OrderType.Cancel,
        size: 0,
        orderId: p.orderId,
        flags: OrderFlag.GoodTillCancel,
        leverage: 0,
        lastExecBlock: 0,
        ...(this.o.accountId !== undefined ? { accountId: this.o.accountId } : {}),
        ...(p.tag ? { tag: p.tag } : {}),
      },
      p.handlers ?? {},
    );
  }

  /** Open + untriggered orders over REST. */
  async getOpenOrders(): Promise<Order[]> {
    return (await this.rest.getOrders()).d.filter((o) => o.st !== OrderStatus.Failed && o.r !== true);
  }

  /** Account used for a market (instance match), exposed for diagnostics. */
  accountForMarket(market: string | number): Account | undefined {
    return selectAccountForMarket([...this.accounts.values()], this.requireMarket(market));
  }
}
