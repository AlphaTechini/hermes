import { MsgType, type PerplTradingSocket } from "@hermes/perpl";
import { hiresNowMs } from "@hermes/shared";
import type { Repos } from "../db/repos";

/**
 * Records the raw Perpl frames of every order into `order_frames`.
 *
 *  - OUT: the exact mt:22 frame (rq, sn, lb, every field) handed to the trading socket, with the time it was written.
 *    Captured by wrapping `socket.send` on the live trading socket of the user's client, so it is the frame the
 *    tracker really built, not a reconstruction.
 *  - IN: the mt:3 status frames (matched through `cid` = our `sn`), the mt:24 order updates (matched through `rq`) and
 *    the mt:25 fills (they carry no `rq`, so they are matched through `oid`, learned from mt:24), each with its
 *    receive time. The socket de-duplicates mt:3, so replays are not stored twice. A mt:24 / mt:25 frame that carries
 *    several orders is stored once per order, reduced to that order's entries in `d`.
 *  - The executor tells us which Hermes order a (rq, sn) belongs to via {@link bindOrder} when its `sent` callback
 *    fires. Frames that arrive before that are held for up to a minute and flushed on bind.
 *  - mt:22 -> mt:3 round trips feed `onRtt`, which the registry turns into the Perpl latency shown in the top bar.
 */
export class OrderFrameRecorder {
  private readonly users = new Map<string, UserState>();

  constructor(
    private readonly repos: Repos,
    private readonly onRtt?: (userId: string, ms: number) => void,
    private readonly now: () => number = hiresNowMs,
  ) {}

  /** Start recording `socket` for `userId`. Returns a function that stops it. */
  attach(userId: string, socket: PerplTradingSocket): () => void {
    const st = this.state(userId);
    const orig = socket.send.bind(socket) as (frame: object, opts?: { maxWaitMs?: number }) => Promise<void>;
    (socket as { send: typeof orig }).send = async (frame, opts) => {
      await orig(frame, opts);
      try {
        this.onOut(st, frame as Record<string, unknown>);
      } catch {
        /* recording must never break trading */
      }
    };
    const guard = <T>(fn: (p: T) => void) => (p: T): void => {
      try {
        fn(p);
      } catch {
        /* recording must never break trading */
      }
    };
    const offs = [
      socket.on("status", guard((s: Record<string, unknown>) => this.onStatus(st, s))),
      socket.on("orders", guard(({ snapshot, frame }: { snapshot: boolean; frame: Record<string, unknown> }) => { if (!snapshot) this.onOrders(st, frame); })),
      socket.on("fills", guard((f: Record<string, unknown>) => this.onFills(st, f))),
    ];
    return () => {
      for (const off of offs) off();
      delete (socket as { send?: unknown }).send; // back to the prototype method
    };
  }

  /** The executor placed Hermes order `orderId` under (rq, sn): flush what is already known and route what follows. */
  bindOrder(userId: string, orderId: string, ids: { rq?: number | undefined; sn?: number | undefined }): void {
    const st = this.state(userId);
    if (ids.rq !== undefined) st.rqToOrder.set(ids.rq, orderId);
    if (ids.sn !== undefined && ids.rq !== undefined) st.snToRq.set(ids.sn, ids.rq);
    this.flush(st);
    prune(st.rqToOrder);
  }

  private state(userId: string): UserState {
    let st = this.users.get(userId);
    if (!st) {
      st = { userId, snToRq: new Map(), sendAt: new Map(), oidToRq: new Map(), rqToOrder: new Map(), pending: [] };
      this.users.set(userId, st);
    }
    return st;
  }

  private onOut(st: UserState, frame: Record<string, unknown>): void {
    if (frame.mt !== MsgType.OrderRequest) return;
    const at = this.now();
    const rq = Number(frame.rq);
    const sn = Number(frame.sn);
    if (Number.isFinite(sn) && Number.isFinite(rq)) st.snToRq.set(sn, rq);
    if (Number.isFinite(sn)) st.sendAt.set(sn, at);
    prune(st.snToRq);
    prune(st.sendAt);
    this.record(st, { rq, direction: "out", mt: 22, atMs: at, json: JSON.stringify(frame) });
  }

  private onStatus(st: UserState, s: Record<string, unknown>): void {
    const at = this.now();
    const cid = typeof s.cid === "number" ? s.cid : undefined;
    if (cid === undefined) return;
    const sent = st.sendAt.get(cid);
    if (sent !== undefined) {
      st.sendAt.delete(cid);
      if (this.onRtt) this.onRtt(st.userId, Math.max(0, at - sent));
    }
    this.record(st, { cid, direction: "in", mt: 3, atMs: at, json: JSON.stringify(s) });
  }

  private onOrders(st: UserState, frame: Record<string, unknown>): void {
    const d = Array.isArray(frame.d) ? (frame.d as Array<Record<string, unknown>>) : [];
    const at = this.now();
    const byRq = new Map<number, Array<Record<string, unknown>>>();
    for (const o of d) {
      const rq = Number(o.rq);
      const oid = Number(o.oid);
      if (!Number.isFinite(rq) || rq <= 0) continue;
      if (Number.isFinite(oid) && oid > 0) st.oidToRq.set(oid, rq);
      byRq.set(rq, [...(byRq.get(rq) ?? []), o]);
    }
    prune(st.oidToRq);
    for (const [rq, entries] of byRq) {
      this.record(st, { rq, direction: "in", mt: 24, atMs: at, json: JSON.stringify({ ...frame, d: entries }) });
    }
    this.flush(st); // fills that arrived before their mt:24 can be routed now
  }

  private onFills(st: UserState, f: Record<string, unknown>): void {
    const d = Array.isArray(f.d) ? (f.d as Array<Record<string, unknown>>) : [];
    const at = this.now();
    const byOid = new Map<number, Array<Record<string, unknown>>>();
    for (const fill of d) {
      const oid = Number(fill.oid);
      if (!Number.isFinite(oid)) continue;
      byOid.set(oid, [...(byOid.get(oid) ?? []), fill]);
    }
    for (const [oid, entries] of byOid) {
      this.record(st, { oid, direction: "in", mt: 25, atMs: at, json: JSON.stringify({ ...f, d: entries }) });
    }
  }

  private record(st: UserState, p: Pending): void {
    if (!this.tryStore(st, p)) {
      st.pending.push(p);
      if (st.pending.length > 500) st.pending.splice(0, st.pending.length - 500);
    }
  }

  private flush(st: UserState): void {
    if (st.pending.length === 0) return;
    const cutoff = this.now() - 60_000;
    const keep: Pending[] = [];
    for (const p of st.pending) {
      if (this.tryStore(st, p)) continue;
      if (p.atMs >= cutoff) keep.push(p);
    }
    st.pending = keep;
  }

  private tryStore(st: UserState, p: Pending): boolean {
    const rq = p.rq ?? (p.cid !== undefined ? st.snToRq.get(p.cid) : undefined) ?? (p.oid !== undefined ? st.oidToRq.get(p.oid) : undefined);
    if (rq === undefined) return false;
    const orderId = st.rqToOrder.get(rq);
    if (!orderId) return false;
    this.repos.orderFrames.insert({ orderId, direction: p.direction, mt: p.mt, atMs: p.atMs, json: p.json });
    return true;
  }
}

interface Pending {
  rq?: number;
  cid?: number;
  oid?: number;
  direction: "out" | "in";
  mt: number;
  atMs: number;
  json: string;
}

interface UserState {
  userId: string;
  snToRq: Map<number, number>;
  sendAt: Map<number, number>;
  oidToRq: Map<number, number>;
  rqToOrder: Map<number, string>;
  pending: Pending[];
}

function prune<K, V>(m: Map<K, V>, max = 2000): void {
  while (m.size > max) {
    const first = m.keys().next();
    if (first.done) return;
    m.delete(first.value);
  }
}
