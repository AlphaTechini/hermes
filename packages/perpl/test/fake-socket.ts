import { NotConnectedError, type OrderSocket, type TradingSocketEvents } from "../src/trading-ws";
import type { Account, Fill, Order } from "../src/protocol";
import type { MarketSpec } from "../src/scaling";

type Fn = (p: never) => void;

/** In-memory OrderSocket for driving the tracker deterministically. */
export class FakeSocket implements OrderSocket {
  sn = 0;
  ready = true;
  head: number | undefined = 100;
  heartbeatsSeen = true;
  epoch = 1;
  sent: Array<Record<string, unknown>> = [];
  sendError: Error | undefined;
  private listeners = new Map<string, Set<Fn>>();

  nextSn(): number {
    return ++this.sn;
  }
  isReady(): boolean {
    return this.ready;
  }
  async send(frame: object): Promise<void> {
    if (!this.ready) throw new NotConnectedError();
    if (this.sendError) throw this.sendError;
    this.sent.push(frame as Record<string, unknown>);
  }
  on<K extends keyof TradingSocketEvents>(event: K, fn: (p: TradingSocketEvents[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn as unknown as Fn);
    return () => set?.delete(fn as unknown as Fn);
  }
  emit<K extends keyof TradingSocketEvents>(event: K, payload: TradingSocketEvents[K]): void {
    for (const fn of [...(this.listeners.get(event) ?? [])]) (fn as unknown as (p: unknown) => void)(payload);
  }

  // ---- helpers ----
  orders(...d: Order[]): void {
    this.emit("orders", { snapshot: false, frame: { mt: 24, d } });
  }
  fills(...d: Fill[]): void {
    this.emit("fills", { mt: 25, d });
  }
  status(cid: number | undefined, code: number, error = ""): void {
    this.emit("status", { mt: 3, sid: 100, sn: 9000 + this.sent.length, ...(cid !== undefined ? { cid } : {}), status: { code, error } });
  }
  heartbeat(h: number): void {
    this.head = h;
    this.emit("heartbeat", { mt: 100, sn: h, h });
  }
  disconnect(code = 1006): void {
    this.ready = false;
    this.emit("disconnected", { code, reason: "", epoch: this.epoch, wasReady: true, willReconnect: true });
  }
  reconnect(accounts: Account[] = []): void {
    this.ready = true;
    this.epoch++;
    this.emit("connected", { epoch: this.epoch, attempt: 0, wallet: { mt: 19, as: accounts } });
  }
  lastFrame(): Record<string, unknown> {
    return this.sent[this.sent.length - 1] as Record<string, unknown>;
  }
}

export const BTC: MarketSpec = {
  id: 16,
  symbol: "BTC",
  name: "Bitcoin",
  instanceId: 12,
  perpetualId: 16,
  priceDecimals: 1,
  sizeDecimals: 5,
  maxLeverageHdths: 1500,
  maintenanceMarginHdths: 2000,
  orderTtlBlocks: 20,
  orderRetryBlocks: 4,
  maxSlippageBps: 1000,
  maxNegPnlCollatBps: 1000,
  isOpen: true,
  makerFeesMicros: [45],
  takerFeesMicros: [345],
  makerFeeMicros: 45,
  takerFeeMicros: 345,
  recycleFee: "100000",
  fundingIntervalBlocks: 9000,
};

export const ACCOUNT: Account = { in: 12, id: 4321, fr: false, fw: true, ft: 0, lfr: 1000, b: "10000000000", lb: "0" };

export function order(o: Partial<Order> & { rq: number }): Order {
  return {
    at: { b: 105, t: Date.now() },
    mkt: 16,
    acc: 4321,
    oid: 77,
    scid: 77,
    st: 4,
    sr: 43,
    t: 1,
    r: true,
    p: 0,
    os: 100,
    fp: 1120005,
    fs: 100,
    f: "386",
    fl: 4,
    mm: 0,
    lv: 300,
    ...o,
  };
}

export function fill(o: Partial<Fill> = {}): Fill {
  return { at: { b: 105, t: Date.now(), tx: 1, txid: "0x" + "ab".repeat(32), l: 0 }, mkt: 16, acc: 4321, oid: 77, t: 1, l: 2, p: 1120005, s: 100, f: "386", ...o };
}
