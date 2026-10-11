/**
 * Perpl SIMULATOR: a real WebSocket + HTTP server speaking the protocol of docs/research/perpl.md, so the live client,
 * order tracker and the whole Hermes server can be exercised without the testnet (which the build sandbox cannot reach).
 *
 * What it models
 *  - `GET /api/v1/pub/context`, public market-data REST, signed account REST (wallet, orders, positions, fills, order /
 *    position / account history, POST /v1/trading/orders). Signatures are VERIFIED (Ed25519 canonical strings, 30 s
 *    window, single-use nonces), so a signing bug fails here exactly as it would live.
 *  - Trading WS `/ws/v1/trading`: mt:29 sign-in verified against enrolled public keys (3401 on failure, 1008 idle timeout
 *    if no sign-in within `idleTimeoutMs`), snapshots 19 / 23 / 26, heartbeat mt:100 with an incrementing `sn`, mt:3 per
 *    mt:22, then after 150-600 ms mt:24 + mt:25 + mt:27 + mt:21 at the mark price +/- 0-8 bps adverse slippage, fees,
 *    fake but well-formed tx hashes and an advancing block number. rq must be strictly increasing; a repeated rq never
 *    executes twice (and replays its recorded result). Unknown market / foreign account / unparseable frame closes with
 *    1011 and no status. 60 requests/min and 4 connections per wallet (1008).
 *  - Market-data WS `/ws/v1/market-data`: mt:5 subscriptions (10 requests/min, 16 subscriptions), mt:9 market state,
 *    heartbeat stream.
 *  - GBM prices: BTC 112000, ETH 4100, SOL 210, MON 0.04, ZEC 60.
 *  - Fault injection ({@link SimFault}): drop status, disconnect mid-order, reject with a reason code, heartbeat gap,
 *    extra latency, fill-before-order ordering, partial fills, no liquidity, immediate close with a given code.
 *
 * ASSUMPTIONS (not specified by the docs; same as perpl.md "uncertainties"): duplicate rq replays the recorded mt:24/25
 * to the re-sending connection; position collateral is held outside the free balance `b`.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { PERPL_TESTNET } from "../chain";
import {
  MsgType,
  OrderFlag,
  OrderStatus,
  OrderType,
  PositionStatus,
  PositionStatusReason,
  type Account,
  type AccountEvent,
  type AccountStats,
  type Fill,
  type Order,
  type OrderSpec,
  type Position,
} from "../protocol";
import { Ed25519Signer, canonicalRest, canonicalWsSignin, parseEd25519PublicKey, verifySignature } from "../signing";
import { SIM_INSTANCE_ID, SIM_MARKETS, buildContext, type SimMarketDef } from "./markets";
import { GbmSeries, mulberry32 } from "./prices";

// ---------------------------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------------------------

/** One-shot (or counted) fault, consumed by the next matching event. */
export type SimFault =
  | {
      /** Swallow the statuses of the next order(s). `execute` (default true) still executes them. */
      kind: "drop_status";
      /** `mt3` drops only the mt:3 ack, `mt24` drops mt:24 + mt:25, `all` (default) drops all three. */
      which?: "mt3" | "mt24" | "all";
      execute?: boolean;
      count?: number;
    }
  | {
      /** Terminate the socket right after the order frame arrived, before any status. */
      kind: "disconnect_before_status";
      /** Execute anyway (the result is lost unless the client is back in time, and replays on the same rq). Default false. */
      execute?: boolean;
      count?: number;
    }
  | {
      /** Reject: `via: "order"` (default) = mt:3 ok then mt:24 st 7 with `sr`; `via: "status"` = mt:3 non-zero. */
      kind: "reject";
      sr?: number;
      fr?: number;
      via?: "order" | "status";
      httpCode?: number;
      error?: string;
      count?: number;
    }
  | { kind: "heartbeat_gap"; count?: number }
  | { kind: "delay"; ms: number; count?: number }
  | { kind: "fill_before_order"; count?: number }
  | { kind: "partial_fill"; fraction: number; count?: number }
  | { kind: "no_liquidity"; count?: number }
  | { kind: "close_socket"; code: number; reason?: string; count?: number };

export interface SimOptions {
  /** 0 or omitted = pick a free port. */
  port?: number;
  host?: string;
  chainId?: number;
  /** Seeds prices, latency, slippage and tx hashes for reproducible tests. */
  seed?: number;
  blockTimeMs?: number;
  heartbeatIntervalMs?: number;
  /** Close with 1008 `idle timeout` if the sign-in frame does not arrive within this. Default 10000. */
  idleTimeoutMs?: number;
  /** [min, max] order latency. Default [150, 600]. */
  latencyMs?: [number, number];
  /** Requests per minute per trading connection. Default 60. */
  rateLimitPerMin?: number;
  /** Max connections per wallet. Default 4. */
  maxConnectionsPerWallet?: number;
  /** Protocol-level ping interval; a client that does not pong is closed 1008 `ping timeout`. 0 disables. Default 15000. */
  wsPingIntervalMs?: number;
  startBlock?: number;
  /** Multiplier on every market's volatility. Default 1. */
  volMultiplier?: number;
  initialPrices?: Partial<Record<string, number>>;
  /** Max adverse slippage in bps for taker fills. Default 8. */
  maxSlipBps?: number;
  geoBlock?: string[];
  /** Answer every REST request with 451 (to test geo-block handling). */
  geoBlocked?: boolean;
  /** Replay the recorded result when an executed rq is sent again. Default true. */
  replayOnDuplicate?: boolean;
  /** Default balance of auto-created accounts, AUSD. Default 10000. */
  defaultBalanceAusd?: number;
}

export interface EnrollOptions {
  apiKey?: string;
  /** `read` keys can see state but are rejected (403) when trading. Default `trade`. */
  scope?: "read" | "trade";
}

export interface ExecutedOrder {
  accountId: number;
  rq: number;
  marketId: number;
  type: number;
  oid: number;
  filledLots: number;
  priceScaled: number;
  atMs: number;
  txHash: string;
}

export interface SimAccountView {
  id: number;
  wallet: string;
  forwarding: boolean;
  lfr: number;
  balanceAusd: number;
  positions: Array<{ marketId: number; symbol: string; side: "long" | "short"; lots: number; entryScaled: number; collateralAusd: number }>;
  realizedPnlAusd: number;
  trades: number;
}

export interface PerplSimulator {
  /** REST base INCLUDING `/api`, for example `http://127.0.0.1:41234/api`. Pass as `restUrl`. */
  url: string;
  /** WebSocket base, for example `ws://127.0.0.1:41234`. Pass as `wsUrl`. */
  wsUrl: string;
  port: number;
  chainId: number;
  stop(): Promise<void>;
  /** Register a public key for an account (created with a default balance if new). Returns the `X-API-Key` token. */
  enrollKey(publicKey: string | Uint8Array, accountId?: number, opts?: EnrollOptions): { apiKey: string; accountId: number };
  /** Generate a key pair, create an account and enroll: everything needed to construct a PerplClient. */
  enrollNewKey(opts?: EnrollOptions & { accountId?: number; balanceAusd?: number; forwarding?: boolean }): { apiKey: string; apiSecret: string; publicKeyHex: string; accountId: number; signer: Ed25519Signer };
  createAccount(opts?: { accountId?: number; balanceAusd?: number; forwarding?: boolean }): number;
  setForwarding(accountId: number, allowed: boolean): void;
  deposit(accountId: number, ausd: number): void;
  inject(fault: SimFault): void;
  clearFaults(): void;
  pendingFaults(): SimFault[];
  setPrice(symbol: string, price: number): void;
  getPrice(symbol: string): number;
  blockNumber(): number;
  account(accountId: number): SimAccountView | undefined;
  /** Every order that executed (use it to assert "no double fill"). */
  executedOrders(): ExecutedOrder[];
  /** Number of open trading sockets. */
  tradingConnections(): number;
  /** Close every trading socket with the given code. */
  dropConnections(code?: number, reason?: string): void;
  /** Total mt:22 frames received, duplicates included. */
  receivedOrderFrames(): number;
}

// ---------------------------------------------------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------------------------------------------------

const CNS = 10n ** 6n;

interface SimKey {
  apiKey: string;
  publicKey: Uint8Array;
  accountId: number;
  trade: boolean;
}

interface SimPos {
  pid: number;
  mkt: number;
  sd: 1 | 2;
  s: number;
  ep: number;
  c: bigint;
  fee: bigint;
  lv: number;
  rq: number;
  oid: number;
  ots: { b: number; t: number; txid: string };
}

interface Resting {
  oid: number;
  rq: number;
  mkt: number;
  t: number;
  p: number;
  lots: number;
  remaining: number;
  lv: number;
  fl: number;
  createdB: number;
}

interface OrderRec {
  rq: number;
  done: boolean;
  frames: object[];
  /** `lfr` before this rq was admitted (restored if the frame is "lost" before reaching the exchange). */
  prevLfr: number;
}

interface SimAccount {
  id: number;
  wallet: string;
  fw: boolean;
  fr: boolean;
  ft: number;
  lfr: number;
  balance: bigint;
  locked: bigint;
  positions: Map<number, SimPos>;
  resting: Map<number, Resting>;
  rqs: Map<number, OrderRec>;
  orderHistory: Order[];
  fills: Fill[];
  positionHistory: Position[];
  accountHistory: AccountEvent[];
  stats: { td: bigint; tw: bigint; tv: bigint; tf: bigint; trp: bigint; tt: number; wins: number };
}

interface TradingConn {
  ws: WebSocket;
  authed: boolean;
  keyScopeTrade: boolean;
  accountId: number;
  wallet: string;
  times: number[];
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  alive: boolean;
}

interface MarketConn {
  ws: WebSocket;
  times: number[];
  subs: Set<string>;
  hbSn: number;
}

interface Effects {
  order: Order;
  fills: Fill[];
  positions: Position[];
  events: AccountEvent[];
}

type Admit = { type: "reject"; code: number; error: string } | { type: "dup"; rec: OrderRec } | { type: "ok"; rec: OrderRec; fault?: SimFault };

const asNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : undefined);

// ---------------------------------------------------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------------------------------------------------

class Simulator {
  readonly opts: Required<Omit<SimOptions, "port" | "seed" | "initialPrices">> & { port: number };
  private readonly rand: () => number;
  private readonly http: HttpServer;
  private readonly tradingWss = new WebSocketServer({ noServer: true });
  private readonly marketWss = new WebSocketServer({ noServer: true });
  private readonly series = new Map<number, GbmSeries>();
  private readonly marketOpen = new Map<number, number>();
  private readonly accounts = new Map<number, SimAccount>();
  private readonly keys = new Map<string, SimKey>();
  private readonly nonces = new Map<string, number>();
  private readonly tradingConns = new Set<TradingConn>();
  private readonly marketConns = new Set<MarketConn>();
  private faults: Array<SimFault & { count?: number }> = [];
  private head: number;
  private hbSeq: number;
  private statusSn = 1000;
  private nextOid = 1;
  private nextPid = 1;
  private nextAccountId = 4321;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private pending = new Set<ReturnType<typeof setTimeout>>();
  private readonly executed: ExecutedOrder[] = [];
  private orderFrames = 0;
  port = 0;

  constructor(o: SimOptions) {
    this.opts = {
      port: o.port ?? 0,
      host: o.host ?? "127.0.0.1",
      chainId: o.chainId ?? PERPL_TESTNET.chainId,
      blockTimeMs: o.blockTimeMs ?? 400,
      heartbeatIntervalMs: o.heartbeatIntervalMs ?? 1000,
      idleTimeoutMs: o.idleTimeoutMs ?? 10_000,
      latencyMs: o.latencyMs ?? [150, 600],
      rateLimitPerMin: o.rateLimitPerMin ?? 60,
      maxConnectionsPerWallet: o.maxConnectionsPerWallet ?? 4,
      wsPingIntervalMs: o.wsPingIntervalMs ?? 15_000,
      startBlock: o.startBlock ?? 55_000_000,
      volMultiplier: o.volMultiplier ?? 1,
      maxSlipBps: o.maxSlipBps ?? 8,
      geoBlock: o.geoBlock ?? ["BY", "CU", "GB", "IR", "KP", "RU", "SY", "UA", "US"],
      geoBlocked: o.geoBlocked ?? false,
      replayOnDuplicate: o.replayOnDuplicate ?? true,
      defaultBalanceAusd: o.defaultBalanceAusd ?? 10_000,
    };
    this.rand = mulberry32(o.seed ?? (Math.random() * 2 ** 32) >>> 0);
    this.head = this.opts.startBlock;
    this.hbSeq = 1_000_000 + Math.floor(this.rand() * 1000);
    for (const m of SIM_MARKETS) {
      const start = o.initialPrices?.[m.symbol] ?? m.startPrice;
      this.series.set(m.id, new GbmSeries(this.rand, { start, annualVol: m.annualVol }, this.opts.volMultiplier));
      this.marketOpen.set(m.id, start);
    }
    this.http = createServer((req, res) => {
      void this.onHttp(req, res).catch((e) => {
        if (!res.headersSent) this.json(res, 500, { error: String((e as Error).message) });
        else res.end();
      });
    });
    this.http.on("upgrade", (req, socket, head) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (path === "/ws/v1/trading") this.tradingWss.handleUpgrade(req, socket, head, (ws) => this.onTradingSocket(ws));
      else if (path === "/ws/v1/market-data") this.marketWss.handleUpgrade(req, socket, head, (ws) => this.onMarketSocket(ws));
      else {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
      }
    });
  }

  // ---- lifecycle --------------------------------------------------------------------------------------------------

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.opts.port, this.opts.host, () => resolve());
    });
    this.port = (this.http.address() as AddressInfo).port;
    this.timers.push(setInterval(() => this.onBlock(), this.opts.blockTimeMs));
    this.timers.push(setInterval(() => this.onHeartbeat(), this.opts.heartbeatIntervalMs));
    if (this.opts.wsPingIntervalMs > 0) this.timers.push(setInterval(() => this.onWsPing(), this.opts.wsPingIntervalMs));
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const t of this.pending) clearTimeout(t);
    this.pending.clear();
    for (const c of this.tradingConns) {
      if (c.idleTimer) clearTimeout(c.idleTimer);
      c.ws.terminate();
    }
    for (const c of this.marketConns) c.ws.terminate();
    this.tradingConns.clear();
    this.marketConns.clear();
    this.tradingWss.close();
    this.marketWss.close();
    this.http.closeAllConnections?.();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  private later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.pending.delete(t);
      fn();
    }, ms);
    this.pending.add(t);
  }

  // ---- time, prices, ids ------------------------------------------------------------------------------------------

  private price(id: number): number {
    return this.series.get(id)?.price ?? 0;
  }
  private scaled(m: SimMarketDef, price: number): number {
    return Math.round(price * 10 ** m.priceDecimals);
  }
  private marketDef(id: number): SimMarketDef | undefined {
    return SIM_MARKETS.find((m) => m.id === id);
  }
  private at(): { b: number; t: number } {
    return { b: this.head, t: Date.now() };
  }
  private txHash(): string {
    let s = "0x";
    for (let i = 0; i < 8; i++) s += Math.floor(this.rand() * 2 ** 32).toString(16).padStart(8, "0");
    return s;
  }
  private latency(): number {
    const [lo, hi] = this.opts.latencyMs;
    return Math.round(lo + this.rand() * (hi - lo));
  }
  private walletFor(accountId: number): string {
    return "0x" + createHash("sha256").update(`sim-wallet-${accountId}`).digest("hex").slice(0, 40);
  }

  private onBlock(): void {
    this.head++;
    for (const m of SIM_MARKETS) this.series.get(m.id)?.step(this.opts.blockTimeMs / 1000);
    this.matchResting();
    // market data push
    if (this.marketConns.size > 0) {
      const d: Record<string, unknown> = {};
      for (const m of SIM_MARKETS) d[String(m.id)] = this.marketState(m);
      const frame = JSON.stringify({ mt: MsgType.MarketStateUpdate, sn: this.head, d });
      for (const c of this.marketConns) if (c.subs.has(`market-state@${this.opts.chainId}`)) this.safeSend(c.ws, frame);
    }
    // forget old nonces
    const cutoff = Date.now() - 120_000;
    for (const [k, t] of this.nonces) if (t < cutoff) this.nonces.delete(k);
  }

  private marketState(m: SimMarketDef): Record<string, unknown> {
    const p = this.price(m.id);
    const sp = p * 0.0001;
    const mrk = this.scaled(m, p);
    return {
      at: this.at(),
      orl: mrk,
      mrk,
      lst: this.scaled(m, p + (this.rand() - 0.5) * sp),
      mid: mrk,
      bid: this.scaled(m, p - sp / 2),
      ask: this.scaled(m, p + sp / 2),
      prv: this.scaled(m, this.marketOpen.get(m.id) ?? p),
      dv: 0,
      dva: "0",
      oi: 0,
      tvl: "0",
    };
  }

  private onHeartbeat(): void {
    const gap = this.takeFault(["heartbeat_gap"]);
    this.hbSeq += gap ? 2 : 1;
    const frame = JSON.stringify({ mt: MsgType.Heartbeat, sn: this.hbSeq, h: this.head });
    for (const c of this.tradingConns) if (c.authed) this.safeSend(c.ws, frame);
    for (const c of this.marketConns) {
      if (c.subs.has(`heartbeat@${this.opts.chainId}`)) this.safeSend(c.ws, JSON.stringify({ mt: MsgType.Heartbeat, sn: ++c.hbSn, h: this.head }));
    }
  }

  private onWsPing(): void {
    for (const c of this.tradingConns) {
      if (!c.alive) {
        c.ws.close(1008, "ping timeout");
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        // ignore
      }
    }
  }

  // ---- faults -----------------------------------------------------------------------------------------------------

  private takeFault<K extends SimFault["kind"]>(kinds: K[]): Extract<SimFault, { kind: K }> | undefined {
    const i = this.faults.findIndex((f) => (kinds as string[]).includes(f.kind));
    if (i < 0) return undefined;
    const f = this.faults[i] as SimFault & { count?: number };
    const left = (f.count ?? 1) - 1;
    if (left <= 0) this.faults.splice(i, 1);
    else f.count = left;
    return f as Extract<SimFault, { kind: K }>;
  }

  // ---- accounts and keys ------------------------------------------------------------------------------------------

  createAccount(o: { accountId?: number; balanceAusd?: number; forwarding?: boolean } = {}): number {
    const id = o.accountId ?? this.nextAccountId++;
    if (this.accounts.has(id)) return id;
    const bal = BigInt(Math.round((o.balanceAusd ?? this.opts.defaultBalanceAusd) * 1e6));
    this.accounts.set(id, {
      id,
      wallet: this.walletFor(id),
      fw: o.forwarding ?? true,
      fr: false,
      ft: 0,
      lfr: 0,
      balance: bal,
      locked: 0n,
      positions: new Map(),
      resting: new Map(),
      rqs: new Map(),
      orderHistory: [],
      fills: [],
      positionHistory: [],
      accountHistory: [],
      stats: { td: bal, tw: 0n, tv: 0n, tf: 0n, trp: 0n, tt: 0, wins: 0 },
    });
    return id;
  }

  enrollKey(publicKey: string | Uint8Array, accountId?: number, o: EnrollOptions = {}): { apiKey: string; accountId: number } {
    const id = this.createAccount(accountId !== undefined ? { accountId } : {});
    const apiKey = o.apiKey ?? "pk_sim_" + randomBytes(12).toString("base64url");
    this.keys.set(apiKey, { apiKey, publicKey: parseEd25519PublicKey(publicKey), accountId: id, trade: (o.scope ?? "trade") === "trade" });
    return { apiKey, accountId: id };
  }

  private accountEvent(acc: SimAccount, p: { et: number; m?: number; r?: number; o?: number; a: bigint; f?: bigint }): AccountEvent {
    const ev: AccountEvent = {
      at: { ...this.at(), tx: 0, l: 0 },
      in: SIM_INSTANCE_ID,
      id: acc.id,
      et: p.et,
      ...(p.m !== undefined ? { m: p.m } : {}),
      ...(p.r !== undefined ? { r: p.r } : {}),
      ...(p.o !== undefined ? { o: p.o } : {}),
      a: p.a.toString(),
      b: acc.balance.toString(),
      lb: acc.locked.toString(),
      f: (p.f ?? 0n).toString(),
    };
    acc.accountHistory.push(ev);
    return ev;
  }

  private accountMsg(acc: SimAccount, withEvents?: AccountEvent[]): Account & { mt: 21 } {
    return { mt: 21, in: SIM_INSTANCE_ID, id: acc.id, fr: acc.fr, fw: acc.fw, ft: acc.ft, lfr: acc.lfr, b: acc.balance.toString(), lb: acc.locked.toString(), ...(withEvents?.length ? { h: withEvents } : {}) };
  }

  private statsMsg(acc: SimAccount): AccountStats {
    const s = acc.stats;
    return { in: SIM_INSTANCE_ID, id: acc.id, td: s.td.toString(), tw: s.tw.toString(), tv: s.tv.toString(), tf: s.tf.toString(), trp: s.trp.toString(), wr: s.tt ? Math.round((s.wins / s.tt) * 10_000) : 0, tt: s.tt };
  }

  private positionMsg(p: SimPos, acc: SimAccount, extra: Partial<Position> = {}): Position {
    return {
      at: { ...this.at(), tx: 0, l: 0 },
      mkt: p.mkt,
      acc: acc.id,
      pid: p.pid,
      rq: p.rq,
      oid: p.oid,
      st: PositionStatus.Open,
      sr: PositionStatusReason.Opened,
      sd: p.sd,
      c: p.c.toString(),
      ep: p.ep,
      s: p.s,
      fee: p.fee.toString(),
      cfee: "0",
      efs: 0,
      lv: p.lv,
      xfs: 0,
      ots: { ...p.ots, tx: 0 },
      ...extra,
    };
  }

  setForwarding(accountId: number, allowed: boolean): void {
    const acc = this.accounts.get(accountId);
    if (!acc) return;
    acc.fw = allowed;
    this.broadcast(acc, [this.accountMsg(acc)]);
  }

  deposit(accountId: number, ausd: number): void {
    const acc = this.accounts.get(accountId);
    if (!acc) return;
    const a = BigInt(Math.round(ausd * 1e6));
    acc.balance += a;
    acc.stats.td += a;
    const ev = this.accountEvent(acc, { et: 1, a });
    this.broadcast(acc, [this.accountMsg(acc, [ev])]);
  }

  view(accountId: number): SimAccountView | undefined {
    const acc = this.accounts.get(accountId);
    if (!acc) return undefined;
    return {
      id: acc.id,
      wallet: acc.wallet,
      forwarding: acc.fw,
      lfr: acc.lfr,
      balanceAusd: Number(acc.balance) / 1e6,
      positions: [...acc.positions.values()].map((p) => ({
        marketId: p.mkt,
        symbol: this.marketDef(p.mkt)?.symbol ?? String(p.mkt),
        side: p.sd === 1 ? "long" : "short",
        lots: p.s,
        entryScaled: p.ep,
        collateralAusd: Number(p.c) / 1e6,
      })),
      realizedPnlAusd: Number(acc.stats.trp) / 1e6,
      trades: acc.stats.tt,
    };
  }

  // ---- sending helpers --------------------------------------------------------------------------------------------

  private safeSend(ws: WebSocket, data: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(data);
      } catch {
        // ignore
      }
    }
  }

  private broadcast(acc: SimAccount, frames: object[]): void {
    for (const c of this.tradingConns) {
      if (!c.authed || c.accountId !== acc.id) continue;
      for (const f of frames) this.safeSend(c.ws, JSON.stringify(f));
    }
  }

  // ---- trading socket ---------------------------------------------------------------------------------------------

  private onTradingSocket(ws: WebSocket): void {
    const conn: TradingConn = { ws, authed: false, keyScopeTrade: false, accountId: 0, wallet: "", times: [], idleTimer: undefined, alive: true };
    this.tradingConns.add(conn);
    conn.idleTimer = setTimeout(() => {
      if (!conn.authed) ws.close(1008, "idle timeout");
    }, this.opts.idleTimeoutMs);
    ws.on("pong", () => {
      conn.alive = true;
    });
    ws.on("close", () => {
      if (conn.idleTimer) clearTimeout(conn.idleTimer);
      this.tradingConns.delete(conn);
    });
    ws.on("error", () => {});
    ws.on("message", (raw) => this.onTradingMessage(conn, raw));
  }

  private rateLimited(times: number[]): boolean {
    const now = Date.now();
    times.push(now);
    while (times.length && now - (times[0] as number) > 60_000) times.shift();
    return times.length > this.opts.rateLimitPerMin;
  }

  private onTradingMessage(conn: TradingConn, raw: RawData): void {
    conn.alive = true;
    if (this.rateLimited(conn.times)) {
      conn.ws.close(1008, "too many requests");
      return;
    }
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw.toString());
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      msg = parsed as Record<string, unknown>;
    } catch {
      conn.ws.close(1011, "failed to process");
      return;
    }
    const mt = asNum(msg.mt);
    if (!conn.authed) {
      if (mt !== MsgType.ApiKeySignIn) {
        conn.ws.close(3401, "unauthorized");
        return;
      }
      this.signIn(conn, msg);
      return;
    }
    switch (mt) {
      case MsgType.Ping:
        this.safeSend(conn.ws, JSON.stringify({ mt: MsgType.Pong, t: msg.t }));
        return;
      case MsgType.OrderRequest:
        this.onOrderFrame(conn, msg);
        return;
      default:
        return; // ignored
    }
  }

  private signIn(conn: TradingConn, m: Record<string, unknown>): void {
    const key = typeof m.api_key === "string" ? this.keys.get(m.api_key) : undefined;
    const ts = typeof m.timestamp === "string" ? m.timestamp : "";
    const nonce = typeof m.nonce === "string" ? m.nonce : "";
    const sig = typeof m.signature === "string" ? m.signature : "";
    const fail = (why: string): void => {
      conn.ws.close(3401, "unauthorized");
      void why;
    };
    if (!key) return fail("unknown api key");
    if (asNum(m.chain_id) !== this.opts.chainId) return fail("wrong chain id");
    if (!/^\d+$/.test(ts) || Math.abs(Date.now() - Number(ts)) > 30_000) return fail("timestamp outside the 30 s window");
    if (!nonce || this.nonces.has(`${key.apiKey}:${nonce}`)) return fail("nonce replay");
    if (!verifySignature(key.publicKey, canonicalWsSignin(this.opts.chainId, ts, nonce), sig)) return fail("bad signature");
    this.nonces.set(`${key.apiKey}:${nonce}`, Date.now());
    const acc = this.accounts.get(key.accountId);
    if (!acc) return fail("no account");
    const open = [...this.tradingConns].filter((c) => c.authed && c.wallet === acc.wallet).length;
    if (open >= this.opts.maxConnectionsPerWallet) {
      conn.ws.close(1008, "too many connections");
      return;
    }
    conn.authed = true;
    conn.accountId = acc.id;
    conn.wallet = acc.wallet;
    conn.keyScopeTrade = key.trade;
    if (conn.idleTimer) clearTimeout(conn.idleTimer);
    const at = this.at();
    this.safeSend(conn.ws, JSON.stringify({ mt: MsgType.WalletSnapshot, sn: this.hbSeq, at, addr: acc.wallet, n: 0, fl: 0, as: [this.accountMsg(acc)], sts: [this.statsMsg(acc)] }));
    this.safeSend(conn.ws, JSON.stringify({ mt: MsgType.OrdersSnapshot, sn: this.hbSeq, at, d: this.openOrders(acc) }));
    this.safeSend(conn.ws, JSON.stringify({ mt: MsgType.PositionsSnapshot, sn: this.hbSeq, at, d: [...acc.positions.values()].map((p) => this.positionMsg(p, acc)) }));
  }

  private openOrders(acc: SimAccount): Order[] {
    return [...acc.resting.values()].map((r) => this.restingOrderMsg(acc, r, OrderStatus.Open, 35));
  }

  private restingOrderMsg(acc: SimAccount, r: Resting, st: number, sr: number): Order {
    return {
      at: { ...this.at(), tx: 0, l: 0 },
      c: { b: r.createdB, t: Date.now() },
      rq: r.rq,
      mkt: r.mkt,
      acc: acc.id,
      oid: r.oid,
      scid: r.oid,
      st,
      sr,
      t: r.t,
      r: false,
      p: r.p,
      os: r.lots,
      fp: 0,
      fs: r.lots - r.remaining,
      f: "0",
      fl: r.fl,
      mm: 0,
      lv: r.lv,
    };
  }

  // ---- order intake -----------------------------------------------------------------------------------------------

  private parseSpec(m: Record<string, unknown>): OrderSpec | undefined {
    const n = (k: string): number | undefined => asNum(m[k]);
    const rq = n("rq");
    const mkt = n("mkt");
    const acc = n("acc");
    const t = n("t");
    const s = n("s");
    const fl = n("fl");
    const lv = n("lv");
    const lb = n("lb");
    if (rq === undefined || mkt === undefined || acc === undefined || t === undefined || s === undefined || fl === undefined || lv === undefined || lb === undefined) return undefined;
    for (const k of ["rq", "mkt", "acc", "t", "s", "fl", "lv", "lb", "p", "ms", "tif", "oid", "mnp"]) {
      const v = m[k];
      if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < 0)) return undefined; // negative / fractional = unparseable (uint fields)
    }
    return {
      rq,
      mkt,
      acc,
      t,
      s,
      fl,
      lv,
      lb,
      ...(n("p") !== undefined ? { p: n("p") as number } : {}),
      ...(n("oid") !== undefined ? { oid: n("oid") as number } : {}),
      ...(n("ms") !== undefined ? { ms: n("ms") as number } : {}),
      ...(n("mnp") !== undefined ? { mnp: n("mnp") as number } : {}),
      ...(n("tif") !== undefined ? { tif: n("tif") as number } : {}),
      ...(typeof m.a === "string" ? { a: m.a } : {}),
    };
  }

  private onOrderFrame(conn: TradingConn, msg: Record<string, unknown>): void {
    this.orderFrames++;
    const spec = this.parseSpec(msg);
    const acc = this.accounts.get(conn.accountId);
    if (!spec || !acc || !this.marketDef(spec.mkt) || spec.acc !== acc.id) {
      conn.ws.close(1011, "failed to process"); // no mt:3
      return;
    }
    const sn = asNum(msg.sn);
    const closeFault = this.takeFault(["close_socket"]);
    if (closeFault) {
      conn.ws.close(closeFault.code, closeFault.reason ?? "injected close");
      return;
    }
    const verdict = this.admit(acc, conn.keyScopeTrade, spec, "ws");
    const statusFrame = (code: number, error: string): object => ({ mt: MsgType.StatusResponse, sid: 100, sn: ++this.statusSn, ...(sn ? { cid: sn } : {}), status: { code, error } });

    if (verdict.type === "reject") {
      this.safeSend(conn.ws, JSON.stringify(statusFrame(verdict.code, verdict.error)));
      return;
    }
    if (verdict.type === "dup") {
      this.safeSend(conn.ws, JSON.stringify(statusFrame(0, "")));
      if (verdict.rec.done && this.opts.replayOnDuplicate) {
        this.later(() => {
          for (const f of verdict.rec.frames) this.safeSend(conn.ws, JSON.stringify(f));
        }, 30);
      }
      return;
    }
    const fault = verdict.fault;
    if (fault?.kind === "disconnect_before_status") {
      if (fault.execute) this.later(() => this.finish(acc, spec, verdict.rec, fault), this.latency());
      else {
        // the frame never reached the exchange: forget the rq so a re-send is a fresh order
        acc.rqs.delete(spec.rq);
        acc.lfr = verdict.rec.prevLfr;
      }
      conn.ws.terminate();
      return;
    }
    const dropAck = fault?.kind === "drop_status" && (fault.which === "mt3" || fault.which === "all" || fault.which === undefined);
    if (!dropAck) this.later(() => this.safeSend(conn.ws, JSON.stringify(statusFrame(0, ""))), 5 + Math.floor(this.rand() * 15));
    const extra = fault?.kind === "delay" ? fault.ms : 0;
    this.later(() => this.finish(acc, spec, verdict.rec, fault), this.latency() + extra);
  }

  /** Gateway checks. Marks the rq as forwarded (`lfr`) when accepted. */
  private admit(acc: SimAccount, tradeScope: boolean, spec: OrderSpec, via: "ws" | "http"): Admit {
    if (!tradeScope) return { type: "reject", code: 403, error: "api key lacks trade scope" };
    const dup = acc.rqs.get(spec.rq);
    if (dup) return { type: "dup", rec: dup };
    const m = this.marketDef(spec.mkt) as SimMarketDef;
    if (spec.lb > 0 && spec.lb <= this.head) return { type: "reject", code: 400, error: "last exec block already expired" };
    if (spec.lb > 0 && spec.lb > this.head + m.ttlBlocks) return { type: "reject", code: 400, error: "last exec block too high" };
    if (spec.tif !== undefined && spec.tif > 0 && spec.tif <= this.head) return { type: "reject", code: 400, error: "order already expired" };
    if (spec.mnp !== undefined && spec.mnp > 65535) return { type: "reject", code: 400, error: "max negative pnl collateralization out of range" };
    if (spec.t < 1 || spec.t > 7) return { type: "reject", code: 400, error: "invalid order type" };
    if (via === "http" && spec.rq <= acc.lfr) return { type: "reject", code: 400, error: "request id below the last accepted for the account" };
    const fault = this.takeFault(["drop_status", "disconnect_before_status", "reject", "delay", "fill_before_order", "partial_fill", "no_liquidity"]);
    if (fault?.kind === "reject" && (fault.via ?? "order") === "status") {
      return { type: "reject", code: fault.httpCode ?? 400, error: fault.error ?? "injected rejection" };
    }
    const rec: OrderRec = { rq: spec.rq, done: false, frames: [], prevLfr: acc.lfr };
    const tooLow = spec.rq <= acc.lfr;
    if (!tooLow) acc.lfr = spec.rq;
    acc.rqs.set(spec.rq, rec);
    return { type: "ok", rec, ...(fault ? { fault } : {}), ...(tooLow ? { fault: { kind: "reject" as const, sr: 32, via: "order" as const } } : {}) };
  }

  /** Execute (or fail) an admitted order and deliver the results. */
  private finish(acc: SimAccount, spec: OrderSpec, rec: OrderRec, fault: SimFault | undefined): void {
    const m = this.marketDef(spec.mkt) as SimMarketDef;
    const failure = (sr: number, fr?: number): Order => this.failedOrder(acc, spec, sr, fr);
    let effects: Effects | undefined;
    let order: Order;
    if (fault?.kind === "reject") order = failure(fault.sr ?? 36, fault.fr);
    else if (!acc.fw) order = failure(34);
    else if (acc.fr) order = failure(2);
    else {
      const r = this.run(acc, m, spec, fault);
      if ("failed" in r) order = r.failed;
      else {
        effects = r;
        order = r.order;
      }
    }
    const frames: object[] = [{ mt: MsgType.OrdersUpdate, at: this.at(), d: [order] }];
    if (effects?.fills.length) {
      const f25 = { mt: MsgType.FillsUpdate, at: this.at(), d: effects.fills };
      if (fault?.kind === "fill_before_order") frames.unshift(f25);
      else frames.push(f25);
    }
    rec.frames = frames;
    rec.done = true;
    acc.orderHistory.push(order);

    const dropOrder = fault?.kind === "drop_status" && (fault.which === "mt24" || fault.which === "all" || fault.which === undefined);
    const out: object[] = dropOrder ? [] : [...frames];
    if (effects?.positions.length) out.push({ mt: MsgType.PositionsUpdate, at: this.at(), d: effects.positions });
    out.push(this.accountMsg(acc, effects?.events));
    this.broadcast(acc, out);
  }

  private failedOrder(acc: SimAccount, spec: OrderSpec, sr: number, fr?: number): Order {
    const oid = this.nextOid++;
    return {
      at: { ...this.at(), tx: 0, l: 0 },
      c: { b: this.head, t: Date.now() },
      rq: spec.rq,
      mkt: spec.mkt,
      acc: acc.id,
      oid,
      scid: oid,
      st: OrderStatus.Failed,
      sr,
      ...(fr ? { fr } : {}),
      t: spec.t,
      r: true,
      p: spec.p ?? 0,
      os: spec.s,
      fp: 0,
      fs: 0,
      f: "0",
      fl: spec.fl,
      mm: 0,
      lv: spec.lv,
    };
  }

  // ---- matching ---------------------------------------------------------------------------------------------------

  private notionalCns(lots: number, px: number, m: SimMarketDef): bigint {
    return (BigInt(lots) * BigInt(px) * CNS) / 10n ** BigInt(m.sizeDecimals + m.priceDecimals);
  }

  /** Run one order against the book. Returns effects, or `{failed}`. */
  private run(acc: SimAccount, m: SimMarketDef, spec: OrderSpec, fault: SimFault | undefined): Effects | { failed: Order } {
    switch (spec.t) {
      case OrderType.Cancel: {
        const r = spec.oid !== undefined ? acc.resting.get(spec.oid) : undefined;
        if (!r) return { failed: this.failedOrder(acc, spec, 33) };
        acc.resting.delete(r.oid);
        const order = { ...this.restingOrderMsg(acc, r, OrderStatus.Canceled, 28), r: true };
        return { order, fills: [], positions: [], events: [] };
      }
      case OrderType.IncreasePositionCollateral: {
        const pos = acc.positions.get(spec.mkt);
        const amt = BigInt(spec.a ?? "0");
        if (!pos || amt <= 0n || amt > acc.balance) return { failed: this.failedOrder(acc, spec, 36, 2) };
        acc.balance -= amt;
        pos.c += amt;
        const ev = this.accountEvent(acc, { et: 3, m: spec.mkt, r: spec.rq, a: -amt });
        const oid = this.nextOid++;
        const order: Order = { ...this.failedOrder(acc, spec, 0), oid, scid: oid, st: OrderStatus.Executed, sr: 0 };
        return { order, fills: [], positions: [this.positionMsg(pos, acc, { sr: PositionStatusReason.Increased })], events: [ev] };
      }
      case OrderType.Change: {
        const r = spec.oid !== undefined ? acc.resting.get(spec.oid) : undefined;
        if (!r) return { failed: this.failedOrder(acc, spec, 33) };
        if (spec.p) r.p = spec.p;
        if (spec.s) {
          r.remaining = Math.max(0, r.remaining + (spec.s - r.lots));
          r.lots = spec.s;
        }
        return { order: this.restingOrderMsg(acc, r, OrderStatus.Open, 31), fills: [], positions: [], events: [] };
      }
      default:
        return this.runTrade(acc, m, spec, fault);
    }
  }

  private runTrade(acc: SimAccount, m: SimMarketDef, spec: OrderSpec, fault: SimFault | undefined): Effects | { failed: Order } {
    if (!(spec.s > 0)) return { failed: this.failedOrder(acc, spec, 49) };
    const buy = spec.t === OrderType.OpenLong || spec.t === OrderType.CloseShort;
    const isClose = spec.t === OrderType.CloseLong || spec.t === OrderType.CloseShort;
    const mark = this.price(m.id);
    // skewed small adverse slippage 0..maxSlipBps
    const u = this.rand();
    const slipBps = this.opts.maxSlipBps * u * u * u;
    const px = this.scaled(m, mark * (1 + ((buy ? 1 : -1) * slipBps) / 10_000));
    const limit = spec.p ?? 0;
    const immediate = limit === 0 || (spec.fl & (OrderFlag.ImmediateOrCancel | OrderFlag.FillOrKill)) !== 0;
    const marketable = limit === 0 || (buy ? px <= limit : px >= limit);
    const slippageTooBig = (spec.ms ?? 0) > 0 && limit === 0 && slipBps > (spec.ms as number);
    const pos = acc.positions.get(spec.mkt);

    if (isClose) {
      const wantSd = spec.t === OrderType.CloseLong ? 1 : 2;
      if (!pos || pos.sd !== wantSd) return { failed: this.failedOrder(acc, spec, 44, 4) };
    }

    if (fault?.kind === "no_liquidity" || slippageTooBig || (!marketable && immediate)) {
      const order = this.orderMsg(acc, spec, { st: OrderStatus.Canceled, sr: 16, fs: 0, fp: 0, f: 0n, txid: this.txHash(), remove: true });
      return { order, fills: [], positions: [], events: [] };
    }
    if (!marketable) {
      // rest on the book as a maker order
      const oid = this.nextOid++;
      const r: Resting = { oid, rq: spec.rq, mkt: spec.mkt, t: spec.t, p: limit, lots: spec.s, remaining: spec.s, lv: spec.lv, fl: spec.fl, createdB: this.head };
      acc.resting.set(oid, r);
      return { order: this.restingOrderMsg(acc, r, OrderStatus.Open, 35), fills: [], positions: [], events: [] };
    }

    let lots = spec.s;
    if (isClose && pos) lots = Math.min(lots, pos.s);
    let partial = false;
    if (fault?.kind === "partial_fill") {
      lots = Math.max(1, Math.floor(lots * fault.fraction));
      partial = lots < spec.s;
    }
    const fillPx = limit > 0 ? (buy ? Math.min(px, limit) : Math.max(px, limit)) : px;
    const res = this.fill(acc, m, { spec, lots, px: fillPx, taker: true, oid: this.nextOid++ });
    if ("failed" in res) return res;
    if (partial) {
      res.order = { ...res.order, st: OrderStatus.Canceled, sr: 16, r: true };
    }
    return res;
  }

  private orderMsg(acc: SimAccount, spec: OrderSpec, o: { st: number; sr: number; fs: number; fp: number; f: bigint; txid: string; remove: boolean; oid?: number }): Order {
    const oid = o.oid ?? this.nextOid++;
    return {
      at: { ...this.at(), tx: 0, txid: o.txid, l: 0 },
      c: { b: this.head, t: Date.now(), tx: 0, txid: o.txid },
      rq: spec.rq,
      mkt: spec.mkt,
      acc: acc.id,
      oid,
      scid: oid,
      st: o.st,
      sr: o.sr,
      t: spec.t,
      r: o.remove,
      p: spec.p ?? 0,
      os: spec.s,
      fp: o.fp,
      fs: o.fs,
      f: o.f.toString(),
      fl: spec.fl,
      mm: 0,
      lv: spec.lv,
    };
  }

  /** Apply a fill to the account / position, return the protocol messages. */
  private fill(acc: SimAccount, m: SimMarketDef, f: { spec: OrderSpec; lots: number; px: number; taker: boolean; oid: number }): Effects | { failed: Order } {
    const { spec, px } = f;
    const txid = this.txHash();
    const micros = f.taker ? m.takerFeeMicros : m.makerFeeMicros;
    const fills: Fill[] = [];
    const positions: Position[] = [];
    const events: AccountEvent[] = [];
    let lots = f.lots;
    let totalFee = 0n;
    const opening = spec.t === OrderType.OpenLong || spec.t === OrderType.OpenShort;
    const sd: 1 | 2 = spec.t === OrderType.OpenLong || spec.t === OrderType.CloseLong ? 1 : 2;
    const pos = acc.positions.get(spec.mkt);
    const logTs = { ...this.at(), tx: 0, txid, l: 0 };

    // 1) reduce an opposite position (a close order, or an open that crosses through flat)
    let closeLots = 0;
    if (pos && pos.sd !== sd && opening) closeLots = Math.min(lots, pos.s);
    if (!opening) closeLots = Math.min(lots, pos?.s ?? 0);
    if (!opening && closeLots === 0) return { failed: this.failedOrder(acc, spec, 44, 4) };

    if (pos && closeLots > 0) {
      const dir = BigInt(pos.sd === 1 ? 1 : -1);
      const dpnl = (BigInt(px - pos.ep) * dir * BigInt(closeLots) * CNS) / 10n ** BigInt(m.sizeDecimals + m.priceDecimals);
      const notional = this.notionalCns(closeLots, px, m);
      const cfee = (notional * BigInt(micros) + 500_000n) / 1_000_000n;
      const cShare = (pos.c * BigInt(closeLots)) / BigInt(pos.s);
      const feeShare = (pos.fee * BigInt(closeLots)) / BigInt(pos.s);
      let released = cShare + dpnl - cfee;
      if (released < 0n) released = 0n;
      acc.balance += released;
      const net = dpnl - feeShare - cfee;
      acc.stats.trp += net;
      acc.stats.tt += 1;
      if (net > 0n) acc.stats.wins += 1;
      acc.stats.tv += notional;
      acc.stats.tf += cfee;
      totalFee += cfee;
      const remaining = pos.s - closeLots;
      const full = remaining === 0;
      const ev = this.positionMsg(pos, acc, {
        at: logTs,
        rq: spec.rq,
        oid: f.oid,
        st: full ? PositionStatus.Closed : PositionStatus.Open,
        sr: full ? PositionStatusReason.Closed : PositionStatusReason.Decreased,
        s: closeLots,
        c: cShare.toString(),
        fee: (feeShare + cfee).toString(),
        cfee: cfee.toString(),
        dpnl: dpnl.toString(),
        fnd: "0",
        xp: px,
      });
      pos.s = remaining;
      pos.c -= cShare;
      pos.fee -= feeShare;
      if (full) acc.positions.delete(spec.mkt);
      const upd = this.positionMsg(pos, acc, { at: logTs, rq: spec.rq, oid: f.oid, st: full ? PositionStatus.Closed : PositionStatus.Open, sr: full ? PositionStatusReason.Closed : PositionStatusReason.Decreased, dpnl: dpnl.toString(), fnd: "0", xp: px, cfee: cfee.toString(), fee: (feeShare + cfee).toString(), e: [ev] });
      positions.push(upd);
      acc.positionHistory.push(ev);
      events.push(this.accountEvent(acc, { et: 4, m: spec.mkt, r: spec.rq, o: f.oid, a: released - cShare, f: cfee }));
      fills.push({ at: logTs, mkt: spec.mkt, acc: acc.id, oid: f.oid, t: spec.t, l: f.taker ? 2 : 1, p: px, s: closeLots, f: cfee.toString() });
      lots -= closeLots;
    }

    // 2) open (or add to) a position with whatever is left
    if (opening && lots > 0) {
      const notional = this.notionalCns(lots, px, m);
      const margin = (notional * 100n) / BigInt(Math.max(100, spec.lv));
      const fee = (notional * BigInt(micros) + 500_000n) / 1_000_000n;
      if (acc.balance < margin + fee) {
        if (fills.length === 0) return { failed: this.failedOrder(acc, spec, f.taker ? 44 : 23, 1) };
      } else {
        acc.balance -= margin + fee;
        acc.stats.tv += notional;
        acc.stats.tf += fee;
        totalFee += fee;
        const cur = acc.positions.get(spec.mkt);
        let p: SimPos;
        let sr: number;
        if (cur && cur.sd === sd) {
          const newS = cur.s + lots;
          cur.ep = Math.round((cur.ep * cur.s + px * lots) / newS);
          cur.s = newS;
          cur.c += margin;
          cur.fee += fee;
          cur.lv = spec.lv;
          cur.rq = spec.rq;
          cur.oid = f.oid;
          p = cur;
          sr = PositionStatusReason.Increased;
        } else {
          p = { pid: this.nextPid++, mkt: spec.mkt, sd, s: lots, ep: px, c: margin, fee, lv: spec.lv, rq: spec.rq, oid: f.oid, ots: { b: this.head, t: Date.now(), txid } };
          acc.positions.set(spec.mkt, p);
          sr = closeLots > 0 ? PositionStatusReason.Inverted : PositionStatusReason.Opened;
        }
        const ev = this.positionMsg(p, acc, { at: logTs, rq: spec.rq, oid: f.oid, sr, s: lots, ep: px, c: margin.toString(), fee: fee.toString(), cfee: "0" });
        positions.push(this.positionMsg(p, acc, { at: logTs, rq: spec.rq, oid: f.oid, sr, e: [ev] }));
        acc.positionHistory.push(ev);
        events.push(this.accountEvent(acc, { et: 4, m: spec.mkt, r: spec.rq, o: f.oid, a: -(margin + fee), f: fee }));
        fills.push({ at: logTs, mkt: spec.mkt, acc: acc.id, oid: f.oid, t: spec.t, l: f.taker ? 2 : 1, p: px, s: lots, f: fee.toString() });
      }
    }

    const filledLots = fills.reduce((a, x) => a + x.s, 0);
    if (filledLots === 0) return { failed: this.failedOrder(acc, spec, f.taker ? 44 : 23, 1) };
    for (const x of fills) acc.fills.push(x);
    this.executed.push({ accountId: acc.id, rq: spec.rq, marketId: spec.mkt, type: spec.t, oid: f.oid, filledLots, priceScaled: px, atMs: Date.now(), txHash: txid });
    const full = filledLots >= spec.s;
    const order = this.orderMsg(acc, spec, {
      st: full ? OrderStatus.Filled : OrderStatus.Canceled,
      sr: full ? (f.taker ? 43 : 22) : 16,
      fs: filledLots,
      fp: px,
      f: totalFee,
      txid,
      remove: true,
      oid: f.oid,
    });
    for (const x of fills) x.at = { ...x.at, txid };
    return { order, fills, positions, events };
  }

  /** On every block: fill resting limit orders the market has crossed. */
  private matchResting(): void {
    for (const acc of this.accounts.values()) {
      if (acc.resting.size === 0) continue;
      for (const r of [...acc.resting.values()]) {
        const m = this.marketDef(r.mkt) as SimMarketDef;
        const buy = r.t === OrderType.OpenLong || r.t === OrderType.CloseShort;
        const px = this.scaled(m, this.price(m.id));
        if (buy ? px > r.p : px < r.p) continue;
        const spec: OrderSpec = { rq: r.rq, mkt: r.mkt, acc: acc.id, t: r.t, p: r.p, s: r.remaining, fl: r.fl, lv: r.lv, lb: 0 };
        acc.resting.delete(r.oid);
        const res = this.fill(acc, m, { spec, lots: r.remaining, px: r.p, taker: false, oid: r.oid });
        if ("failed" in res) {
          acc.orderHistory.push(res.failed);
          this.broadcast(acc, [{ mt: MsgType.OrdersUpdate, at: this.at(), d: [{ ...res.failed, sr: 23 }] }, this.accountMsg(acc)]);
          continue;
        }
        acc.orderHistory.push(res.order);
        this.broadcast(acc, [
          { mt: MsgType.OrdersUpdate, at: this.at(), d: [res.order] },
          { mt: MsgType.FillsUpdate, at: this.at(), d: res.fills },
          ...(res.positions.length ? [{ mt: MsgType.PositionsUpdate, at: this.at(), d: res.positions }] : []),
          this.accountMsg(acc, res.events),
        ]);
      }
    }
  }

  // ---- market data socket -----------------------------------------------------------------------------------------

  private onMarketSocket(ws: WebSocket): void {
    const conn: MarketConn = { ws, times: [], subs: new Set(), hbSn: 5000 };
    this.marketConns.add(conn);
    ws.on("close", () => this.marketConns.delete(conn));
    ws.on("error", () => {});
    ws.on("message", (raw) => {
      if (this.rateLimitedMd(conn)) {
        ws.close(1008, "too many requests");
        return;
      }
      let msg: { mt?: number; subs?: Array<{ stream?: string; subscribe?: boolean }> };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.close(1011, "failed to process");
        return;
      }
      if (msg.mt !== MsgType.SubscriptionRequest || !Array.isArray(msg.subs)) return;
      const out: Array<{ stream: string; sid?: number; status?: { code: number; error?: string } }> = [];
      for (const s of msg.subs) {
        const stream = String(s.stream ?? "");
        if (s.subscribe === false) {
          conn.subs.delete(stream);
          out.push({ stream, status: { code: 0 } });
          continue;
        }
        const known = new RegExp(`^(heartbeat|gas-stats|market-config|market-state|funding)@${this.opts.chainId}$`).test(stream);
        if (!known) out.push({ stream, status: { code: 404, error: "unknown stream" } });
        else if (conn.subs.size >= 16) out.push({ stream, status: { code: 429, error: "too many subscriptions" } });
        else {
          conn.subs.add(stream);
          out.push({ stream, sid: 200 + conn.subs.size, status: { code: 0 } });
        }
      }
      this.safeSend(ws, JSON.stringify({ mt: MsgType.SubscriptionResponse, subs: out }));
    });
  }

  private rateLimitedMd(c: MarketConn): boolean {
    const now = Date.now();
    c.times.push(now);
    while (c.times.length && now - (c.times[0] as number) > 60_000) c.times.shift();
    return c.times.length > 10;
  }

  // ---- HTTP -------------------------------------------------------------------------------------------------------

  private json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
    return Buffer.concat(chunks).toString("utf8");
  }

  private authHttp(req: IncomingMessage, method: string, target: string, body: string): { key: SimKey; acc: SimAccount } | { error: number; message: string } {
    const h = (n: string): string | undefined => {
      const v = req.headers[n.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };
    const apiKey = h("x-api-key");
    const ts = h("x-api-timestamp");
    const nonce = h("x-api-nonce");
    const sig = h("x-api-signature");
    if (!apiKey || !ts || !nonce || !sig) return { error: 401, message: "missing X-API-* headers" };
    const key = this.keys.get(apiKey);
    if (!key) return { error: 401, message: "unknown api key" };
    if (!/^\d+$/.test(ts) || Math.abs(Date.now() - Number(ts)) > 30_000) return { error: 401, message: "timestamp outside the 30 s window" };
    if (this.nonces.has(`${apiKey}:${nonce}`)) return { error: 401, message: "nonce replay" };
    const canonical = canonicalRest({ chainId: this.opts.chainId, method, target, timestamp: ts, nonce, body });
    if (!verifySignature(key.publicKey, canonical, sig)) return { error: 401, message: "bad signature" };
    this.nonces.set(`${apiKey}:${nonce}`, Date.now());
    const acc = this.accounts.get(key.accountId);
    if (!acc) return { error: 404, message: "no exchange account" };
    return { key, acc };
  }

  private page<T>(items: T[], url: URL): { d: T[]; np?: string } {
    const count = Math.max(1, Math.min(100, Number(url.searchParams.get("count") ?? 50)));
    const offset = Number(url.searchParams.get("page") ?? 0) || 0;
    const newestFirst = [...items].reverse();
    const d = newestFirst.slice(offset, offset + count);
    const next = offset + count;
    return { d, ...(next < newestFirst.length ? { np: String(next) } : {}) };
  }

  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const method = (req.method ?? "GET").toUpperCase();
    if (!url.pathname.startsWith("/api/")) return this.json(res, 404, { error: "not found" });
    const target = url.pathname.slice(4) + url.search; // `/v1/...?query`, the signed request-target
    const path = url.pathname.slice(4);
    if (this.opts.geoBlocked) return this.json(res, 451, { error: "unavailable for legal reasons" });
    const body = method === "POST" ? await this.readBody(req) : "";

    // public
    if (method === "GET" && path === "/v1/pub/context") {
      const prices = new Map<number, number>();
      for (const m of SIM_MARKETS) prices.set(m.id, this.price(m.id));
      return this.json(res, 200, buildContext({ chainId: this.opts.chainId, head: this.head, nowMs: Date.now(), geoBlock: this.opts.geoBlock, prices }));
    }
    if (method === "GET" && path === "/v1/market-data/ticker") {
      const d: Record<string, unknown> = {};
      for (const m of SIM_MARKETS) d[String(m.id)] = this.marketState(m);
      return this.json(res, 200, { mt: 9, sn: this.head, d });
    }
    let mm = /^\/v1\/market-data\/(\d+)\/ticker$/.exec(path);
    if (method === "GET" && mm) {
      const m = this.marketDef(Number(mm[1]));
      if (!m) return this.json(res, 400, { error: "unknown market" });
      return this.json(res, 200, { mt: 9, sn: this.head, d: { [String(m.id)]: this.marketState(m) } });
    }
    mm = /^\/v1\/market-data\/(\d+)\/book$/.exec(path);
    if (method === "GET" && mm) {
      const m = this.marketDef(Number(mm[1]));
      if (!m) return this.json(res, 400, { error: "unknown market" });
      const levels = Math.max(1, Math.min(100, Number(url.searchParams.get("levels") ?? 10)));
      const mid = this.price(m.id);
      const step = Math.max(10 ** -m.priceDecimals, mid * 0.0001);
      const lvl = (dir: number) => Array.from({ length: levels }, (_, i) => ({ p: this.scaled(m, mid + dir * step * (i + 1)), s: 10 ** m.sizeDecimals, o: 1 }));
      return this.json(res, 200, { mt: 15, sn: this.head, at: this.at(), bid: lvl(-1), ask: lvl(1) });
    }

    // signed
    if (path.startsWith("/v1/trading/")) {
      const auth = this.authHttp(req, method, target, body);
      if ("error" in auth) return this.json(res, auth.error, { error: auth.message });
      const { key, acc } = auth;
      const at = this.at();
      if (method === "GET") {
        switch (path) {
          case "/v1/trading/wallet":
            return this.json(res, 200, { mt: 19, sn: this.head, at, addr: acc.wallet, n: 0, fl: 0, as: [this.accountMsg(acc)], sts: [this.statsMsg(acc)] });
          case "/v1/trading/orders":
            return this.json(res, 200, { mt: 23, sn: this.head, at, d: this.openOrders(acc) });
          case "/v1/trading/positions":
            return this.json(res, 200, { mt: 26, sn: this.head, at, d: [...acc.positions.values()].map((p) => this.positionMsg(p, acc)) });
          case "/v1/trading/fills":
            return this.json(res, 200, this.page(acc.fills, url));
          case "/v1/trading/order-history":
            return this.json(res, 200, this.page(acc.orderHistory, url));
          case "/v1/trading/position-history":
            return this.json(res, 200, this.page(acc.positionHistory, url));
          case "/v1/trading/account-history":
            return this.json(res, 200, this.page(acc.accountHistory, url));
          default:
            return this.json(res, 404, { error: "not found" });
        }
      }
      if (method === "POST" && path === "/v1/trading/orders") return this.postOrders(res, body, key, acc);
    }
    return this.json(res, 404, { error: "not found" });
  }

  private postOrders(res: ServerResponse, body: string, key: SimKey, acc: SimAccount): void {
    let parsed: { sn?: number; d?: unknown[] };
    try {
      parsed = JSON.parse(body);
    } catch {
      return this.json(res, 400, { mt: 31, status: { code: 400, error: "malformed body" } });
    }
    const list = Array.isArray(parsed.d) ? parsed.d : [];
    if (list.length < 1 || list.length > 100) return this.json(res, 400, { mt: 31, status: { code: 400, error: "1-100 orders required" } });
    if (!key.trade) return this.json(res, 403, { mt: 31, status: { code: 403, error: "api key lacks trade scope" } });
    const statuses = list.map((raw) => {
      const spec = typeof raw === "object" && raw !== null ? this.parseSpec(raw as Record<string, unknown>) : undefined;
      if (!spec || !this.marketDef(spec.mkt)) return { code: 400, error: "unknown market or malformed order" };
      if (spec.acc !== acc.id) return { code: 403, error: "invalid account" };
      const v = this.admit(acc, key.trade, spec, "http");
      if (v.type === "reject") return { code: v.code, error: v.error };
      if (v.type === "ok") this.later(() => this.finish(acc, spec, v.rec, v.fault), this.latency());
      return { code: 0 };
    });
    this.json(res, 200, { mt: 31, ...(parsed.sn ? { cid: parsed.sn } : {}), status: { code: 0 }, statuses });
  }

  // ---- public views -----------------------------------------------------------------------------------------------

  api(): PerplSimulator {
    const base = `http://${this.opts.host}:${this.port}`;
    return {
      url: `${base}/api`,
      wsUrl: `ws://${this.opts.host}:${this.port}`,
      port: this.port,
      chainId: this.opts.chainId,
      stop: () => this.stop(),
      enrollKey: (pub, accountId, o) => this.enrollKey(pub, accountId, o),
      enrollNewKey: (o = {}) => {
        const { signer, seedHex } = Ed25519Signer.generate();
        const id = this.createAccount({ ...(o.accountId !== undefined ? { accountId: o.accountId } : {}), ...(o.balanceAusd !== undefined ? { balanceAusd: o.balanceAusd } : {}), ...(o.forwarding !== undefined ? { forwarding: o.forwarding } : {}) });
        const { apiKey } = this.enrollKey(signer.publicKey, id, { ...(o.apiKey ? { apiKey: o.apiKey } : {}), ...(o.scope ? { scope: o.scope } : {}) });
        return { apiKey, apiSecret: seedHex, publicKeyHex: signer.publicKeyHex, accountId: id, signer };
      },
      createAccount: (o) => this.createAccount(o),
      setForwarding: (id, allowed) => this.setForwarding(id, allowed),
      deposit: (id, ausd) => this.deposit(id, ausd),
      inject: (f) => {
        this.faults.push({ ...f });
      },
      clearFaults: () => {
        this.faults = [];
      },
      pendingFaults: () => [...this.faults],
      setPrice: (symbol, price) => {
        const m = SIM_MARKETS.find((x) => x.symbol === symbol.toUpperCase());
        if (m) this.series.get(m.id)?.set(price);
      },
      getPrice: (symbol) => {
        const m = SIM_MARKETS.find((x) => x.symbol === symbol.toUpperCase());
        return m ? this.price(m.id) : NaN;
      },
      blockNumber: () => this.head,
      account: (id) => this.view(id),
      executedOrders: () => [...this.executed],
      tradingConnections: () => [...this.tradingConns].filter((c) => c.authed).length,
      dropConnections: (code, reason) => {
        for (const c of this.tradingConns) {
          if (code === undefined) c.ws.terminate();
          else c.ws.close(code, reason ?? "dropped");
        }
      },
      receivedOrderFrames: () => this.orderFrames,
    };
  }
}

/** Start the simulator. Resolves once the HTTP + WebSocket server is listening. */
export async function startPerplSimulator(opts: SimOptions = {}): Promise<PerplSimulator> {
  const sim = new Simulator(opts);
  await sim.listen();
  return sim.api();
}
