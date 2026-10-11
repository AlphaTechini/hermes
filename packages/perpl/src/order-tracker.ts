/**
 * Order tracker: the rq / retry state machine of docs/research/perpl.md section 5.9, EXACTLY.
 *
 * Rules implemented
 *  - `rq` per account is seeded from the account `lfr` and strictly increasing: `rq = max(counter, lfr) + 1`. Every
 *    advance calls `onRqAdvance(rq, accountId)` BEFORE the frame is sent so the server can persist it (a restart can
 *    then never reuse an rq). Sends are serialised so frames reach Perpl in rq order.
 *  - Each frame carries a unique non-zero `sn`; mt:3 is matched by `cid === sn`; mt:24 by `rq` (fills by `oid`).
 *  - Retry with the SAME rq only: before any status for it AND before its last execution block (`lb`) expired. This is
 *    at-most-once safe, so it is done freely: after an ack timeout and after every reconnect.
 *  - Retry with a NEW rq only when: (a) a failure status was received for the original (mt:3 non-zero retryable
 *    codes 429/503, or mt:24 st 7 with sr 32 OrderDescIdTooLow, once), or (b) head >= lb with no status AND no
 *    reconnect since posting. After a reconnect the outcome is ambiguous: we reconcile through REST
 *    (`reconcile(rq)`) and only issue a new rq if Perpl provably has no record of the old one; without a reconcile
 *    hook the outcome is reported as `timeout` (ambiguous) and NEVER retried.
 *  - Dedupe per rq: the first non-failure mt:24 is definitive (later failures are ignored); with only failures the
 *    first one wins; late failures of a retired rq are ignored, late non-failures of a retired rq raise a warning.
 *  - `lb: 0` is sent by default (perpl.md 0.5). The effective window is then `sentHead + order_ttl_blocks`, plus a
 *    safety margin, since the server substitutes the window from ITS head.
 *  - Socket close 1011 with an order in flight and no status: the order is re-sent once (same rq, safe); a second
 *    1011 for the same order fails it as `socket_closed_1011`.
 *
 * Lifecycle callbacks per order: sent, accepted (mt:3 ok / mt:24 non-failure), partially_filled / filled (mt:25),
 * failed, timeout. `placeOrder()` additionally resolves with an {@link OrderOutcome}.
 */
import {
  OrderFlag,
  OrderStatus,
  OrderType,
  buildOrderRequest,
  describeOrderStatus,
  describeStatusCode,
  isNonFailureOrder,
  validateOrderSpec,
  type Account,
  type Fill,
  type Order,
  type OrderSpec,
  type StatusResponseFrame,
} from "./protocol";
import { cnsToAusd, fromScaled, type MarketSpec } from "./scaling";
import { NotConnectedError, RateLimitedError, type OrderSocket } from "./trading-ws";
import { deferred, noopLogger, type Deferred, type Logger } from "./util";

// ---------------------------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------------------------

/** A wire-level order request (scaled integers). Higher layers (client.ts) convert human units into this. */
export interface OrderIntent {
  marketId: number;
  /** {@link OrderType}. */
  type: number;
  /** Size in lots (scaled by size_decimals). 0 only for cancels. */
  size: number;
  /** Limit price, scaled. 0/undefined = market. */
  price?: number | undefined;
  /** Flags. Default: IOC (4) for market orders, GTC (0) otherwise. */
  flags?: number | undefined;
  /** Leverage in hundredths (`lv`). */
  leverage: number;
  maxSlippageBps?: number | undefined;
  /** `oid` for cancel / change. */
  orderId?: number | undefined;
  /** `a`: collateral amount (type 6). */
  amount?: string | undefined;
  /** `mnp`; omit for the market default. */
  maxNegPnlBps?: number | undefined;
  tif?: number | undefined;
  /** Explicit `lb`. Default 0. */
  lastExecBlock?: number | undefined;
  /** `lp`. */
  linkedPosition?: number | undefined;
  /** Override account selection (otherwise: the account whose `in` equals the market's `instance_id`). */
  accountId?: number | undefined;
  /**
   * Caller-supplied rq. If an in-flight order already uses it, that order is re-sent with the SAME rq (idempotent
   * retry). Otherwise the rq is used as-is (and must be > lfr).
   */
  rq?: number | undefined;
  /** Free-form tag echoed in callbacks (for example an alert id). */
  tag?: string | undefined;
}

interface Base {
  rq: number;
  atMs: number;
  tag?: string | undefined;
}
export interface SentInfo extends Base {
  sn: number;
  accountId: number;
  marketId: number;
  /** `initial` first send of this rq; `resend` same rq again; `new_rq` a retry with a fresh rq. */
  kind: "initial" | "resend" | "new_rq";
  /** 1-based number of rq attempts. */
  attempt: number;
  lb: number;
  /** Head block when sent (undefined if no heartbeat yet). */
  head: number | undefined;
}
export interface AcceptedInfo extends Base {
  /** `status`: mt:3 code 0 (forwarded). `order`: first non-failure mt:24. */
  source: "status" | "order";
  orderId?: number | undefined;
}
export interface FillInfo extends Base {
  orderId: number;
  /** Human price. */
  price: number;
  /** Human base size. */
  size: number;
  /** Fee in AUSD (negative = rebate). */
  fee: number;
  feeCns: string;
  txHash?: string | undefined;
  block?: number | undefined;
  liquidity?: "maker" | "taker" | undefined;
  /** Human size filled so far, including this fill. */
  cumulativeSize: number;
  requestedSize: number;
  /** Built from the aggregate mt:24 because no mt:25 arrived for it. */
  synthetic?: boolean | undefined;
}
export interface FailureInfo extends Base {
  /** Where it was detected. */
  source: "status" | "order" | "socket" | "validation" | "rate_limit" | "unfilled" | "reconcile";
  /** Stable machine code: `400`, `403`, `sr:34`, `forwarding_disabled`, `socket_closed_1011`, `unfilled`, ... */
  code: string;
  st?: number | undefined;
  sr?: number | undefined;
  fr?: number | undefined;
  /** mt:3 status code. */
  httpCode?: number | undefined;
  /** Readable. */
  message: string;
}
export interface TimeoutInfo extends Base {
  reason: string;
  /** True when the order may still have executed (a reconnect happened). Reconcile through REST. */
  ambiguous: boolean;
}
export interface RetryInfo extends Base {
  oldRq: number;
  reason: string;
}

export interface OrderLifecycleHandlers {
  sent?(e: SentInfo): void;
  /**
   * mt:3 code 0 (`source: "status"`, forwarded) and then again on the first non-failure mt:24 (`source: "order"`, carries
   * `orderId`). Either may be skipped if its frame was lost.
   */
  accepted?(e: AcceptedInfo): void;
  partially_filled?(e: FillInfo): void;
  filled?(e: FillInfo): void;
  failed?(e: FailureInfo): void;
  timeout?(e: TimeoutInfo): void;
  retry?(e: RetryInfo): void;
  /** Every raw mt:24 message matched to this order (after de-duplication rules), for status mirroring. */
  order?(o: Order, e: Base): void;
}

export type OutcomeStatus = "filled" | "partially_filled" | "open" | "cancelled" | "expired" | "failed" | "timeout";

export interface OrderOutcome {
  status: OutcomeStatus;
  marketId: number;
  accountId: number;
  /** The rq of the final attempt. */
  rq: number;
  /** Every rq used (first = original). */
  rqs: number[];
  /** `sn` of the last frame sent. */
  sn: number;
  attempts: number;
  /** Number of frames sent in total (resends included). */
  sends: number;
  orderId?: number | undefined;
  /** Human sizes. */
  requestedSize: number;
  filledSize: number;
  avgPrice?: number | undefined;
  /** AUSD, summed over fills. */
  feeUsd: number;
  fills: FillInfo[];
  txHashes: string[];
  failure?: FailureInfo | undefined;
  timeout?: TimeoutInfo | undefined;
  /** True if the order may have executed although the status is `timeout`/`failed`. */
  ambiguous: boolean;
  tag?: string | undefined;
  startedAtMs: number;
  sentAtMs?: number | undefined;
  acceptedAtMs?: number | undefined;
  firstFillAtMs?: number | undefined;
  doneAtMs: number;
}

export interface OrderTrackerOptions {
  socket: OrderSocket;
  getMarket(marketId: number): MarketSpec | undefined;
  /** Persist hook: called with every new rq BEFORE it is sent. */
  onRqAdvance?: ((rq: number, accountId: number) => void | Promise<void>) | undefined;
  /** Persisted high-water mark(s) to seed from: a single number (applies to every account) or a map. */
  initialRq?: number | Record<number, number> | undefined;
  /**
   * REST reconciliation by rq (open orders + order history). Return the matching messages (possibly empty = Perpl has no
   * record of the rq), or null/throw when it cannot be determined.
   */
  reconcile?: ((rq: number, accountId: number) => Promise<Order[] | null>) | undefined;
  /** Refresh accounts over REST (used to re-read `lfr` after OrderDescIdTooLow). */
  refreshAccounts?: (() => Promise<Account[]>) | undefined;
  /** Receives anomalies (a retired rq executed, orphan statuses). */
  onWarning?: ((code: string, detail: Record<string, unknown>) => void) | undefined;
  logger?: Logger | undefined;
  now?: (() => number) | undefined;

  /** Re-send the same rq if no mt:3 within this many ms. Default 2500. */
  ackTimeoutMs?: number;
  /** Max same-rq re-sends per rq (reconnect re-sends do not count). Default 4. */
  maxResends?: number;
  /** Max rq attempts per order (initial + new-rq retries). Default 3. */
  maxAttempts?: number;
  /** Blocks added to `sentHead + order_ttl_blocks` before an rq is declared expired. Default 5. */
  expiryMarginBlocks?: number;
  /** Wall-clock block time estimate, used only when no heartbeats arrive. Default 500. */
  blockTimeMs?: number;
  /** Overall deadline per order. Default 45000. */
  maxWaitMs?: number;
  /** After a terminal mt:24, how long to wait for the matching mt:25 fills before synthesising one. Default 1500. */
  fillGraceMs?: number;
  /** After a partial fill on an IOC/FOK order with no terminal status, settle after this long. Default 3000. */
  iocSettleMs?: number;
  /** How long placeOrder waits for a ready socket before failing. Default 10000. */
  connectWaitMs?: number;
  /** Tracker housekeeping interval. Default 250. */
  tickMs?: number;
  /** Retry with a new rq when the rq expired without any status and without reconnect. Default true. */
  retryOnExpiry?: boolean;
  /** Refuse to send while the account reports `fw: false`. Default true. */
  checkForwarding?: boolean;
  /** Back-off before a new-rq retry after a retryable failure. Default 300. */
  retryBackoffMs?: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// Account selection
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Pick the account for a market: the one whose instance (`in`) equals the market's `instance_id` (perpl.md 0.6), NOT
 * blindly `as[0]`. Returns undefined when the wallet has no account on that instance (sending anyway would close the
 * socket with 1011).
 */
export function selectAccountForMarket(accounts: readonly Account[], market: Pick<MarketSpec, "instanceId">): Account | undefined {
  return accounts.find((a) => a.in === market.instanceId);
}

// ---------------------------------------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------------------------------------

type Phase = "queued" | "awaiting" | "open" | "reconciling" | "retry_wait" | "done";

interface Rec {
  id: number;
  intent: OrderIntent;
  market: MarketSpec;
  accountId: number;
  handlers: OrderLifecycleHandlers;
  outcome: Deferred<OrderOutcome>;
  settled: boolean;
  closed: boolean;
  phase: Phase;
  rq: number;
  rqs: number[];
  lastSn: number;
  attempts: number;
  sends: number;
  resendsThisRq: number;
  ackOk: boolean;
  definitive: boolean;
  acceptedFired: boolean;
  /** `accepted` was fired from the order stream (carries the exchange order id). */
  acceptedFromOrder: boolean;
  /** A reconnect happened after the rq was first posted. */
  ambiguous: boolean;
  closes1011: number;
  sr32Retried: boolean;
  firstFailure: Order | undefined;
  orderId: number | undefined;
  lastOrder: Order | undefined;
  terminalOrder: Order | undefined;
  fills: FillInfo[];
  fillKeys: Set<string>;
  cumulativeLots: number;
  filledFired: boolean;
  startedAt: number;
  sentAt: number | undefined;
  lastSendAt: number;
  acceptedAt: number | undefined;
  firstFillAt: number | undefined;
  sentHead: number | undefined;
  expiryBlock: number | undefined;
  expiryWallMs: number | undefined;
  deadline: number;
  graceUntil: number | undefined;
  iocSettleAt: number | undefined;
  retryAt: number | undefined;
  pendingRetryReason: string | undefined;
  closedAt: number | undefined;
  requestedLots: number;
  timers: Set<ReturnType<typeof setTimeout>>;
}

const RESTING_FLAGS_MASK = OrderFlag.ImmediateOrCancel | OrderFlag.FillOrKill;

function isImmediate(intent: OrderIntent): boolean {
  const fl = intent.flags ?? ((intent.price ?? 0) === 0 ? OrderFlag.ImmediateOrCancel : OrderFlag.GoodTillCancel);
  return (fl & RESTING_FLAGS_MASK) !== 0 || (intent.price ?? 0) === 0;
}

export class OrderTracker {
  private readonly o: Required<Pick<OrderTrackerOptions, "ackTimeoutMs" | "maxResends" | "maxAttempts" | "expiryMarginBlocks" | "blockTimeMs" | "maxWaitMs" | "fillGraceMs" | "iocSettleMs" | "connectWaitMs" | "tickMs" | "retryOnExpiry" | "checkForwarding" | "retryBackoffMs">>;
  private readonly socket: OrderSocket;
  private readonly getMarket: OrderTrackerOptions["getMarket"];
  private readonly onRqAdvance: OrderTrackerOptions["onRqAdvance"];
  private readonly reconcileFn: OrderTrackerOptions["reconcile"];
  private readonly refreshAccounts: OrderTrackerOptions["refreshAccounts"];
  private readonly onWarning: OrderTrackerOptions["onWarning"];
  private readonly log: Logger;
  private readonly now: () => number;

  private readonly accounts = new Map<number, Account>();
  private readonly counters = new Map<number, number>();
  private seedAll = 0;
  private readonly recs = new Set<Rec>();
  private readonly bySn = new Map<number, { rec: Rec; rq: number }>();
  private readonly byRq = new Map<number, Rec>();
  /** Old rq -> the rq that replaced it (bounded). */
  private readonly retired = new Map<number, number>();
  private readonly byOid = new Map<string, Rec>();
  private readonly orphanFills = new Map<string, { fills: Fill[]; at: number }>();
  private queue: Promise<void> = Promise.resolve();
  private nextId = 1;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private readonly offs: Array<() => void> = [];
  private disposed = false;
  private readyWaiters: Array<() => void> = [];

  constructor(opts: OrderTrackerOptions) {
    this.socket = opts.socket;
    this.getMarket = opts.getMarket;
    this.onRqAdvance = opts.onRqAdvance;
    this.reconcileFn = opts.reconcile;
    this.refreshAccounts = opts.refreshAccounts;
    this.onWarning = opts.onWarning;
    this.log = opts.logger ?? noopLogger;
    this.now = opts.now ?? Date.now;
    this.o = {
      ackTimeoutMs: opts.ackTimeoutMs ?? 2500,
      maxResends: opts.maxResends ?? 4,
      maxAttempts: opts.maxAttempts ?? 3,
      expiryMarginBlocks: opts.expiryMarginBlocks ?? 5,
      blockTimeMs: opts.blockTimeMs ?? 500,
      maxWaitMs: opts.maxWaitMs ?? 45_000,
      fillGraceMs: opts.fillGraceMs ?? 1500,
      iocSettleMs: opts.iocSettleMs ?? 3000,
      connectWaitMs: opts.connectWaitMs ?? 10_000,
      tickMs: opts.tickMs ?? 250,
      retryOnExpiry: opts.retryOnExpiry ?? true,
      checkForwarding: opts.checkForwarding ?? true,
      retryBackoffMs: opts.retryBackoffMs ?? 300,
    };
    if (typeof opts.initialRq === "number") this.seedAll = opts.initialRq;
    else if (opts.initialRq) for (const [id, rq] of Object.entries(opts.initialRq)) this.counters.set(Number(id), rq);

    const s = this.socket;
    this.offs.push(
      s.on("walletSnapshot", (w) => this.setAccounts(w.as)),
      s.on("account", (a) => this.setAccounts([a])),
      s.on("status", (st) => this.onStatus(st)),
      s.on("orders", ({ frame }) => this.onOrders(frame.d)),
      s.on("fills", (f) => this.onFills(f.d)),
      s.on("heartbeat", () => this.tick()),
      s.on("disconnected", (d) => this.onDisconnected(d.code)),
      s.on("connected", () => {
        this.wakeReadyWaiters();
        this.onConnected();
      }),
    );
  }

  /** Stop listening. Orders still in flight are settled: `timeout` (ambiguous) if sent, `failed` if never sent. */
  dispose(): void {
    if (this.disposed) return;
    for (const rec of [...this.recs]) {
      if (rec.closed) continue;
      if (rec.settled) this.closeRec(rec);
      else if (rec.sends > 0) this.timeoutRec(rec, "the client was closed while the order was in flight; reconcile through REST", true);
      else this.failRec(rec, { source: "socket", code: "client_closed", message: "the client was closed before the order was sent" });
    }
    this.disposed = true;
    for (const off of this.offs) off();
    this.offs.length = 0;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = undefined;
  }

  // ---- accounts and rq --------------------------------------------------------------------------------------------

  setAccounts(accounts: readonly Account[]): void {
    for (const a of accounts) this.accounts.set(a.id, a);
  }
  getAccount(id: number): Account | undefined {
    return this.accounts.get(id);
  }
  /** Raise the persisted rq high-water mark for an account (never lowers). */
  seedRq(accountId: number, rq: number): void {
    this.counters.set(accountId, Math.max(this.counters.get(accountId) ?? 0, rq));
  }
  /** The last rq handed out for an account (0 if none). */
  lastRq(accountId: number): number {
    return Math.max(this.counters.get(accountId) ?? 0, this.seedAll);
  }
  /**
   * Resolve a failed outcome without sending anything (client-side validation such as "size rounds to zero"). Fires the
   * `failed` handler like any other failure.
   */
  reject(intent: OrderIntent, handlers: OrderLifecycleHandlers, code: string, message: string): Promise<OrderOutcome> {
    const market = this.getMarket(intent.marketId) ?? ({ id: intent.marketId, sizeDecimals: 0, priceDecimals: 0, symbol: String(intent.marketId) } as MarketSpec);
    const rec = this.newRec(intent, market, intent.accountId ?? 0, handlers, this.now());
    return this.failEarly(rec, "validation", code, message);
  }

  /** Orders that are still being tracked. */
  activeCount(): number {
    let n = 0;
    for (const r of this.recs) if (!r.closed) n++;
    return n;
  }

  private async allocateRq(accountId: number): Promise<number> {
    const lfr = this.accounts.get(accountId)?.lfr ?? 0;
    const counter = Math.max(this.counters.get(accountId) ?? 0, this.seedAll, lfr);
    const rq = counter + 1;
    this.counters.set(accountId, rq);
    if (this.onRqAdvance) await this.onRqAdvance(rq, accountId);
    return rq;
  }

  // ---- public API -------------------------------------------------------------------------------------------------

  /**
   * Place an order and follow it to a terminal state. Never rejects for business failures: those resolve as an
   * outcome with status `failed` / `timeout` and fire the matching callback.
   */
  placeOrder(intent: OrderIntent, handlers: OrderLifecycleHandlers = {}): Promise<OrderOutcome> {
    if (this.disposed) return Promise.reject(new Error("order tracker disposed"));
    // idempotent re-submission of a known rq
    if (intent.rq !== undefined) {
      const existing = this.byRq.get(intent.rq);
      if (existing && !existing.closed && existing.intent.marketId === intent.marketId) {
        this.log.info("re-sending in-flight rq", { rq: intent.rq });
        void this.dispatch(existing, "resend");
        return existing.outcome.promise;
      }
    }
    const t0 = this.now();
    const market = this.getMarket(intent.marketId);
    const mk = (accountId: number): Rec => this.newRec(intent, market ?? ({ id: intent.marketId, sizeDecimals: 0, priceDecimals: 0, symbol: String(intent.marketId) } as MarketSpec), accountId, handlers, t0);

    if (!market) return this.failEarly(mk(intent.accountId ?? 0), "validation", "unknown_market", `unknown market ${intent.marketId}: Perpl would close the socket (1011), refusing to send`);

    const account = intent.accountId !== undefined ? this.accounts.get(intent.accountId) : selectAccountForMarket([...this.accounts.values()], market);
    if (!account) {
      return this.failEarly(mk(intent.accountId ?? 0), "validation", "no_account", `no Perpl account for instance ${market.instanceId} (market ${market.symbol}); create the exchange account first`);
    }
    const rec = mk(account.id);
    if (this.o.checkForwarding && account.fw === false) {
      return this.failEarly(rec, "validation", "forwarding_disabled", "order forwarding is off for this account (sr 34); call allowOrderForwarding(true) from the wallet first");
    }
    if (account.fr) return this.failEarly(rec, "validation", "account_frozen", "the Perpl account is frozen");

    const problems = validateOrderSpec(this.specFor(rec, 1), { maxLeverageHdths: market.maxLeverageHdths, maxSlippageBps: market.maxSlippageBps, isOpen: market.isOpen });
    if (problems.length) return this.failEarly(rec, "validation", "invalid_order", problems.join("; "));

    this.recs.add(rec);
    this.ensureTick();
    void this.start(rec);
    return rec.outcome.promise;
  }

  /** Orders still tracked (open/resting or awaiting a terminal state). */
  active(): Array<{ rq: number; marketId: number; accountId: number; orderId?: number; tag?: string }> {
    return [...this.recs]
      .filter((r) => !r.closed)
      .map((r) => ({ rq: r.rq, marketId: r.intent.marketId, accountId: r.accountId, ...(r.orderId !== undefined ? { orderId: r.orderId } : {}), ...(r.intent.tag ? { tag: r.intent.tag } : {}) }));
  }

  private newRec(intent: OrderIntent, market: MarketSpec, accountId: number, handlers: OrderLifecycleHandlers, t0: number): Rec {
    const rec: Rec = {
      id: this.nextId++,
      intent,
      market,
      accountId,
      handlers,
      outcome: deferred<OrderOutcome>(),
      settled: false,
      closed: false,
      phase: "queued",
      rq: 0,
      rqs: [],
      lastSn: 0,
      attempts: 0,
      sends: 0,
      resendsThisRq: 0,
      ackOk: false,
      definitive: false,
      acceptedFired: false,
      acceptedFromOrder: false,
      ambiguous: false,
      closes1011: 0,
      sr32Retried: false,
      firstFailure: undefined,
      orderId: undefined,
      lastOrder: undefined,
      terminalOrder: undefined,
      fills: [],
      fillKeys: new Set(),
      cumulativeLots: 0,
      filledFired: false,
      startedAt: t0,
      sentAt: undefined,
      lastSendAt: 0,
      acceptedAt: undefined,
      firstFillAt: undefined,
      sentHead: undefined,
      expiryBlock: undefined,
      expiryWallMs: undefined,
      deadline: t0 + this.o.maxWaitMs,
      graceUntil: undefined,
      iocSettleAt: undefined,
      retryAt: undefined,
      pendingRetryReason: undefined,
      closedAt: undefined,
      requestedLots: intent.size,
      timers: new Set(),
    };
    return rec;
  }

  // ---- sending ----------------------------------------------------------------------------------------------------

  private specFor(rec: Rec, rq: number): OrderSpec {
    const i = rec.intent;
    const isCancel = i.type === OrderType.Cancel;
    const flags = i.flags ?? (isCancel ? OrderFlag.GoodTillCancel : (i.price ?? 0) === 0 ? OrderFlag.ImmediateOrCancel : OrderFlag.GoodTillCancel);
    return {
      rq,
      mkt: i.marketId,
      acc: rec.accountId,
      ...(i.orderId !== undefined ? { oid: i.orderId } : {}),
      t: i.type,
      ...(isCancel ? {} : { p: i.price ?? 0 }),
      s: isCancel ? 0 : i.size,
      ...(i.amount !== undefined ? { a: i.amount } : {}),
      ...(i.maxSlippageBps !== undefined && !isCancel ? { ms: i.maxSlippageBps } : {}),
      ...(i.maxNegPnlBps !== undefined ? { mnp: i.maxNegPnlBps } : {}),
      ...(i.tif !== undefined ? { tif: i.tif } : {}),
      fl: flags,
      ...(i.linkedPosition !== undefined ? { lp: i.linkedPosition } : {}),
      lv: i.leverage,
      lb: i.lastExecBlock ?? 0,
    };
  }

  private async start(rec: Rec): Promise<void> {
    if (!this.socket.isReady()) {
      const ok = await this.waitReady(this.o.connectWaitMs);
      if (!ok) {
        this.failRec(rec, { source: "socket", code: "not_connected", message: "not connected to Perpl; the order was not sent" });
        return;
      }
    }
    await this.dispatch(rec, "initial");
  }

  private waitReady(ms: number): Promise<boolean> {
    if (this.socket.isReady()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== done);
        resolve(false);
      }, ms);
      const done = (): void => {
        clearTimeout(t);
        resolve(true);
      };
      this.readyWaiters.push(done);
    });
  }

  private wakeReadyWaiters(): void {
    const w = this.readyWaiters;
    this.readyWaiters = [];
    for (const fn of w) fn();
  }

  /** Serialised so rq allocation and writes happen in the same order. */
  private dispatch(rec: Rec, kind: "initial" | "resend" | "new_rq"): Promise<void> {
    const run = async (): Promise<void> => {
      if (rec.closed) return;
      let rq = rec.rq;
      if (kind === "initial" || kind === "new_rq") {
        if (kind === "initial" && rec.intent.rq !== undefined) {
          rq = rec.intent.rq;
          this.seedRq(rec.accountId, rq);
          if (this.onRqAdvance) await this.onRqAdvance(rq, rec.accountId);
        } else {
          rq = await this.allocateRq(rec.accountId);
        }
        rec.rq = rq;
        rec.rqs.push(rq);
        rec.attempts++;
        rec.resendsThisRq = 0;
        rec.ackOk = false;
        rec.definitive = false;
        rec.firstFailure = undefined;
        rec.ambiguous = false;
        rec.closes1011 = 0;
        this.byRq.set(rq, rec);
      } else {
        rec.resendsThisRq++;
      }
      rec.phase = "awaiting";
      const sn = this.socket.nextSn();
      this.bySn.set(sn, { rec, rq });
      rec.lastSn = sn;
      const frame = buildOrderRequest(this.specFor(rec, rq), sn);
      try {
        await this.socket.send(frame);
      } catch (e) {
        this.bySn.delete(sn);
        if (e instanceof NotConnectedError) {
          // the close handler / reconnect will re-send this same rq; nothing reached the wire
          if (kind === "new_rq" || kind === "initial") rec.phase = "awaiting";
          rec.lastSendAt = this.now() - this.o.ackTimeoutMs; // eligible for re-send as soon as we are back
          return;
        }
        if (e instanceof RateLimitedError && rec.sends === 0) {
          this.failRec(rec, { source: "rate_limit", code: "rate_limited", message: `Perpl request budget exhausted (60/min); retry in ${e.retryAfterMs} ms` });
          return;
        }
        this.log.warn("send failed", { rq, error: (e as Error).message });
        rec.lastSendAt = this.now() - this.o.ackTimeoutMs + 500;
        return;
      }
      const t = this.now();
      rec.sends++;
      rec.lastSendAt = t;
      if (rec.sentAt === undefined) rec.sentAt = t;
      const head = this.socket.head;
      rec.sentHead = head;
      const lbExplicit = rec.intent.lastExecBlock ?? 0;
      const ttl = rec.market.orderTtlBlocks || 20;
      if (lbExplicit > 0) rec.expiryBlock = lbExplicit;
      else rec.expiryBlock = head !== undefined ? head + ttl + this.o.expiryMarginBlocks : undefined;
      rec.expiryWallMs = t + (ttl + this.o.expiryMarginBlocks) * this.o.blockTimeMs + 2000;
      this.safe(() =>
        rec.handlers.sent?.({
          rq,
          sn,
          accountId: rec.accountId,
          marketId: rec.intent.marketId,
          kind,
          attempt: rec.attempts,
          lb: rec.intent.lastExecBlock ?? 0,
          head,
          atMs: t,
          tag: rec.intent.tag,
        }),
      );
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p.catch((e) => {
      this.log.error("dispatch failed", { error: (e as Error).message });
      this.failRec(rec, { source: "socket", code: "send_error", message: `could not send the order: ${(e as Error).message}` });
    });
  }

  // ---- mt:3 -------------------------------------------------------------------------------------------------------

  private onStatus(s: StatusResponseFrame): void {
    if (s.cid === undefined) return;
    const link = this.bySn.get(s.cid);
    if (!link) return;
    const { rec, rq } = link;
    if (rec.closed) return;
    const t = this.now();
    if (rq !== rec.rq) {
      // status of a superseded attempt: failures are ignored, nothing to do for acks
      return;
    }
    const code = s.status.code;
    if (code === 0) {
      rec.ackOk = true;
      if (!rec.acceptedFired) {
        rec.acceptedFired = true;
        rec.acceptedAt = t;
        this.safe(() => rec.handlers.accepted?.({ rq, source: "status", atMs: t, tag: rec.intent.tag }));
      }
      return;
    }
    // non-zero: rejected at the gateway, NO mt:24 will follow
    if (rec.definitive) return;
    const retryable = code === 429 || code === 503;
    if (retryable && rec.attempts < this.o.maxAttempts) {
      this.scheduleRetry(rec, `mt:3 ${describeStatusCode(code, s.status.error)}`);
      return;
    }
    this.failRec(rec, { source: "status", code: String(code), httpCode: code, message: describeStatusCode(code, s.status.error) });
  }

  // ---- mt:24 ------------------------------------------------------------------------------------------------------

  private onOrders(orders: readonly Order[]): void {
    for (const o of orders) this.onOrder(o);
  }

  private onOrder(o: Order): void {
    // cancels: match by target oid, the answer may carry the original order's rq
    if (o.oid > 0 && (o.st === OrderStatus.Canceled || o.st === OrderStatus.Expired || o.st === OrderStatus.Filled || o.st === OrderStatus.Executed || o.r === true)) {
      for (const r of this.recs) {
        if (!r.closed && r.intent.type === OrderType.Cancel && r.intent.orderId === o.oid && r.accountId === (o.acc || r.accountId) && r.rq !== o.rq) {
          this.handleCancelAnswer(r, o);
        }
      }
    }
    const rec = this.byRq.get(o.rq);
    if (!rec) {
      const current = this.retired.get(o.rq);
      if (current !== undefined) this.onRetiredRqOrder(current, o);
      return;
    }
    if (o.acc && o.acc !== rec.accountId) return;
    if (rec.closed) return;
    if (rec.rq !== o.rq) {
      this.onRetiredRqOrder(rec.rq, o);
      return;
    }
    this.applyOrder(rec, o);
  }

  private onRetiredRqOrder(currentRq: number, o: Order): void {
    if (o.st === OrderStatus.Failed) return; // late failure of a retried rq: ignore
    if (isNonFailureOrder(o)) {
      this.onWarning?.("retired_rq_became_active", { rq: o.rq, currentRq, st: o.st, oid: o.oid });
      this.log.warn("a retired rq reported a non-failure status; possible duplicate exposure", { rq: o.rq, currentRq, st: o.st });
    }
  }

  private retire(oldRq: number, currentRq: number): void {
    this.retired.set(oldRq, currentRq);
    if (this.retired.size > 5000) {
      const first = this.retired.keys().next();
      if (!first.done) this.retired.delete(first.value);
    }
  }

  private handleCancelAnswer(rec: Rec, o: Order): void {
    const t = this.now();
    this.safe(() => rec.handlers.order?.(o, { rq: rec.rq, atMs: t, tag: rec.intent.tag }));
    this.settleWith(rec, "cancelled", undefined);
    this.closeRec(rec);
  }

  /** Apply one mt:24 / snapshot entry to the order that owns its rq. */
  private applyOrder(rec: Rec, o: Order): void {
    const t = this.now();
    if (o.oid > 0) {
      rec.orderId = o.oid;
      this.byOid.set(`${rec.accountId}:${o.oid}`, rec);
      const buffered = this.orphanFills.get(`${rec.accountId}:${o.oid}`);
      if (buffered) {
        this.orphanFills.delete(`${rec.accountId}:${o.oid}`);
        this.onFills(buffered.fills);
      }
    }

    if (o.st === OrderStatus.Failed) {
      if (rec.definitive) {
        // a non-failure was already definitive, later failures are ignored (dedupe rule), except the real terminal
        // event of a resting order: its maker settlement failing removes it from the book
        if (rec.settled && o.sr === 23 && !rec.terminalOrder) {
          this.safe(() => rec.handlers.order?.(o, { rq: rec.rq, atMs: t, tag: rec.intent.tag }));
          this.failRec(rec, { source: "order", code: `sr:${o.sr}`, st: o.st, sr: o.sr, ...(o.fr ? { fr: o.fr } : {}), message: describeOrderStatus(o) });
        }
        return;
      }
      rec.firstFailure ??= o;
      if (rec.firstFailure !== o) return; // only the first failure is processed
      this.safe(() => rec.handlers.order?.(o, { rq: rec.rq, atMs: t, tag: rec.intent.tag }));
      if (o.sr === 32 && !rec.sr32Retried && rec.attempts < this.o.maxAttempts) {
        rec.sr32Retried = true;
        this.scheduleRetry(rec, "mt:24 sr 32 OrderDescIdTooLow", true);
        return;
      }
      const msg = describeOrderStatus(o);
      this.failRec(rec, { source: "order", code: `sr:${o.sr}`, st: o.st, sr: o.sr, ...(o.fr ? { fr: o.fr } : {}), message: msg });
      return;
    }

    if (!isNonFailureOrder(o) && o.r !== true) return; // Unspecified / Pending: nothing definitive yet

    rec.definitive = true;
    rec.lastOrder = o;
    rec.phase = "open";
    this.safe(() => rec.handlers.order?.(o, { rq: rec.rq, atMs: t, tag: rec.intent.tag }));
    if (!rec.acceptedFromOrder) {
      // fires a second time after the mt:3 ack so that callers learn the exchange order id
      rec.acceptedFromOrder = true;
      rec.acceptedFired = true;
      rec.acceptedAt ??= t;
      this.safe(() => rec.handlers.accepted?.({ rq: rec.rq, source: "order", orderId: o.oid || undefined, atMs: t, tag: rec.intent.tag }));
    }

    const terminal = o.st === OrderStatus.Filled || o.st === OrderStatus.Executed || o.st === OrderStatus.Canceled || o.st === OrderStatus.Expired || o.r === true;
    if (terminal) {
      rec.terminalOrder = o;
      rec.iocSettleAt = undefined;
      this.evaluateTerminal(rec, false);
      return;
    }

    if (o.st === OrderStatus.PartiallyFilled && isImmediate(rec.intent)) {
      if (rec.iocSettleAt === undefined) {
        rec.iocSettleAt = t + this.o.iocSettleMs;
        this.after(rec, this.o.iocSettleMs, () => this.settleIoc(rec));
      }
      return;
    }
    if (o.st === OrderStatus.Open || o.st === OrderStatus.Untriggered || o.st === OrderStatus.Triggered || o.st === OrderStatus.PartiallyFilled) {
      if (!isImmediate(rec.intent) && rec.intent.type !== OrderType.Cancel) {
        // resting order: the call returns now, fills keep streaming through the handlers
        this.settleWith(rec, "open", undefined);
      }
    }
  }

  // ---- mt:25 ------------------------------------------------------------------------------------------------------

  private onFills(fills: readonly Fill[]): void {
    for (const f of fills) {
      const key = `${f.acc}:${f.oid}`;
      const rec = this.byOid.get(key);
      if (!rec) {
        const buf = this.orphanFills.get(key) ?? { fills: [], at: this.now() };
        buf.fills.push(f);
        this.orphanFills.set(key, buf);
        continue;
      }
      if (rec.closed) continue;
      const fk = `${f.oid}|${f.at.txid ?? ""}|${f.at.b ?? ""}|${f.at.tx ?? ""}|${f.at.l ?? ""}|${f.s}|${f.p ?? ""}`;
      if (rec.fillKeys.has(fk)) continue;
      rec.fillKeys.add(fk);
      this.recordFill(rec, f);
    }
    for (const rec of this.recs) if (rec.terminalOrder && !rec.closed) this.evaluateTerminal(rec, false);
  }

  private recordFill(rec: Rec, f: Fill, synthetic = false): FillInfo {
    const m = rec.market;
    const t = this.now();
    rec.cumulativeLots += f.s;
    const info: FillInfo = {
      rq: rec.rq,
      orderId: f.oid,
      price: f.p !== undefined ? fromScaled(f.p, m.priceDecimals) : 0,
      size: fromScaled(f.s, m.sizeDecimals),
      fee: cnsToAusd(f.f),
      feeCns: f.f,
      ...(f.at.txid ? { txHash: f.at.txid } : {}),
      ...(f.at.b !== undefined ? { block: f.at.b } : {}),
      ...(f.l === 1 ? { liquidity: "maker" as const } : f.l === 2 ? { liquidity: "taker" as const } : {}),
      cumulativeSize: fromScaled(rec.cumulativeLots, m.sizeDecimals),
      requestedSize: fromScaled(rec.requestedLots, m.sizeDecimals),
      ...(synthetic ? { synthetic: true } : {}),
      atMs: f.at.t ?? t,
      tag: rec.intent.tag,
    };
    rec.fills.push(info);
    rec.firstFillAt ??= t;
    if (rec.cumulativeLots >= rec.requestedLots && rec.intent.type !== OrderType.Cancel) {
      rec.filledFired = true;
      this.safe(() => rec.handlers.filled?.(info));
    } else {
      this.safe(() => rec.handlers.partially_filled?.(info));
    }
    return info;
  }

  // ---- terminal handling ------------------------------------------------------------------------------------------

  /** Called whenever the terminal mt:24 or new fills arrived, and from the tick when the fill grace ran out. */
  private evaluateTerminal(rec: Rec, graceExpired: boolean): void {
    const o = rec.terminalOrder;
    if (!o || rec.closed) return;
    const t = this.now();
    const fillsComplete = rec.cumulativeLots >= o.fs;
    if (!fillsComplete && !graceExpired) {
      if (rec.graceUntil === undefined) {
        rec.graceUntil = t + this.o.fillGraceMs;
        this.after(rec, this.o.fillGraceMs, () => this.evaluateTerminal(rec, true));
      }
      return;
    }
    if (!fillsComplete) {
      // mt:25 never covered the aggregate: synthesise the shortfall from the order message
      const missing = o.fs - rec.cumulativeLots;
      const feeSoFar = rec.fills.reduce((a, f) => a + BigInt(f.feeCns), 0n);
      const feeMissing = BigInt(o.f || "0") - feeSoFar;
      this.recordFill(
        rec,
        { at: { ...o.at }, mkt: o.mkt, acc: o.acc, oid: o.oid, t: o.t, l: 2, p: o.fp, s: missing, f: (feeMissing > 0n ? feeMissing : 0n).toString() },
        true,
      );
    }
    const filledAny = rec.cumulativeLots > 0;
    if (o.st === OrderStatus.Filled || o.st === OrderStatus.Executed) {
      if (!rec.filledFired && rec.fills.length) {
        const last = rec.fills[rec.fills.length - 1] as FillInfo;
        rec.filledFired = true;
        this.safe(() => rec.handlers.filled?.({ ...last, cumulativeSize: last.cumulativeSize }));
      }
      this.settleWith(rec, "filled", undefined);
    } else if (rec.intent.type === OrderType.Cancel) {
      this.settleWith(rec, "cancelled", undefined);
    } else if (filledAny) {
      this.settleWith(rec, "partially_filled", undefined);
    } else if (isImmediate(rec.intent)) {
      const msg = o.sr === 16 || o.sr === 0 ? "the immediate order did not fill (no liquidity within the max slippage)" : describeOrderStatus(o);
      this.failRec(rec, { source: "unfilled", code: o.sr ? `sr:${o.sr}` : "unfilled", st: o.st, sr: o.sr, message: msg });
      return;
    } else {
      this.settleWith(rec, o.st === OrderStatus.Expired ? "expired" : "cancelled", undefined);
    }
    this.closeRec(rec);
  }

  // ---- retries and expiry -----------------------------------------------------------------------------------------

  private scheduleRetry(rec: Rec, reason: string, refreshLfr = false): void {
    if (rec.closed) return;
    rec.phase = "retry_wait";
    rec.pendingRetryReason = reason;
    rec.retryAt = this.now() + this.o.retryBackoffMs;
    this.after(rec, this.o.retryBackoffMs, () => {
      if (rec.phase === "retry_wait") this.runRetry(rec);
    });
    if (refreshLfr && this.refreshAccounts) {
      void this.refreshAccounts()
        .then((accs) => this.setAccounts(accs))
        .catch((e) => this.log.warn("account refresh failed", { error: (e as Error).message }));
    }
    this.ensureTick();
  }

  private runRetry(rec: Rec): void {
    const reason = rec.pendingRetryReason ?? "retry";
    rec.retryAt = undefined;
    rec.pendingRetryReason = undefined;
    if (rec.closed) return;
    if (rec.attempts >= this.o.maxAttempts) {
      this.failRec(rec, { source: "status", code: "retries_exhausted", message: `giving up after ${rec.attempts} attempts (${reason})` });
      return;
    }
    const oldRq = rec.rq;
    this.retire(oldRq, oldRq);
    this.safe(() => rec.handlers.retry?.({ rq: oldRq, oldRq, reason, atMs: this.now(), tag: rec.intent.tag }));
    void this.dispatch(rec, "new_rq");
  }

  private isExpired(rec: Rec): boolean {
    if (this.socket.heartbeatsSeen && this.socket.head !== undefined && rec.expiryBlock !== undefined) return this.socket.head >= rec.expiryBlock;
    if (rec.expiryWallMs !== undefined) return this.now() >= rec.expiryWallMs;
    return false;
  }

  private async reconcile(rec: Rec): Promise<void> {
    rec.phase = "reconciling";
    let found: Order[] | null = null;
    if (this.reconcileFn) {
      try {
        found = await this.reconcileFn(rec.rq, rec.accountId);
      } catch (e) {
        this.log.warn("reconcile failed", { rq: rec.rq, error: (e as Error).message });
        found = null;
      }
    }
    if (rec.closed) return;
    if (found === null) {
      this.timeoutRec(rec, "no status for the order and the connection was interrupted; outcome unknown, reconcile through REST", true);
      return;
    }
    if (found.length > 0) {
      rec.phase = "awaiting";
      const mine = found.filter((x) => x.rq === rec.rq);
      // process failures last so a non-failure wins the dedupe
      mine.sort((a, b) => Number(a.st === OrderStatus.Failed) - Number(b.st === OrderStatus.Failed));
      for (const o of mine) this.applyOrder(rec, o);
      if (!rec.definitive && !rec.closed && rec.firstFailure === undefined) {
        this.timeoutRec(rec, "reconciled but Perpl reported no definitive status", true);
      }
      return;
    }
    // Perpl has no record of this rq and its window is over: it can never execute. A new rq is safe.
    rec.ambiguous = false;
    if (this.o.retryOnExpiry && rec.attempts < this.o.maxAttempts) this.scheduleRetry(rec, "reconciled: no record of the expired rq");
    else this.timeoutRec(rec, "the order's execution window expired without any status", false);
  }

  // ---- socket events ----------------------------------------------------------------------------------------------

  private onDisconnected(code: number): void {
    for (const rec of this.recs) {
      if (rec.closed) continue;
      if (rec.sends > 0) rec.ambiguous = true;
      if (code === 1011 && !rec.definitive && !rec.ackOk && rec.phase === "awaiting") {
        rec.closes1011++;
        if (rec.closes1011 >= 2) {
          this.failRec(rec, { source: "socket", code: "socket_closed_1011", message: "Perpl closed the socket (1011 failed to process) twice for this order: unknown market, foreign account or an unparseable frame" });
        }
      }
    }
  }

  private onConnected(): void {
    for (const rec of this.recs) {
      if (rec.closed || rec.phase === "reconciling" || rec.phase === "retry_wait" || rec.phase === "queued") continue;
      if (rec.sends === 0) {
        // a send attempted while the socket was down: it never reached the wire, send it now (same rq)
        if (rec.rq !== 0) void this.dispatch(rec, "resend");
        continue;
      }
      if (!rec.definitive) {
        if (this.isExpired(rec)) {
          if (rec.ambiguous) void this.reconcile(rec);
          else if (this.o.retryOnExpiry) this.scheduleRetry(rec, "execution window expired");
        } else {
          void this.dispatch(rec, "resend");
        }
      } else if (rec.ambiguous && !rec.terminalOrder) {
        // we may have missed updates for a resting / part-filled order: ask REST
        void this.reconcile(rec);
      }
    }
  }

  // ---- housekeeping -----------------------------------------------------------------------------------------------

  private ensureTick(): void {
    if (this.tickTimer || this.disposed) return;
    this.tickTimer = setInterval(() => this.tick(), this.o.tickMs);
    (this.tickTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** Evaluate deadlines. Runs on every heartbeat and on an interval. */
  tick(): void {
    const t = this.now();
    for (const rec of [...this.recs]) {
      if (rec.closed) {
        if (rec.closedAt !== undefined && t - rec.closedAt > 60_000) this.forget(rec);
        continue;
      }
      if (rec.phase === "retry_wait") {
        if (rec.retryAt !== undefined && t >= rec.retryAt) this.runRetry(rec);
        continue;
      }
      if (rec.terminalOrder) {
        if (rec.graceUntil !== undefined && t >= rec.graceUntil) this.evaluateTerminal(rec, true);
        continue;
      }
      if (rec.iocSettleAt !== undefined && t >= rec.iocSettleAt) {
        this.settleIoc(rec);
        continue;
      }
      if (rec.phase === "reconciling" || rec.sends === 0) {
        if (rec.sends === 0 && rec.phase !== "queued" && t > rec.deadline) this.timeoutRec(rec, "order could not be sent before the deadline", false);
        continue;
      }
      if (rec.settled && rec.phase === "open") continue; // resting order, nothing time based
      if (t > rec.deadline && !rec.definitive) {
        this.timeoutRec(rec, `no outcome within ${this.o.maxWaitMs} ms`, rec.ambiguous || rec.sends > 0);
        continue;
      }
      if (rec.definitive) {
        if (t > rec.deadline) this.timeoutRec(rec, `the order was accepted but did not reach a terminal state within ${this.o.maxWaitMs} ms`, true);
        continue;
      }
      // no status yet
      if (this.isExpired(rec)) {
        if (rec.ambiguous) void this.reconcile(rec);
        else if (this.o.retryOnExpiry && rec.attempts < this.o.maxAttempts) this.scheduleRetry(rec, "head >= lb with no status and no reconnect");
        else this.timeoutRec(rec, "the order's execution window expired without any status", false);
        continue;
      }
      if (this.socket.isReady() && !rec.ackOk && t - rec.lastSendAt >= this.o.ackTimeoutMs && rec.resendsThisRq < this.o.maxResends) {
        void this.dispatch(rec, "resend");
      }
    }
    for (const [k, v] of this.orphanFills) if (t - v.at > 30_000) this.orphanFills.delete(k);
    if (this.recs.size === 0 && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  private settleIoc(rec: Rec): void {
    rec.iocSettleAt = undefined;
    if (rec.closed || rec.terminalOrder) return;
    if (rec.cumulativeLots > 0) {
      this.settleWith(rec, "partially_filled", undefined);
      this.closeRec(rec);
    }
  }

  private forget(rec: Rec): void {
    this.recs.delete(rec);
    for (const rq of rec.rqs) {
      if (this.byRq.get(rq) === rec) this.byRq.delete(rq);
    }
    for (const [sn, l] of this.bySn) if (l.rec === rec) this.bySn.delete(sn);
    if (rec.orderId !== undefined) this.byOid.delete(`${rec.accountId}:${rec.orderId}`);
    // retired map entries stay (small) so late failures of old rqs keep being ignored
  }

  // ---- settling ---------------------------------------------------------------------------------------------------

  private buildOutcome(rec: Rec, status: OutcomeStatus, extra: { failure?: FailureInfo; timeout?: TimeoutInfo }): OrderOutcome {
    const m = rec.market;
    const filledSize = fromScaled(rec.cumulativeLots, m.sizeDecimals);
    let notional = 0;
    let feeUsd = 0;
    for (const f of rec.fills) {
      notional += f.price * f.size;
      feeUsd += f.fee;
    }
    const avgPrice = filledSize > 0 ? (rec.fills.length ? notional / filledSize : undefined) : undefined;
    const tx = [...new Set(rec.fills.map((f) => f.txHash).filter((x): x is string => !!x))];
    const o = rec.terminalOrder ?? rec.lastOrder;
    if (o?.at?.txid && !tx.includes(o.at.txid)) tx.push(o.at.txid);
    return {
      status,
      marketId: rec.intent.marketId,
      accountId: rec.accountId,
      rq: rec.rq,
      rqs: [...rec.rqs],
      sn: rec.lastSn,
      attempts: rec.attempts,
      sends: rec.sends,
      ...(rec.orderId !== undefined ? { orderId: rec.orderId } : {}),
      requestedSize: fromScaled(rec.requestedLots, m.sizeDecimals),
      filledSize,
      ...(avgPrice !== undefined ? { avgPrice } : {}),
      feeUsd,
      fills: [...rec.fills],
      txHashes: tx,
      ...(extra.failure ? { failure: extra.failure } : {}),
      ...(extra.timeout ? { timeout: extra.timeout } : {}),
      ambiguous: extra.timeout?.ambiguous ?? false,
      ...(rec.intent.tag ? { tag: rec.intent.tag } : {}),
      startedAtMs: rec.startedAt,
      ...(rec.sentAt !== undefined ? { sentAtMs: rec.sentAt } : {}),
      ...(rec.acceptedAt !== undefined ? { acceptedAtMs: rec.acceptedAt } : {}),
      ...(rec.firstFillAt !== undefined ? { firstFillAtMs: rec.firstFillAt } : {}),
      doneAtMs: this.now(),
    };
  }

  private settleWith(rec: Rec, status: OutcomeStatus, extra: { failure?: FailureInfo; timeout?: TimeoutInfo } | undefined): void {
    if (rec.settled) return;
    rec.settled = true;
    rec.outcome.resolve(this.buildOutcome(rec, status, extra ?? {}));
  }

  /** Exact-time callback owned by an order; cleared when the order closes. */
  private after(rec: Rec, ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      rec.timers.delete(t);
      if (!rec.closed) fn();
    }, ms);
    (t as unknown as { unref?: () => void }).unref?.();
    rec.timers.add(t);
  }

  private closeRec(rec: Rec): void {
    if (rec.closed) return;
    for (const t of rec.timers) clearTimeout(t);
    rec.timers.clear();
    rec.closed = true;
    rec.phase = "done";
    rec.closedAt = this.now();
    for (const rq of rec.rqs) if (rq !== rec.rq) this.retire(rq, rec.rq);
  }

  private failRec(rec: Rec, f: Omit<FailureInfo, "rq" | "atMs" | "tag">): void {
    if (rec.closed) return;
    const info: FailureInfo = { ...f, rq: rec.rq, atMs: this.now(), tag: rec.intent.tag };
    this.safe(() => rec.handlers.failed?.(info));
    this.settleWith(rec, "failed", { failure: info });
    this.closeRec(rec);
  }

  private timeoutRec(rec: Rec, reason: string, ambiguous: boolean): void {
    if (rec.closed) return;
    const info: TimeoutInfo = { reason, ambiguous, rq: rec.rq, atMs: this.now(), tag: rec.intent.tag };
    this.safe(() => rec.handlers.timeout?.(info));
    this.settleWith(rec, "timeout", { timeout: info });
    this.closeRec(rec);
  }

  private failEarly(rec: Rec, source: FailureInfo["source"], code: string, message: string): Promise<OrderOutcome> {
    this.failRec(rec, { source, code, message });
    return rec.outcome.promise;
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.log.error("order handler threw", { error: (e as Error).message });
    }
  }
}
