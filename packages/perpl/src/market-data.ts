/**
 * Market data WebSocket (`/ws/v1/market-data`, public, no auth) + REST fallback, perpl.md section 6.
 *
 * Subscribes (one mt:5 frame, we have 10 requests/min and 16 subscriptions per connection) to `market-state@<chain>`
 * for mark/last prices and `heartbeat@<chain>` for the head block. Caches the latest state per market; `getMarkPrice`
 * answers from the cache while it is fresh and falls back to `GET /v1/market-data/:id/ticker` otherwise.
 * No application pings are sent (they burn the 10/min budget; the server keeps the socket alive).
 */
import WebSocket from "ws";
import { MsgType, RECONNECT_DELAYS_MS, buildSubscribe, parseServerFrame, streams, type MarketState } from "./protocol";
import type { PerplRest } from "./rest";
import { fromScaled, type MarketSpec } from "./scaling";
import { TokenBucket, TypedEmitter, backoffDelay, deferred, noopLogger, type Deferred, type Logger } from "./util";

export interface MarkPrice {
  marketId: number;
  /** Human prices. */
  mark: number;
  last: number;
  oracle: number;
  mid: number;
  bid: number;
  ask: number;
  /** Block the state is current as of. */
  block?: number | undefined;
  /** Local receipt time. */
  atMs: number;
  source: "ws" | "rest";
}

export interface MarketDataEvents {
  price: MarkPrice;
  head: number;
  connected: undefined;
  disconnected: { code: number; reason: string };
  error: Error;
}

export interface MarketDataOptions {
  /** `wss://testnet.perpl.xyz` (the path `/ws/v1/market-data` is appended). */
  wsUrl: string;
  chainId: number;
  getMarket(marketId: number): MarketSpec | undefined;
  /** REST client for the ticker fallback. */
  rest?: PerplRest | undefined;
  /** A cached price older than this triggers the REST fallback. Default 5000. */
  staleAfterMs?: number;
  /** Default 10 (market-data budget per connection). */
  maxRequestsPerMinute?: number;
  backoffMs?: readonly number[];
  jitter?: number;
  random?: () => number;
  /** Additional streams (for example `order-book@16`). Total subscriptions are capped at 16. */
  extraStreams?: string[];
  createSocket?: (url: string) => WebSocket;
  logger?: Logger;
  /** Force a reconnect when nothing arrives for this long. 0 disables. Default 15000. */
  silenceTimeoutMs?: number;
}

export class PerplMarketData extends TypedEmitter<MarketDataEvents> {
  private readonly o: {
    url: string;
    chainId: number;
    staleAfterMs: number;
    backoffMs: readonly number[];
    jitter: number;
    random: () => number;
    streams: string[];
    silenceTimeoutMs: number;
    maxReq: number;
  };
  private readonly getMarket: MarketDataOptions["getMarket"];
  private readonly rest: PerplRest | undefined;
  private readonly createSocket: (url: string) => WebSocket;
  private readonly log: Logger;
  private ws: WebSocket | undefined;
  private bucket: TokenBucket;
  private readonly cache = new Map<number, MarkPrice>();
  private _head: number | undefined;
  private lastHbSn: number | undefined;
  private attempt = 0;
  private stopped = true;
  private _connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private first: Deferred<void> | undefined;
  private subscribed = new Map<string, boolean>();

  constructor(opts: MarketDataOptions) {
    super();
    const all = [streams.marketState(opts.chainId), streams.heartbeat(opts.chainId), ...(opts.extraStreams ?? [])];
    if (all.length > 16) throw new RangeError("market data allows 16 subscriptions per connection");
    this.o = {
      url: (opts.wsUrl.replace(/\/+$/, "") + "/ws/v1/market-data").replace(/^http/, "ws"),
      chainId: opts.chainId,
      staleAfterMs: opts.staleAfterMs ?? 5000,
      backoffMs: opts.backoffMs ?? RECONNECT_DELAYS_MS,
      jitter: opts.jitter ?? 0.25,
      random: opts.random ?? Math.random,
      streams: all,
      silenceTimeoutMs: opts.silenceTimeoutMs ?? 15_000,
      maxReq: opts.maxRequestsPerMinute ?? 10,
    };
    this.getMarket = opts.getMarket;
    this.rest = opts.rest;
    this.createSocket = opts.createSocket ?? ((u) => new WebSocket(u, { handshakeTimeout: 10_000 }));
    this.log = opts.logger ?? noopLogger;
    this.bucket = new TokenBucket(this.o.maxReq);
  }

  get head(): number | undefined {
    return this._head;
  }
  get connected(): boolean {
    return this._connected;
  }

  /** Connect and subscribe. Resolves when the subscription response arrived; rejects if the first attempt fails. */
  start(): Promise<void> {
    if (!this.stopped) return this.first?.promise ?? Promise.resolve();
    this.stopped = false;
    this.first = deferred<void>();
    this.first.promise.catch(() => {});
    this.open();
    return this.first.promise;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.reconnectTimer = this.silenceTimer = undefined;
    const ws = this.ws;
    this._connected = false;
    if (this.first) {
      this.first.reject(new Error("market data stopped"));
      this.first = undefined;
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
      }, 1000);
      ws.once("close", () => {
        clearTimeout(t);
        resolve();
      });
      try {
        ws.close(1000);
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
  }

  /** Latest cached price (any age), or undefined. */
  getCached(marketId: number): MarkPrice | undefined {
    return this.cache.get(marketId);
  }

  /**
   * Mark price in human units. Served from the WebSocket cache while fresh (`staleAfterMs`), else from the REST
   * ticker. Throws if neither works.
   */
  async getMarkPrice(marketId: number): Promise<number> {
    const hit = this.cache.get(marketId);
    if (hit && hit.mark > 0 && Date.now() - hit.atMs <= this.o.staleAfterMs) return hit.mark;
    if (this.rest) {
      try {
        const p = await this.fetchRest(marketId);
        if (p.mark > 0) return p.mark;
      } catch (e) {
        if (hit && hit.mark > 0) {
          this.log.warn("REST ticker fallback failed, serving stale cached mark", { marketId, ageMs: Date.now() - hit.atMs, error: (e as Error).message });
          return hit.mark;
        }
        throw e;
      }
    }
    if (hit && hit.mark > 0) return hit.mark;
    throw new Error(`no mark price available for market ${marketId}`);
  }

  /** Force a REST read (also updates the cache). */
  async fetchRest(marketId: number): Promise<MarkPrice> {
    if (!this.rest) throw new Error("no REST client configured");
    const frame = await this.rest.getMarketTicker(marketId);
    const s = frame.d[String(marketId)];
    const m = this.getMarket(marketId);
    if (!s || !m) throw new Error(`ticker has no state for market ${marketId}`);
    const price = this.toPrice(marketId, m, s, "rest", frame.sn);
    this.cache.set(marketId, price);
    if (frame.sn !== undefined) this.setHead(frame.sn);
    return price;
  }

  // ---- socket -----------------------------------------------------------------------------------------------------

  private open(): void {
    this.bucket = new TokenBucket(this.o.maxReq);
    this.lastHbSn = undefined;
    this.subscribed.clear();
    let ws: WebSocket;
    try {
      ws = this.createSocket(this.o.url);
    } catch (e) {
      this.onClose(1006, (e as Error).message);
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      if (ws !== this.ws) return;
      if (!this.bucket.tryTake()) return;
      ws.send(JSON.stringify(buildSubscribe(this.o.streams)));
      this.armSilence();
    });
    ws.on("message", (data) => {
      if (ws !== this.ws) return;
      this.armSilence();
      this.onMessage(Buffer.isBuffer(data) ? data.toString("utf8") : Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data as ArrayBuffer).toString("utf8"));
    });
    ws.on("error", (e) => this.log.warn("market data socket error", { message: e.message }));
    ws.on("close", (code, reason) => {
      if (ws !== this.ws) return;
      this.onClose(code, reason.toString("utf8"));
    });
  }

  private armSilence(): void {
    if (this.o.silenceTimeoutMs <= 0) return;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.emit("error", new Error(`no market data for ${this.o.silenceTimeoutMs} ms; reconnecting`));
      try {
        this.ws?.terminate();
      } catch {
        // ignore
      }
    }, this.o.silenceTimeoutMs);
    (this.silenceTimer as unknown as { unref?: () => void }).unref?.();
  }

  private onMessage(text: string): void {
    const parsed = parseServerFrame(text);
    if (!parsed.ok) {
      this.emit("error", new Error(`market data: unparseable frame (${parsed.error})`));
      return;
    }
    const f = parsed.frame;
    switch (f.mt) {
      case MsgType.SubscriptionResponse: {
        const subs = (f as { subs: Array<{ stream: string; status?: { code: number; error?: string } }> }).subs;
        let allOk = true;
        for (const s of subs) {
          const code = s.status?.code ?? 0;
          if (code !== 0) {
            allOk = false;
            this.emit("error", new Error(`market data subscription ${s.stream} failed: ${code} ${s.status?.error ?? ""}`));
          } else this.subscribed.set(s.stream, true);
        }
        if (allOk && !this._connected) {
          this._connected = true;
          this.attempt = 0;
          this.emit("connected", undefined);
          this.first?.resolve();
          this.first = undefined;
        } else if (!allOk && !this._connected) {
          this.first?.reject(new Error("market data subscription failed"));
          this.first = undefined;
        }
        return;
      }
      case MsgType.MarketStateUpdate: {
        const frame = f as { d: Record<string, MarketState>; sn?: number };
        for (const [id, s] of Object.entries(frame.d)) {
          const marketId = Number(id);
          const m = this.getMarket(marketId);
          if (!m) continue;
          const price = this.toPrice(marketId, m, s, "ws", s.at?.b ?? frame.sn);
          this.cache.set(marketId, price);
          this.emit("price", price);
        }
        return;
      }
      case MsgType.Heartbeat: {
        const hb = f as { sn: number; h: number };
        if (this.lastHbSn !== undefined && hb.sn !== this.lastHbSn + 1) {
          this.emit("error", new Error(`market data heartbeat gap: expected ${this.lastHbSn + 1}, got ${hb.sn}; reconnecting`));
          this.lastHbSn = undefined;
          try {
            this.ws?.terminate();
          } catch {
            // ignore
          }
          return;
        }
        this.lastHbSn = hb.sn;
        this.setHead(hb.h);
        return;
      }
      default:
        return;
    }
  }

  private setHead(h: number): void {
    if (this._head === undefined || h > this._head) {
      this._head = h;
      this.emit("head", h);
    }
  }

  private toPrice(marketId: number, m: MarketSpec, s: MarketState, source: "ws" | "rest", block: number | undefined): MarkPrice {
    const d = m.priceDecimals;
    return {
      marketId,
      mark: fromScaled(s.mrk, d),
      last: fromScaled(s.lst, d),
      oracle: fromScaled(s.orl, d),
      mid: fromScaled(s.mid, d),
      bid: fromScaled(s.bid, d),
      ask: fromScaled(s.ask, d),
      block,
      atMs: Date.now(),
      source,
    };
  }

  private onClose(code: number, reason: string): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
    const wasConnected = this._connected;
    this._connected = false;
    this.ws = undefined;
    if (this.stopped) return;
    this.emit("disconnected", { code, reason });
    if (!wasConnected && this.first) {
      this.first.reject(new Error(`market data socket closed before subscribing (code ${code} ${reason})`));
      this.first = undefined;
      this.stopped = true;
      return;
    }
    const delay = backoffDelay(this.attempt++, this.o.backoffMs, this.o.jitter, this.o.random);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.stopped) this.open();
    }, delay);
  }
}
