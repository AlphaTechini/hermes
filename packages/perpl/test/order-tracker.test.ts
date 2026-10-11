import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrderTracker, selectAccountForMarket, type OrderIntent, type OrderLifecycleHandlers, type OrderTrackerOptions } from "../src/order-tracker";
import { OrderFlag, OrderType } from "../src/protocol";
import { RateLimitedError } from "../src/trading-ws";
import { ACCOUNT, BTC, FakeSocket, fill, order } from "./fake-socket";

const MARKET_ORDER: OrderIntent = { marketId: 16, type: OrderType.OpenLong, size: 100, price: 0, flags: OrderFlag.ImmediateOrCancel, leverage: 300, maxSlippageBps: 50 };

interface Rig {
  sock: FakeSocket;
  tracker: OrderTracker;
  advances: Array<[number, number]>;
  events: string[];
  handlers: OrderLifecycleHandlers;
  warnings: Array<[string, Record<string, unknown>]>;
}

function rig(opts: Partial<OrderTrackerOptions> = {}, accounts = [ACCOUNT]): Rig {
  const sock = new FakeSocket();
  const advances: Array<[number, number]> = [];
  const events: string[] = [];
  const warnings: Array<[string, Record<string, unknown>]> = [];
  const tracker = new OrderTracker({
    socket: sock,
    getMarket: (id) => (id === 16 ? BTC : undefined),
    onRqAdvance: (rq, acc) => {
      advances.push([rq, acc]);
      events.push(`advance:${rq}`);
    },
    onWarning: (c, d) => warnings.push([c, d]),
    ...opts,
  });
  sock.emit("walletSnapshot", { mt: 19, sn: 1, as: accounts });
  const handlers: OrderLifecycleHandlers = {
    sent: (e) => events.push(`sent:${e.rq}:${e.kind}`),
    accepted: (e) => events.push(`accepted:${e.source}`),
    partially_filled: (e) => events.push(`partial:${e.size}`),
    filled: (e) => events.push(`filled:${e.size}@${e.price}`),
    failed: (e) => events.push(`failed:${e.code}`),
    timeout: (e) => events.push(`timeout:${e.ambiguous ? "ambiguous" : "clean"}`),
    retry: (e) => events.push(`retry:${e.oldRq}`),
  };
  return { sock, tracker, advances, events, handlers, warnings };
}

const flush = async (ms = 1): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers({ now: 1_789_000_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("rq allocation", () => {
  it("seeds from lfr, is strictly increasing, and persists BEFORE sending", async () => {
    const r = rig();
    void r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    void r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    void r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    expect(r.sock.sent.map((f) => f.rq)).toEqual([1001, 1002, 1003]);
    expect(r.advances).toEqual([[1001, 4321], [1002, 4321], [1003, 4321]]);
    // persistence hook ran before the matching `sent`
    expect(r.events.indexOf("advance:1001")).toBeLessThan(r.events.indexOf("sent:1001:initial"));
    expect(r.events.indexOf("advance:1002")).toBeLessThan(r.events.indexOf("sent:1002:initial"));
    r.tracker.dispose();
  });

  it("a persisted high-water mark above lfr wins", async () => {
    const r = rig({ initialRq: 5000 });
    void r.tracker.placeOrder(MARKET_ORDER);
    await flush();
    expect(r.sock.lastFrame().rq).toBe(5001);
    r.tracker.dispose();
  });

  it("an lfr that moved (mt:21 from another client) is respected", async () => {
    const r = rig();
    r.sock.emit("account", { ...ACCOUNT, lfr: 9000 });
    void r.tracker.placeOrder(MARKET_ORDER);
    await flush();
    expect(r.sock.lastFrame().rq).toBe(9001);
    r.tracker.dispose();
  });

  it("frames carry unique non-zero sn and the Desk market order shape", async () => {
    const r = rig();
    void r.tracker.placeOrder(MARKET_ORDER);
    void r.tracker.placeOrder(MARKET_ORDER);
    await flush();
    const [a, b] = r.sock.sent;
    expect(a).toEqual({ mt: 22, sn: 1, rq: 1001, mkt: 16, acc: 4321, t: 1, p: 0, s: 100, ms: 50, fl: 4, lv: 300, lb: 0 });
    expect((b as { sn: number }).sn).toBe(2);
    r.tracker.dispose();
  });

  it("re-submitting an in-flight rq re-sends the SAME rq and returns the same promise", async () => {
    const r = rig();
    const p1 = r.tracker.placeOrder(MARKET_ORDER);
    await flush();
    const p2 = r.tracker.placeOrder({ ...MARKET_ORDER, rq: 1001 });
    await flush();
    expect(p2).toBe(p1);
    expect(r.sock.sent.map((f) => f.rq)).toEqual([1001, 1001]);
    expect(r.advances).toHaveLength(1);
    r.tracker.dispose();
  });
});

describe("account selection", () => {
  it("picks the account whose instance equals the market instance_id, not as[0]", async () => {
    const other = { ...ACCOUNT, id: 1, in: 99 };
    const r = rig({}, [other, ACCOUNT]);
    void r.tracker.placeOrder(MARKET_ORDER);
    await flush();
    expect(r.sock.lastFrame().acc).toBe(4321);
    expect(selectAccountForMarket([other, ACCOUNT], BTC)?.id).toBe(4321);
    expect(selectAccountForMarket([other], BTC)).toBeUndefined();
    r.tracker.dispose();
  });

  it("no account on the instance fails without sending (a foreign acc would close the socket with 1011)", async () => {
    const r = rig({}, [{ ...ACCOUNT, in: 99 }]);
    const out = await r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    expect(out.status).toBe("failed");
    expect(out.failure?.code).toBe("no_account");
    expect(r.sock.sent).toHaveLength(0);
    expect(r.events).toContain("failed:no_account");
    r.tracker.dispose();
  });

  it("unknown market and disabled forwarding fail early", async () => {
    const r = rig({}, [{ ...ACCOUNT, fw: false }]);
    const a = await r.tracker.placeOrder({ ...MARKET_ORDER, marketId: 999 });
    expect(a.failure?.code).toBe("unknown_market");
    const b = await r.tracker.placeOrder(MARKET_ORDER);
    expect(b.failure?.code).toBe("forwarding_disabled");
    expect(b.failure?.message).toMatch(/allowOrderForwarding/);
    expect(r.sock.sent).toHaveLength(0);
    r.tracker.dispose();
  });

  it("validation failures never consume an rq", async () => {
    const r = rig();
    const bad = await r.tracker.placeOrder({ ...MARKET_ORDER, leverage: 5000 });
    expect(bad.failure?.code).toBe("invalid_order");
    expect(bad.failure?.message).toMatch(/exceeds the market maximum 15x/);
    expect(r.advances).toHaveLength(0);
    r.tracker.dispose();
  });
});

describe("happy path lifecycle", () => {
  it("sent -> accepted(mt:3) -> mt:24 + mt:25 -> filled", async () => {
    const r = rig();
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.status(1, 0);
    expect(r.events).toContain("accepted:status");
    r.sock.orders(order({ rq: 1001 }));
    r.sock.fills(fill());
    const out = await p;
    expect(out.status).toBe("filled");
    expect(out).toMatchObject({ rq: 1001, sn: 1, orderId: 77, accountId: 4321, attempts: 1, sends: 1, filledSize: 0.001, requestedSize: 0.001 });
    expect(out.avgPrice).toBeCloseTo(112000.5, 6);
    expect(out.feeUsd).toBeCloseTo(0.000386, 9);
    expect(out.txHashes).toEqual(["0x" + "ab".repeat(32)]);
    expect(out.fills[0]).toMatchObject({ price: 112000.5, size: 0.001, block: 105, liquidity: "taker", txHash: "0x" + "ab".repeat(32) });
    expect(r.events.filter((e) => e.startsWith("filled"))).toEqual(["filled:0.001@112000.5"]);
    expect(r.events.filter((e) => e.startsWith("accepted"))).toEqual(["accepted:status", "accepted:order"]);
    expect(r.events[r.events.length - 1]).toBe("filled:0.001@112000.5");
    r.tracker.dispose();
  });

  it("mt:25 before mt:24 is buffered by oid", async () => {
    const r = rig();
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.fills(fill());
    r.sock.orders(order({ rq: 1001 }));
    const out = await p;
    expect(out.status).toBe("filled");
    expect(out.fills).toHaveLength(1);
    r.tracker.dispose();
  });

  it("accepted fires from mt:24 when the mt:3 ack was lost", async () => {
    const r = rig();
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.orders(order({ rq: 1001 }));
    r.sock.fills(fill());
    await p;
    expect(r.events).toContain("accepted:order");
    r.tracker.dispose();
  });

  it("duplicate fills and duplicate mt:24 are ignored", async () => {
    const r = rig();
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.orders(order({ rq: 1001 }), order({ rq: 1001 }));
    r.sock.fills(fill(), fill());
    const out = await p;
    expect(out.fills).toHaveLength(1);
    expect(out.filledSize).toBe(0.001);
    r.sock.orders(order({ rq: 1001 }));
    r.sock.fills(fill());
    expect(out.fills).toHaveLength(1);
    r.tracker.dispose();
  });

  it("a terminal Filled without mt:25 is completed from the order aggregate after the grace period (synthetic fill)", async () => {
    const r = rig();
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.orders(order({ rq: 1001, at: { b: 105, t: Date.now(), txid: "0x" + "ab".repeat(32) } }));
    let done = false;
    void p.then(() => (done = true));
    await flush(1000);
    expect(done).toBe(false);
    await flush(600);
    const out = await p;
    expect(out.status).toBe("filled");
    expect(out.fills).toHaveLength(1);
    expect(out.fills[0]?.synthetic).toBe(true);
    expect(out.fills[0]?.price).toBeCloseTo(112000.5, 6);
    expect(out.txHashes).toEqual(["0x" + "ab".repeat(32)]);
    r.tracker.dispose();
  });

  it("fills in several pieces: partially_filled then filled", async () => {
    const r = rig();
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.orders(order({ rq: 1001, fs: 100, fp: 1120010 }));
    r.sock.fills(fill({ s: 60, p: 1120000, f: "200" }));
    r.sock.fills(fill({ s: 40, p: 1120020, f: "186", at: { b: 105, t: 1, tx: 2, l: 1, txid: "0x" + "cd".repeat(32) } }));
    const out = await p;
    expect(r.events.filter((e) => e.startsWith("partial") || e.startsWith("filled"))).toEqual(["partial:0.0006", "filled:0.0004@112002"]);
    expect(out.filledSize).toBe(0.001);
    expect(out.avgPrice).toBeCloseTo((112000 * 0.0006 + 112002 * 0.0004) / 0.001, 6);
    expect(out.txHashes).toHaveLength(2);
    r.tracker.dispose();
  });
});

describe("failures", () => {
  it("mt:3 non-zero code is terminal: no retry, readable reason", async () => {
    const r = rig();
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.status(1, 403, "api key lacks trade scope");
    const out = await p;
    expect(out.status).toBe("failed");
    expect(out.failure).toMatchObject({ source: "status", code: "403", httpCode: 403 });
    expect(out.failure?.message).toMatch(/forbidden.*lacks trade scope/);
    await flush(5000);
    expect(r.sock.sent).toHaveLength(1);
    expect(r.advances).toHaveLength(1);
    r.tracker.dispose();
  });

  it("mt:3 400 (bad request) is terminal", async () => {
    const r = rig();
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.status(1, 400, "order already expired");
    expect((await p).failure?.code).toBe("400");
    r.tracker.dispose();
  });

  it("mt:24 st 7 sr 34 -> failed with the forwarding explanation", async () => {
    const r = rig();
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.status(1, 0);
    r.sock.orders(order({ rq: 1001, st: 7, sr: 34, fs: 0, fp: 0, f: "0" }));
    const out = await p;
    expect(out.status).toBe("failed");
    expect(out.failure).toMatchObject({ source: "order", code: "sr:34", st: 7, sr: 34 });
    expect(out.failure?.message).toMatch(/allowOrderForwarding/);
    expect(r.events).toContain("failed:sr:34");
    r.tracker.dispose();
  });

  it("settlement failure carries fr in the message", async () => {
    const r = rig();
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.orders(order({ rq: 1001, st: 7, sr: 44, fr: 1, fs: 0, fp: 0, f: "0" }));
    const out = await p;
    expect(out.failure).toMatchObject({ code: "sr:44", fr: 1 });
    expect(out.failure?.message).toMatch(/balance is below the collateral/);
    r.tracker.dispose();
  });

  it("only the first failure counts and later messages for a failed rq change nothing", async () => {
    const r = rig();
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.orders(order({ rq: 1001, st: 7, sr: 44, fr: 1, fs: 0 }), order({ rq: 1001, st: 7, sr: 36, fs: 0 }));
    const out = await p;
    expect(out.failure?.code).toBe("sr:44");
    expect(r.events.filter((e) => e.startsWith("failed"))).toHaveLength(1);
    r.tracker.dispose();
  });

  it("a failure arriving after a definitive non-failure is ignored (dedupe rule)", async () => {
    const r = rig();
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.orders(order({ rq: 1001 }), order({ rq: 1001, st: 7, sr: 36, fs: 0 }));
    r.sock.fills(fill());
    const out = await p;
    expect(out.status).toBe("filled");
    expect(out.failure).toBeUndefined();
    r.tracker.dispose();
  });

  it("IOC with zero fill (Canceled sr 16) is reported as failed/unfilled", async () => {
    const r = rig();
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.orders(order({ rq: 1001, st: 5, sr: 16, fs: 0, fp: 0, f: "0" }));
    const out = await p;
    expect(out.status).toBe("failed");
    expect(out.failure).toMatchObject({ source: "unfilled", code: "sr:16" });
    r.tracker.dispose();
  });

  it("IOC partial fill then cancel: partially_filled", async () => {
    const r = rig();
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.orders(order({ rq: 1001, st: 5, sr: 16, fs: 40, os: 100 }));
    r.sock.fills(fill({ s: 40, f: "154" }));
    const out = await p;
    expect(out.status).toBe("partially_filled");
    expect(out.filledSize).toBe(0.0004);
    expect(r.events.some((e) => e.startsWith("filled:"))).toBe(false);
    expect(r.events.some((e) => e.startsWith("partial:"))).toBe(true);
    r.tracker.dispose();
  });

  it("IOC stuck in PartiallyFilled settles after iocSettleMs", async () => {
    const r = rig();
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.orders(order({ rq: 1001, st: 3, sr: 0, fs: 40, r: false }));
    r.sock.fills(fill({ s: 40 }));
    await flush(3300);
    expect((await p).status).toBe("partially_filled");
    r.tracker.dispose();
  });

  it("a rate limited FIRST send fails safely (nothing reached the wire)", async () => {
    const r = rig();
    r.sock.sendError = new RateLimitedError(4000);
    const out = await r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    expect(out.failure?.code).toBe("rate_limited");
    r.tracker.dispose();
  });
});

describe("retries: SAME rq", () => {
  it("no ack within the ack timeout -> the same rq is re-sent (new sn), at-most-once safe", async () => {
    const r = rig();
    void r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    expect(r.sock.sent).toHaveLength(1);
    await flush(2600);
    expect(r.sock.sent.map((f) => [f.rq, f.sn])).toEqual([[1001, 1], [1001, 2]]);
    await flush(2600);
    expect(r.sock.sent.map((f) => f.rq)).toEqual([1001, 1001, 1001]);
    expect(r.advances).toHaveLength(1); // no new rq was allocated
    r.tracker.dispose();
  });

  it("an ack stops re-sending", async () => {
    const r = rig();
    void r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.status(1, 0);
    await flush(6000);
    expect(r.sock.sent).toHaveLength(1);
    r.tracker.dispose();
  });

  it("re-sends are capped at maxResends", async () => {
    const r = rig({ maxResends: 2, maxWaitMs: 120_000 });
    void r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    await flush(10_000);
    expect(r.sock.sent).toHaveLength(3);
    r.tracker.dispose();
  });

  it("disconnect before any status: after reconnect the same rq is re-sent once, before lb expiry", async () => {
    const r = rig();
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    expect(r.sock.sent).toHaveLength(1);
    r.sock.disconnect(1006);
    await flush(500);
    r.sock.reconnect([ACCOUNT]);
    await flush();
    expect(r.sock.sent.map((f) => f.rq)).toEqual([1001, 1001]);
    expect(r.advances).toHaveLength(1);
    expect(r.events.filter((e) => e.startsWith("sent"))).toEqual(["sent:1001:initial", "sent:1001:resend"]);
    r.sock.status(2, 0);
    r.sock.orders(order({ rq: 1001 }));
    r.sock.fills(fill());
    const out = await p;
    expect(out.status).toBe("filled");
    expect(out.sends).toBe(2);
    expect(out.attempts).toBe(1);
    r.tracker.dispose();
  });

  it("an order placed while disconnected waits for the socket and is sent once", async () => {
    const r = rig();
    r.sock.ready = false;
    void r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush(2000);
    expect(r.sock.sent).toHaveLength(0);
    r.sock.reconnect([ACCOUNT]);
    await flush();
    expect(r.sock.sent.map((f) => f.rq)).toEqual([1001]);
    r.tracker.dispose();
  });

  it("not connected within connectWaitMs: failed, never sent", async () => {
    const r = rig({ connectWaitMs: 3000 });
    r.sock.ready = false;
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush(3100);
    const out = await p;
    expect(out.failure?.code).toBe("not_connected");
    expect(r.sock.sent).toHaveLength(0);
    r.tracker.dispose();
  });

  it("socket closed with 1011 once: re-send same rq; twice: failed socket_closed_1011", async () => {
    const r = rig();
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.disconnect(1011);
    r.sock.reconnect([ACCOUNT]);
    await flush();
    expect(r.sock.sent.map((f) => f.rq)).toEqual([1001, 1001]);
    r.sock.disconnect(1011);
    const out = await p;
    expect(out.status).toBe("failed");
    expect(out.failure?.code).toBe("socket_closed_1011");
    r.tracker.dispose();
  });
});

describe("retries: NEW rq", () => {
  it("mt:24 sr 32 (OrderDescIdTooLow) -> exactly ONE retry with a fresh rq after re-reading lfr", async () => {
    const refresh = vi.fn(async () => [{ ...ACCOUNT, lfr: 2000 }]);
    const r = rig({ refreshAccounts: refresh });
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.status(1, 0);
    r.sock.orders(order({ rq: 1001, st: 7, sr: 32, fs: 0, fp: 0, f: "0" }));
    await flush(400);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(r.sock.sent.map((f) => f.rq)).toEqual([1001, 2001]);
    expect(r.events).toContain("retry:1001");
    // the late failure of the retired rq is ignored
    r.sock.orders(order({ rq: 1001, st: 7, sr: 32, fs: 0 }));
    r.sock.status(2, 0);
    r.sock.orders(order({ rq: 2001 }));
    r.sock.fills(fill());
    const out = await p;
    expect(out.status).toBe("filled");
    expect(out.rqs).toEqual([1001, 2001]);
    expect(out.attempts).toBe(2);
    expect(r.advances.map((a) => a[0])).toEqual([1001, 2001]);
    r.tracker.dispose();
  });

  it("a second sr 32 is NOT retried again", async () => {
    const r = rig();
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.orders(order({ rq: 1001, st: 7, sr: 32, fs: 0 }));
    await flush(400);
    r.sock.orders(order({ rq: 1002, st: 7, sr: 32, fs: 0 }));
    const out = await p;
    expect(out.status).toBe("failed");
    expect(out.failure?.code).toBe("sr:32");
    expect(r.sock.sent).toHaveLength(2);
    r.tracker.dispose();
  });

  it("mt:3 503 (retryable failure status) -> new rq", async () => {
    const r = rig();
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.status(1, 503, "order submission is backed up");
    await flush(400);
    expect(r.sock.sent.map((f) => f.rq)).toEqual([1001, 1002]);
    r.sock.orders(order({ rq: 1002 }));
    r.sock.fills(fill());
    expect((await p).status).toBe("filled");
    r.tracker.dispose();
  });

  it("head >= lb with no status and no reconnect -> new rq (window = sentHead + ttl + margin)", async () => {
    const r = rig();
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    // sentHead 100, ttl 20, margin 5 => expiry block 125
    r.sock.heartbeat(124);
    await flush(400);
    expect(r.sock.sent.map((f) => f.rq)).toEqual([1001]);
    r.sock.heartbeat(125);
    await flush(400);
    expect(r.sock.sent.map((f) => f.rq)).toEqual([1001, 1002]);
    expect(r.events).toContain("retry:1001");
    // the old rq turning out to have executed is flagged loudly
    r.sock.orders(order({ rq: 1001, oid: 5 }));
    expect(r.warnings.map((w) => w[0])).toContain("retired_rq_became_active");
    // late failure of the old rq is silent
    const before = r.warnings.length;
    r.sock.orders(order({ rq: 1001, st: 7, sr: 14 }));
    expect(r.warnings).toHaveLength(before);
    r.sock.orders(order({ rq: 1002 }));
    r.sock.fills(fill());
    expect((await p).status).toBe("filled");
    r.tracker.dispose();
  });

  it("explicit lb from the intent is the expiry", async () => {
    const r = rig();
    void r.tracker.placeOrder({ ...MARKET_ORDER, lastExecBlock: 110 }, r.handlers);
    await flush();
    expect(r.sock.lastFrame().lb).toBe(110);
    r.sock.heartbeat(110);
    await flush(400);
    expect(r.sock.sent.map((f) => f.rq)).toEqual([1001, 1002]);
    r.tracker.dispose();
  });

  it("without heartbeats, wall-clock expiry is used", async () => {
    const r = rig({ ackTimeoutMs: 100_000 });
    r.sock.heartbeatsSeen = false;
    r.sock.head = undefined;
    void r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    // (20 + 5) * 500 ms + 2 s = 14.5 s
    await flush(14_000);
    expect(new Set(r.sock.sent.map((f) => f.rq))).toEqual(new Set([1001]));
    await flush(1500);
    expect(r.sock.sent.map((f) => f.rq)).toContain(1002);
    r.tracker.dispose();
  });

  it("gives up after maxAttempts", async () => {
    const r = rig({ maxAttempts: 2 });
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.status(1, 503);
    await flush(400);
    r.sock.status(2, 503);
    const out = await p;
    expect(out.status).toBe("failed");
    expect(out.failure?.code).toBe("503");
    r.tracker.dispose();
  });
});

describe("after a reconnect the outcome is ambiguous: never a blind new rq", () => {
  async function ambiguous(opts: Partial<OrderTrackerOptions>) {
    const r = rig(opts);
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.disconnect(1006);
    await flush(200);
    r.sock.head = 100;
    r.sock.reconnect([ACCOUNT]);
    await flush();
    expect(r.sock.sent.map((f) => f.rq)).toEqual([1001, 1001]);
    return { r, p };
  }

  it("no reconcile hook: timeout (ambiguous), no new rq", async () => {
    const { r, p } = await ambiguous({});
    r.sock.heartbeat(130);
    await flush(400);
    const out = await p;
    expect(out.status).toBe("timeout");
    expect(out.ambiguous).toBe(true);
    expect(out.timeout?.reason).toMatch(/reconcile through REST/);
    expect(r.sock.sent.map((f) => f.rq)).toEqual([1001, 1001]);
    expect(r.advances).toHaveLength(1);
    expect(r.events).toContain("timeout:ambiguous");
    r.tracker.dispose();
  });

  it("reconcile finds the order: its status is applied", async () => {
    const reconcile = vi.fn(async () => [order({ rq: 1001 })]);
    const { r, p } = await ambiguous({ reconcile });
    r.sock.heartbeat(130);
    await flush(400);
    r.sock.fills(fill());
    const out = await p;
    expect(reconcile).toHaveBeenCalledWith(1001, 4321);
    expect(out.status).toBe("filled");
    expect(r.sock.sent.map((f) => f.rq)).toEqual([1001, 1001]);
    r.tracker.dispose();
  });

  it("reconcile proves Perpl has no record: a new rq is safe", async () => {
    const reconcile = vi.fn(async () => []);
    const { r, p } = await ambiguous({ reconcile });
    r.sock.heartbeat(130);
    await flush(800);
    expect(r.sock.sent.map((f) => f.rq)).toEqual([1001, 1001, 1002]);
    r.sock.orders(order({ rq: 1002 }));
    r.sock.fills(fill());
    const out = await p;
    expect(out.status).toBe("filled");
    expect(out.rqs).toEqual([1001, 1002]);
    r.tracker.dispose();
  });

  it("reconcile unavailable (returns null / throws): timeout, no new rq", async () => {
    const reconcile = vi.fn(async () => {
      throw new Error("503");
    });
    const { r, p } = await ambiguous({ reconcile });
    r.sock.heartbeat(130);
    await flush(400);
    expect((await p).status).toBe("timeout");
    expect(r.sock.sent).toHaveLength(2);
    r.tracker.dispose();
  });

  it("reconnect after the window already expired reconciles immediately", async () => {
    const reconcile = vi.fn(async () => [] as never[]);
    const r = rig({ reconcile });
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.disconnect(1006);
    r.sock.head = 200; // far past the window by the time we are back
    r.sock.reconnect([ACCOUNT]);
    await flush(400);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(r.sock.sent.map((f) => f.rq)).toEqual([1001, 1002]);
    r.sock.orders(order({ rq: 1002 }));
    r.sock.fills(fill());
    expect((await p).status).toBe("filled");
    r.tracker.dispose();
  });
});

describe("dispose", () => {
  it("settles in-flight orders instead of leaving the promise hanging", async () => {
    const r = rig();
    const sent = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush();
    r.sock.ready = false;
    const queued = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    r.tracker.dispose();
    const a = await sent;
    expect(a.status).toBe("timeout");
    expect(a.ambiguous).toBe(true);
    const b = await queued;
    expect(b.status).toBe("failed");
    expect(b.failure?.code).toBe("client_closed");
    await expect(r.tracker.placeOrder(MARKET_ORDER)).rejects.toThrow(/disposed/);
  });
});

describe("overall deadline", () => {
  it("times out when nothing at all comes back (clean when never reconnected)", async () => {
    const r = rig({ maxWaitMs: 5000, retryOnExpiry: false, ackTimeoutMs: 100_000 });
    const p = r.tracker.placeOrder(MARKET_ORDER, r.handlers);
    await flush(5400);
    const out = await p;
    expect(out.status).toBe("timeout");
    expect(r.events.some((e) => e.startsWith("timeout"))).toBe(true);
    r.tracker.dispose();
  });
});

describe("resting orders and cancels", () => {
  const LIMIT: OrderIntent = { marketId: 16, type: OrderType.OpenLong, size: 100, price: 1100000, flags: OrderFlag.GoodTillCancel, leverage: 300 };

  it("a limit order resolves as `open` and keeps streaming fills", async () => {
    const r = rig();
    const p = r.tracker.placeOrder(LIMIT, r.handlers);
    await flush();
    expect(r.sock.lastFrame()).toMatchObject({ p: 1100000, fl: 0 });
    expect("ms" in r.sock.lastFrame()).toBe(false);
    r.sock.orders(order({ rq: 1001, st: 2, sr: 35, fs: 0, fp: 0, f: "0", r: false, p: 1100000, oid: 9 }));
    const out = await p;
    expect(out.status).toBe("open");
    expect(out.orderId).toBe(9);
    // later: filled
    r.sock.orders(order({ rq: 1001, st: 4, sr: 22, oid: 9, p: 1100000 }));
    r.sock.fills(fill({ oid: 9, l: 1, p: 1100000 }));
    await flush();
    expect(r.events.filter((e) => e.startsWith("filled"))).toEqual(["filled:0.001@110000"]);
    expect(r.tracker.activeCount()).toBe(0);
    r.tracker.dispose();
  });

  it("cancel: type 5 frame, resolves cancelled on the target's Canceled update", async () => {
    const r = rig();
    const p = r.tracker.placeOrder({ marketId: 16, type: OrderType.Cancel, size: 0, orderId: 9, flags: 0, leverage: 0 }, r.handlers);
    await flush();
    expect(r.sock.lastFrame()).toEqual({ mt: 22, sn: 1, rq: 1001, mkt: 16, acc: 4321, oid: 9, t: 5, s: 0, fl: 0, lv: 0, lb: 0 });
    r.sock.status(1, 0);
    r.sock.orders(order({ rq: 1000, oid: 9, st: 5, sr: 28, fs: 0, t: 1 }));
    expect((await p).status).toBe("cancelled");
    r.tracker.dispose();
  });

  it("cancel of an unknown order fails (sr 33)", async () => {
    const r = rig();
    const p = r.tracker.placeOrder({ marketId: 16, type: OrderType.Cancel, size: 0, orderId: 9, flags: 0, leverage: 0 }, r.handlers);
    await flush();
    r.sock.orders(order({ rq: 1001, st: 7, sr: 33, fs: 0, oid: 0 }));
    const out = await p;
    expect(out.status).toBe("failed");
    expect(out.failure?.code).toBe("sr:33");
    r.tracker.dispose();
  });
});
