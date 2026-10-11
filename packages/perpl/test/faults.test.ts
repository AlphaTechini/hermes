import { afterEach, describe, expect, it } from "vitest";
import { HASH, startRig, waitFor, type Rig } from "./helpers";

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

const OPEN = { market: "BTC", side: "long", kind: "open", sizeBase: 0.002, leverage: 2 } as const;

describe("fault injection: same rq, no double execution", () => {
  it("disconnect before any status (order NOT executed): reconnect, same rq re-sent, executes exactly once", async () => {
    rig = await startRig();
    const { client, sim } = rig;
    sim.inject({ kind: "disconnect_before_status", execute: false });
    const out = await client.placeMarketOrder(OPEN);
    expect(out.status).toBe("filled");
    expect(out.rqs).toEqual([1]); // never a new rq
    expect(out.attempts).toBe(1);
    expect(out.sends).toBe(2); // original + same-rq re-send after the reconnect
    expect(sim.receivedOrderFrames()).toBe(2);
    expect(sim.executedOrders()).toHaveLength(1);
    expect(rig.rqLog).toEqual([1]);
    const p = await client.getPositions();
    expect(p).toHaveLength(1);
    expect(p[0]?.size).toBe(0.002);
    expect(out.txHashes[0]).toMatch(HASH);
  });

  it("disconnect before status but the order DID execute: the re-sent rq replays the result, no double fill", async () => {
    rig = await startRig({ sim: { latencyMs: [150, 200] } });
    const { client, sim } = rig;
    sim.inject({ kind: "disconnect_before_status", execute: true });
    const out = await client.placeMarketOrder(OPEN);
    expect(out.status).toBe("filled");
    expect(out.rqs).toEqual([1]);
    expect(sim.executedOrders()).toHaveLength(1);
    expect(sim.account(rig.key.accountId)?.positions[0]?.lots).toBe(200); // 0.002 BTC, not 0.004
    expect(out.filledSize).toBe(0.002);
    expect((await client.getPositions())[0]?.size).toBe(0.002);
  });

  it("statuses dropped entirely (order executed): ack timeout re-sends the same rq, replay completes it", async () => {
    rig = await startRig();
    const { client, sim } = rig;
    sim.inject({ kind: "drop_status", which: "all", execute: true });
    const out = await client.placeMarketOrder(OPEN);
    expect(out.status).toBe("filled");
    expect(out.rqs).toEqual([1]);
    expect(out.sends).toBeGreaterThanOrEqual(2);
    expect(sim.executedOrders()).toHaveLength(1);
    expect((await client.getPositions())[0]?.size).toBe(0.002);
  });

  it("only the mt:3 ack dropped: the order still completes from mt:24 and is not re-sent after it", async () => {
    rig = await startRig();
    const { client, sim } = rig;
    sim.inject({ kind: "drop_status", which: "mt3" });
    const accepted: string[] = [];
    const out = await client.placeMarketOrder({ ...OPEN, handlers: { accepted: (e) => accepted.push(e.source) } });
    expect(out.status).toBe("filled");
    expect(accepted).toEqual(["order"]);
    expect(sim.executedOrders()).toHaveLength(1);
  });

  it("mt:25 arriving before mt:24 still resolves the order", async () => {
    rig = await startRig();
    rig.sim.inject({ kind: "fill_before_order" });
    const out = await rig.client.placeMarketOrder(OPEN);
    expect(out.status).toBe("filled");
    expect(out.fills).toHaveLength(1);
    expect(out.fills[0]?.synthetic).toBeUndefined();
  });

  it("extra latency beyond the ack timeout: re-sent same rq, still one execution", async () => {
    rig = await startRig();
    rig.sim.inject({ kind: "delay", ms: 1200 });
    const out = await rig.client.placeMarketOrder(OPEN);
    expect(out.status).toBe("filled");
    expect(out.rqs).toEqual([1]);
    expect(rig.sim.executedOrders()).toHaveLength(1);
  });

  it("socket closed with 1011 once: transparent same-rq retry; twice: reported as failed", async () => {
    rig = await startRig();
    const { client, sim } = rig;
    sim.inject({ kind: "close_socket", code: 1011 });
    const ok = await client.placeMarketOrder(OPEN);
    expect(ok.status).toBe("filled");
    expect(ok.rqs).toEqual([1]);
    expect(sim.executedOrders()).toHaveLength(1);

    sim.inject({ kind: "close_socket", code: 1011, count: 2 });
    const bad = await client.placeMarketOrder({ ...OPEN, sizeBase: 0.001 });
    expect(bad.status).toBe("failed");
    expect(bad.failure?.code).toBe("socket_closed_1011");
    expect(sim.executedOrders()).toHaveLength(1);
    await waitFor(() => client.isConnected());
  });
});

describe("fault injection: failure status -> NEW rq", () => {
  it("a reason-coded rejection is terminal; the NEXT order gets a strictly larger rq", async () => {
    rig = await startRig();
    const { client, sim } = rig;
    sim.inject({ kind: "reject", sr: 44, fr: 1 });
    const bad = await client.placeMarketOrder(OPEN);
    expect(bad.status).toBe("failed");
    expect(bad.failure).toMatchObject({ code: "sr:44", fr: 1, sr: 44 });
    expect(bad.rqs).toEqual([1]);
    const good = await client.placeMarketOrder(OPEN);
    expect(good.status).toBe("filled");
    expect(good.rq).toBe(2);
    expect(rig.rqLog).toEqual([1, 2]);
    expect(sim.executedOrders()).toHaveLength(1);
  });

  it("sr 32 (OrderDescIdTooLow) is retried ONCE with a new rq and then succeeds", async () => {
    rig = await startRig();
    const { client, sim } = rig;
    sim.inject({ kind: "reject", sr: 32 });
    const retries: number[] = [];
    const out = await client.placeMarketOrder({ ...OPEN, handlers: { retry: (e) => retries.push(e.oldRq) } });
    expect(out.status).toBe("filled");
    expect(out.rqs).toEqual([1, 2]);
    expect(out.attempts).toBe(2);
    expect(retries).toEqual([1]);
    expect(sim.executedOrders()).toHaveLength(1);
    expect(sim.executedOrders()[0]?.rq).toBe(2);
  });

  it("a real OrderDescIdTooLow: another client moved lfr ahead, our counter is stale", async () => {
    rig = await startRig();
    const { client, key } = rig;
    await client.placeMarketOrder(OPEN); // rq 1
    // simulate another tab having used rq 500 (lfr moves, but our mt:21 is lost to a stale local view)
    const stale = client.getAccounts()[0]!;
    // push lfr far ahead by placing an order with a high rq through the tracker
    client.orderTracker.seedRq(key.accountId, 499);
    const mid = await client.placeMarketOrder({ ...OPEN, sizeBase: 0.001 }); // rq 500 -> lfr 500
    expect(mid.rq).toBe(500);
    // roll the local counter back below lfr and clear the cached lfr
    (client.orderTracker as unknown as { counters: Map<number, number> }).counters.set(key.accountId, 1);
    client.orderTracker.setAccounts([{ ...stale, lfr: 1 }]);
    const out = await client.placeMarketOrder({ ...OPEN, sizeBase: 0.001 });
    expect(out.status).toBe("filled");
    expect(out.rqs.length).toBe(2); // first attempt hit sr 32, the retry went through
    expect(out.rqs[0]).toBeLessThan(500);
    expect(out.rqs[1]).toBeGreaterThan(500);
  });

  it("mt:3 rejected with a retryable 503 -> new rq", async () => {
    rig = await startRig();
    rig.sim.inject({ kind: "reject", via: "status", httpCode: 503, error: "order submission is backed up" });
    const out = await rig.client.placeMarketOrder(OPEN);
    expect(out.status).toBe("filled");
    expect(out.rqs).toEqual([1, 2]);
    expect(rig.sim.executedOrders()).toHaveLength(1);
  });

  it("mt:3 400 is terminal and does not burn retries", async () => {
    rig = await startRig();
    rig.sim.inject({ kind: "reject", via: "status", httpCode: 400, error: "invalid order type" });
    const out = await rig.client.placeMarketOrder(OPEN);
    expect(out.status).toBe("failed");
    expect(out.failure).toMatchObject({ source: "status", code: "400" });
    expect(out.rqs).toEqual([1]);
    expect(rig.sim.executedOrders()).toHaveLength(0);
  });

  it("no liquidity: IOC cancelled with zero fill is a failure (unfilled)", async () => {
    rig = await startRig();
    rig.sim.inject({ kind: "no_liquidity" });
    const out = await rig.client.placeMarketOrder(OPEN);
    expect(out.status).toBe("failed");
    expect(out.failure).toMatchObject({ source: "unfilled", code: "sr:16" });
    expect(await rig.client.getPositions()).toEqual([]);
  });

  it("partial fill then cancel: partially_filled with the filled size", async () => {
    rig = await startRig();
    rig.sim.inject({ kind: "partial_fill", fraction: 0.5 });
    const out = await rig.client.placeMarketOrder({ ...OPEN, sizeBase: 0.01 });
    expect(out.status).toBe("partially_filled");
    expect(out.requestedSize).toBe(0.01);
    expect(out.filledSize).toBe(0.005);
    expect((await rig.client.getPositions())[0]?.size).toBe(0.005);
  });
});

describe("fault injection: heartbeats and sockets", () => {
  it("a heartbeat gap forces a reconnect and trading continues", async () => {
    rig = await startRig();
    const { client, sim } = rig;
    const errors: string[] = [];
    const disconnects: string[] = [];
    client.on("error", (e) => errors.push(e.message));
    client.on("disconnected", (d) => disconnects.push(d.reason));
    const epoch = client.tradingSocket.epoch;
    sim.inject({ kind: "heartbeat_gap" });
    await waitFor(() => client.tradingSocket.epoch > epoch && client.isConnected());
    expect(errors.some((e) => /heartbeat gap/.test(e))).toBe(true);
    expect(disconnects.some((r) => /heartbeat gap/.test(r))).toBe(true);
    const out = await client.placeMarketOrder(OPEN);
    expect(out.status).toBe("filled");
  });

  it("an order in flight during a heartbeat-gap reconnect still completes exactly once", async () => {
    rig = await startRig({ sim: { latencyMs: [100, 120] } });
    const { client, sim } = rig;
    const epoch = client.tradingSocket.epoch;
    const p = client.placeMarketOrder(OPEN);
    sim.inject({ kind: "heartbeat_gap" });
    const out = await p;
    expect(out.status).toBe("filled");
    expect(sim.executedOrders()).toHaveLength(1);
    await waitFor(() => client.tradingSocket.epoch >= epoch);
  });

  it("the server dropping every connection mid-flight: auto reconnect with backoff", async () => {
    rig = await startRig();
    const { client, sim } = rig;
    const epoch = client.tradingSocket.epoch;
    sim.dropConnections();
    await waitFor(() => client.tradingSocket.epoch > epoch && client.isConnected());
    expect(sim.tradingConnections()).toBe(1);
    expect((await client.placeMarketOrder(OPEN)).status).toBe("filled");
  });
});
