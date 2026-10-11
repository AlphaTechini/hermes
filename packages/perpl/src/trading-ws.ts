/**
 * Trading WebSocket (`/ws/v1/trading`), docs/research/perpl.md section 5.
 *
 *  - first frame is the mt:29 API-key sign-in; the wallet snapshot (mt:19) marks the socket READY and seeds heartbeat
 *    sequence tracking (`lastSn = snapshot.sn`)
 *  - heartbeat (mt:100) `sn` must be exactly previous + 1; any gap forces a reconnect (state may have been missed)
 *  - reconnect with the documented exponential back-off schedule + jitter; 1001 reconnects immediately; 3401 re-signs
 *  - every outbound frame is rate limited with a token bucket (60 requests/min on testnet, pings count)
 *  - every mt:22 gets a unique non-zero `sn` from {@link PerplTradingSocket.nextSn}
 *  - mt:3 status frames are de-duplicated; close 1011 ("failed to process") is surfaced as an error event, it means no
 *    mt:3 will ever arrive for the frame that caused it
 *
 * Emits typed events (see {@link TradingSocketEvents}). Order tracking (rq / retry rules) lives in order-tracker.ts.
 */
import WebSocket from "ws";
import {
  MsgType,
  RECONNECT_DELAYS_MS,
  WsCloseCode,
  buildPing,
  parseServerFrame,
  type Account,
  type AccountStatsFrame,
  type FillsFrame,
  type HeartbeatFrame,
  type OrdersFrame,
  type PositionsFrame,
  type StatusResponseFrame,
  type WalletFrame,
} from "./protocol";
import { Ed25519Signer, buildSignInFrame } from "./signing";
import { BoundedSet, TokenBucket, TypedEmitter, backoffDelay, deferred, noopLogger, sleep, type Deferred, type Logger } from "./util";

export class PerplSocketError extends Error {
  readonly code: number | undefined;
  readonly reason: string;
  constructor(message: string, p: { code?: number; reason?: string } = {}) {
    super(message);
    this.name = "PerplSocketError";
    this.code = p.code;
    this.reason = p.reason ?? "";
  }
}
export class NotConnectedError extends PerplSocketError {
  constructor() {
    super("trading socket is not connected");
    this.name = "NotConnectedError";
  }
}
export class RateLimitedError extends PerplSocketError {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`request budget exhausted, retry in ${retryAfterMs} ms`);
    this.name = "RateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}
export class HeartbeatGapError extends PerplSocketError {
  constructor(expected: number, got: number) {
    super(`heartbeat gap: expected sn ${expected}, got ${got}; forcing reconnect`);
    this.name = "HeartbeatGapError";
  }
}

export type SocketState = "idle" | "connecting" | "authenticating" | "ready" | "backoff" | "closed";

export interface TradingSocketEvents {
  /** Wallet snapshot received after sign-in: the socket is ready. `epoch` increments with every (re)connection. */
  connected: { epoch: number; attempt: number; wallet: WalletFrame };
  disconnected: { code: number; reason: string; epoch: number; wasReady: boolean; willReconnect: boolean; forced?: string | undefined };
  walletSnapshot: WalletFrame;
  /** mt:21. Re-read `fw`, `ft` and `lfr` from it. */
  account: Account;
  orders: { snapshot: boolean; frame: OrdersFrame };
  fills: FillsFrame;
  positions: { snapshot: boolean; frame: PositionsFrame };
  /** mt:3, de-duplicated. */
  status: StatusResponseFrame;
  heartbeat: HeartbeatFrame;
  stats: AccountStatsFrame;
  error: Error;
}

/** The slice of the socket the order tracker needs; lets tests drive the tracker with a fake. */
export interface OrderSocket {
  nextSn(): number;
  isReady(): boolean;
  /** Latest head block from heartbeats. */
  readonly head: number | undefined;
  /** Whether at least one heartbeat arrived on the current connection. */
  readonly heartbeatsSeen: boolean;
  /** Increments on every successful (re)connection. */
  readonly epoch: number;
  send(frame: object, opts?: { maxWaitMs?: number }): Promise<void>;
  on<K extends keyof TradingSocketEvents>(event: K, fn: (p: TradingSocketEvents[K]) => void): () => void;
}

export interface TradingSocketOptions {
  /** Base ws URL, for example `wss://testnet.perpl.xyz`. `/ws/v1/trading` is appended. */
  wsUrl: string;
  chainId: number;
  apiKey: string;
  signer: Ed25519Signer;
  /** Auto-reconnect after the socket was ready once. Default true. */
  reconnect?: boolean;
  /** Back-off schedule in ms. Default [1000,2000,4000,8000,16000,32000,60000]. */
  backoffMs?: readonly number[];
  /** Additive jitter fraction of each delay (0..1). Default 0.25. */
  jitter?: number;
  random?: () => number;
  /** Requests per minute per connection. Default 60 (testnet; mainnet 120). */
  maxRequestsPerMinute?: number;
  /** Max time a send() waits for budget before failing with RateLimitedError. Default 5000. */
  maxSendWaitMs?: number;
  /** Close and retry if no wallet snapshot arrives this long after the socket opens. Default 10000. */
  authTimeoutMs?: number;
  /** Force a reconnect if no heartbeat for this long (armed after the first heartbeat). 0 disables. Default 15000. */
  heartbeatTimeoutMs?: number;
  /** Keep-alive ping interval. 0 disables. Default 30000. */
  pingIntervalMs?: number;
  /** Stop reconnecting after this many consecutive 3401 failures. Default 3. */
  maxAuthFailures?: number;
  /** Override socket construction (tests). */
  createSocket?: (url: string) => WebSocket;
  logger?: Logger;
  /** Initial value for the frame counter (the next sn is this + 1). */
  initialSn?: number;
}

export class PerplTradingSocket extends TypedEmitter<TradingSocketEvents> implements OrderSocket {
  private readonly o: Required<Omit<TradingSocketOptions, "createSocket" | "initialSn" | "logger" | "random">> & {
    createSocket: (url: string) => WebSocket;
    random: () => number;
    logger: Logger;
  };
  private ws: WebSocket | undefined;
  private _state: SocketState = "idle";
  private _epoch = 0;
  private _head: number | undefined;
  private _hbSeen = false;
  private lastHbSn: number | undefined;
  private snCounter: number;
  private bucket: TokenBucket;
  private attempt = 0;
  private authFailures = 0;
  private everReady = false;
  private wasReadyThisConn = false;
  private intentionalClose = false;
  private forcedReason: string | undefined;
  private firstConnect: Deferred<void> | undefined;
  private authTimer: ReturnType<typeof setTimeout> | undefined;
  private hbTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private sendTail: Promise<unknown> = Promise.resolve();
  private readonly seenStatus = new BoundedSet<string>(2048);
  private _wallet: WalletFrame | undefined;
  private snapshots = { orders: false, positions: false };
  private snapshotWaiters: Array<() => void> = [];
  private lastClose: { code: number; reason: string } | undefined;

  constructor(opts: TradingSocketOptions) {
    super();
    const url = (opts.wsUrl.replace(/\/+$/, "") + "/ws/v1/trading").replace(/^http/, "ws");
    this.o = {
      wsUrl: url,
      chainId: opts.chainId,
      apiKey: opts.apiKey,
      signer: opts.signer,
      reconnect: opts.reconnect ?? true,
      backoffMs: opts.backoffMs ?? RECONNECT_DELAYS_MS,
      jitter: opts.jitter ?? 0.25,
      maxRequestsPerMinute: opts.maxRequestsPerMinute ?? 60,
      maxSendWaitMs: opts.maxSendWaitMs ?? 5000,
      authTimeoutMs: opts.authTimeoutMs ?? 10_000,
      heartbeatTimeoutMs: opts.heartbeatTimeoutMs ?? 15_000,
      pingIntervalMs: opts.pingIntervalMs ?? 30_000,
      maxAuthFailures: opts.maxAuthFailures ?? 3,
      createSocket: opts.createSocket ?? ((u) => new WebSocket(u, { handshakeTimeout: 10_000 })),
      random: opts.random ?? Math.random,
      logger: opts.logger ?? noopLogger,
    };
    this.snCounter = opts.initialSn ?? 0;
    this.bucket = new TokenBucket(this.o.maxRequestsPerMinute);
  }

  // ---- accessors --------------------------------------------------------------------------------------------------

  get state(): SocketState {
    return this._state;
  }
  get epoch(): number {
    return this._epoch;
  }
  get head(): number | undefined {
    return this._head;
  }
  get heartbeatsSeen(): boolean {
    return this._hbSeen;
  }
  /** Last wallet snapshot. */
  get wallet(): WalletFrame | undefined {
    return this._wallet;
  }
  /** Close code/reason of the last disconnect. */
  get lastCloseInfo(): { code: number; reason: string } | undefined {
    return this.lastClose;
  }
  isReady(): boolean {
    return this._state === "ready" && this.ws?.readyState === WebSocket.OPEN;
  }
  /** Unique, non-zero, monotonically increasing frame sequence (survives reconnects). */
  nextSn(): number {
    return ++this.snCounter;
  }
  /** Remaining request budget in the current window. */
  get budgetRemaining(): number {
    return this.bucket.available;
  }

  // ---- lifecycle --------------------------------------------------------------------------------------------------

  /**
   * Open the socket, sign in, and resolve when the wallet snapshot arrived. Rejects (without retrying) if the FIRST
   * attempt fails; after the socket has been ready once, drops are retried automatically.
   */
  connect(): Promise<void> {
    if (this._state === "ready") return Promise.resolve();
    if (this.firstConnect) return this.firstConnect.promise;
    this.intentionalClose = false;
    this.firstConnect = deferred<void>();
    this.firstConnect.promise.catch(() => {}); // avoid unhandled rejection when nobody awaits
    this.open();
    return this.firstConnect.promise;
  }

  /** Close for good (no reconnect). */
  async close(): Promise<void> {
    this.intentionalClose = true;
    this.clearTimers();
    const ws = this.ws;
    this._state = "closed";
    if (this.firstConnect) {
      this.firstConnect.reject(new PerplSocketError("closed before ready"));
      this.firstConnect = undefined;
    }
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        resolve();
      }, 1500);
      ws.once("close", () => {
        clearTimeout(t);
        resolve();
      });
      try {
        ws.close(1000, "client closing");
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
  }

  /** Drop the current connection and let the reconnect logic take over (as after a heartbeat gap). */
  forceReconnect(reason: string): void {
    this.o.logger.warn("forcing reconnect", { reason });
    this.forcedReason = reason;
    const ws = this.ws;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }
  }

  /** Resolve once the orders and positions snapshots following sign-in were seen (or after `timeoutMs`). */
  whenSnapshots(timeoutMs = 5000): Promise<boolean> {
    if (this.snapshots.orders && this.snapshots.positions) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.snapshotWaiters = this.snapshotWaiters.filter((w) => w !== done);
        resolve(false);
      }, timeoutMs);
      const done = (): void => {
        clearTimeout(t);
        resolve(true);
      };
      this.snapshotWaiters.push(done);
    });
  }

  // ---- sending ----------------------------------------------------------------------------------------------------

  /**
   * Send a frame, waiting up to `maxWaitMs` for request budget. Sends are serialised so order is preserved.
   * Rejects with NotConnectedError / RateLimitedError.
   */
  send(frame: object, opts: { maxWaitMs?: number } = {}): Promise<void> {
    const maxWait = opts.maxWaitMs ?? this.o.maxSendWaitMs;
    const run = async (): Promise<void> => {
      const deadline = Date.now() + maxWait;
      while (!this.bucket.tryTake()) {
        const wait = this.bucket.msUntil();
        if (Date.now() + wait > deadline) throw new RateLimitedError(wait);
        await sleep(wait);
      }
      if (!this.isReady()) throw new NotConnectedError();
      this.rawSend(frame);
    };
    const p = this.sendTail.then(run, run);
    this.sendTail = p.catch(() => {});
    return p;
  }

  private rawSend(frame: object): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new NotConnectedError();
    ws.send(JSON.stringify(frame));
  }

  // ---- connection -------------------------------------------------------------------------------------------------

  private open(): void {
    this._state = "connecting";
    this.wasReadyThisConn = false;
    this.forcedReason = undefined;
    this.lastHbSn = undefined;
    this._hbSeen = false;
    this.snapshots = { orders: false, positions: false };
    this.bucket = new TokenBucket(this.o.maxRequestsPerMinute);
    let ws: WebSocket;
    try {
      ws = this.o.createSocket(this.o.wsUrl);
    } catch (e) {
      this.handleClose(1006, `connect failed: ${(e as Error).message}`);
      return;
    }
    this.ws = ws;
    ws.on("open", () => this.onOpen(ws));
    ws.on("message", (data) => {
      if (ws !== this.ws) return;
      this.onMessage(typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(data as Buffer[]).toString("utf8"));
    });
    ws.on("error", (err) => {
      // 'close' always follows; keep the message for diagnostics
      this.o.logger.warn("socket error", { message: err.message });
      if (this._state === "connecting" || this._state === "authenticating") this.pendingError = err;
    });
    ws.on("close", (code, reasonBuf) => {
      if (ws !== this.ws) return;
      this.handleClose(code, reasonBuf.toString("utf8"));
    });
  }
  private pendingError: Error | undefined;

  private onOpen(ws: WebSocket): void {
    if (ws !== this.ws) return;
    this._state = "authenticating";
    // the sign-in MUST be the first frame, and quickly (10 s idle timeout on testnet)
    this.bucket.tryTake();
    const frame = buildSignInFrame(this.o.signer, this.o.chainId, this.o.apiKey);
    try {
      ws.send(JSON.stringify(frame));
    } catch (e) {
      this.forceReconnect(`sign-in send failed: ${(e as Error).message}`);
      return;
    }
    this.authTimer = setTimeout(() => this.forceReconnect("no wallet snapshot after sign-in"), this.o.authTimeoutMs);
  }

  private onMessage(text: string): void {
    const parsed = parseServerFrame(text);
    if (!parsed.ok) {
      this.emit("error", new PerplSocketError(`unparseable frame: ${parsed.error}`));
      return;
    }
    const f = parsed.frame;
    switch (f.mt) {
      case MsgType.StatusResponse: {
        const s = f as StatusResponseFrame;
        const key = `${s.cid ?? "-"}|${s.sn ?? "-"}|${s.status.code}|${s.status.error ?? ""}`;
        if (!this.seenStatus.add(key)) return;
        this.emit("status", s);
        return;
      }
      case MsgType.Pong:
        return;
      case MsgType.WalletSnapshot:
        this.onWallet(f as WalletFrame);
        return;
      case MsgType.WalletUpdate:
        this._wallet = f as WalletFrame;
        for (const a of (f as WalletFrame).as) this.emit("account", a);
        return;
      case MsgType.AccountUpdate:
        this.emit("account", f as unknown as Account);
        return;
      case MsgType.OrdersSnapshot:
        this.snapshots.orders = true;
        this.checkSnapshots();
        this.emit("orders", { snapshot: true, frame: f as OrdersFrame });
        return;
      case MsgType.OrdersUpdate:
        this.emit("orders", { snapshot: false, frame: f as OrdersFrame });
        return;
      case MsgType.FillsUpdate:
        this.emit("fills", f as FillsFrame);
        return;
      case MsgType.PositionsSnapshot:
        this.snapshots.positions = true;
        this.checkSnapshots();
        this.emit("positions", { snapshot: true, frame: f as PositionsFrame });
        return;
      case MsgType.PositionsUpdate:
        this.emit("positions", { snapshot: false, frame: f as PositionsFrame });
        return;
      case MsgType.AccountStatsUpdate:
        this.emit("stats", f as AccountStatsFrame);
        return;
      case MsgType.Heartbeat:
        this.onHeartbeat(f as HeartbeatFrame);
        return;
      default:
        return;
    }
  }

  private checkSnapshots(): void {
    if (this.snapshots.orders && this.snapshots.positions) {
      const w = this.snapshotWaiters;
      this.snapshotWaiters = [];
      for (const fn of w) fn();
    }
  }

  private onWallet(w: WalletFrame): void {
    this._wallet = w;
    // seed heartbeat tracking from the snapshot
    this.lastHbSn = w.sn;
    if (this._state !== "ready") {
      if (this.authTimer) clearTimeout(this.authTimer);
      this.authTimer = undefined;
      this._state = "ready";
      this._epoch++;
      this.wasReadyThisConn = true;
      this.everReady = true;
      const attempt = this.attempt;
      this.attempt = 0;
      this.authFailures = 0;
      this.startPing();
      // accounts (fresh `lfr`!) are published before `connected`, so listeners that re-send on `connected` see them
      this.emit("walletSnapshot", w);
      for (const a of w.as) this.emit("account", a);
      this.emit("connected", { epoch: this._epoch, attempt, wallet: w });
      this.firstConnect?.resolve();
      return;
    }
    this.emit("walletSnapshot", w);
    for (const a of w.as) this.emit("account", a);
  }

  private onHeartbeat(hb: HeartbeatFrame): void {
    if (this.lastHbSn !== undefined && hb.sn !== this.lastHbSn + 1) {
      const err = new HeartbeatGapError(this.lastHbSn + 1, hb.sn);
      this.emit("error", err);
      this.forceReconnect(err.message);
      return;
    }
    this.lastHbSn = hb.sn;
    this._head = hb.h;
    this._hbSeen = true;
    this.armHeartbeatWatchdog();
    this.emit("heartbeat", hb);
  }

  private armHeartbeatWatchdog(): void {
    if (this.o.heartbeatTimeoutMs <= 0) return;
    if (this.hbTimer) clearTimeout(this.hbTimer);
    this.hbTimer = setTimeout(() => {
      this.emit("error", new PerplSocketError(`no heartbeat for ${this.o.heartbeatTimeoutMs} ms; forcing reconnect`));
      this.forceReconnect("heartbeat timeout");
    }, this.o.heartbeatTimeoutMs);
  }

  private startPing(): void {
    if (this.o.pingIntervalMs <= 0) return;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.isReady()) return;
      if (!this.bucket.tryTake()) return; // budget exhausted: the keep-alive can wait, orders cannot
      try {
        this.rawSend(buildPing());
      } catch {
        // close handler will take over
      }
    }, this.o.pingIntervalMs);
  }

  private clearTimers(): void {
    for (const t of [this.authTimer, this.hbTimer, this.reconnectTimer]) if (t) clearTimeout(t);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.authTimer = this.hbTimer = this.reconnectTimer = undefined;
    this.pingTimer = undefined;
  }

  private handleClose(code: number, reason: string): void {
    const wasReady = this.wasReadyThisConn;
    this.clearTimers();
    this.ws = undefined;
    this.lastClose = { code, reason };
    const forced = this.forcedReason;
    this.forcedReason = undefined;

    if (code === WsCloseCode.Unauthorized) this.authFailures++;

    if (code === WsCloseCode.FailedToProcess) {
      this.emit("error", new PerplSocketError("Perpl closed the socket with 1011 (failed to process): unknown market, foreign account or unparseable frame. No status will arrive for the frame that caused it.", { code, reason }));
    } else if (code === WsCloseCode.Unauthorized) {
      this.emit("error", new PerplSocketError("Perpl rejected the API-key sign-in (3401)", { code, reason }));
    } else if (code === WsCloseCode.SendBufferOverflow) {
      this.emit("error", new PerplSocketError("Perpl closed the socket with 1013 (send buffer overflow): the client reads too slowly", { code, reason }));
    }

    const first = this.firstConnect;
    const failedFirst = !this.everReady && first !== undefined;
    const fatalAuth = code === WsCloseCode.Unauthorized && this.authFailures >= this.o.maxAuthFailures;
    const willReconnect = !this.intentionalClose && this.o.reconnect && this.everReady && !fatalAuth;

    this._state = this.intentionalClose ? "closed" : willReconnect ? "backoff" : "closed";
    this.emit("disconnected", { code, reason, epoch: this._epoch, wasReady, willReconnect, ...(forced ? { forced } : {}) });

    if (failedFirst) {
      const detail = this.pendingError ? `: ${this.pendingError.message}` : "";
      first.reject(new PerplSocketError(`trading socket closed before ready (code ${code}${reason ? ` "${reason}"` : ""})${detail}`, { code, reason }));
      this.firstConnect = undefined;
      this.pendingError = undefined;
      return;
    }
    this.pendingError = undefined;
    if (fatalAuth) {
      this.emit("error", new PerplSocketError("giving up after repeated 3401 authentication failures; check the API key and secret"));
    }
    if (!willReconnect) return;

    const delay = code === WsCloseCode.GoingAway ? 0 : backoffDelay(this.attempt, this.o.backoffMs, this.o.jitter, this.o.random);
    this.attempt++;
    this.o.logger.info("reconnecting", { inMs: delay, attempt: this.attempt, code, reason });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.intentionalClose) return;
      this.open();
    }, delay);
  }
}
