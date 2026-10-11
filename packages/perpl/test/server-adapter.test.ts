import { afterEach, describe, expect, it } from "vitest";
import type { Position } from "@hermes/shared";
import { PerplOrderRejectedError, toServerClient, type ServerPerplEvent } from "../src/server-adapter";
import { startRig, waitFor, type Rig } from "./helpers";

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

describe("toServerClient(): apps/server PerplClient interface", () => {
  it("place, fill, positions, account, cancel through the server-shaped API", async () => {
    rig = await startRig({ connect: false });
    const server = toServerClient(rig.client);
    const events: ServerPerplEvent[] = [];
    const off = server.onStatus((e) => events.push(e));
    expect(server.isConnected()).toBe(false);
    await server.connect();
    expect(server.isConnected()).toBe(true);
    expect(events.some((e) => e.kind === "connection" && e.state === "connected")).toBe(true);

    expect(await server.getMarkPrice(16)).toBeGreaterThan(100_000);
    expect(await server.headBlock()).toBeGreaterThan(0);
    const acc0 = await server.getAccount();
    expect(acc0).toMatchObject({ connected: true, accountId: String(rig.key.accountId), collateralUsd: 10_000, equityUsd: 10_000, availableUsd: 10_000, openNotionalUsd: 0, live: true });

    const res = await server.placeOrder({ marketId: 16, type: 1, size: 0.002, leverage: 3, maxSlippageBps: 50 });
    expect(res).toMatchObject({ rq: 1, lb: 0 });
    expect(res.sn).toBeGreaterThan(0);
    await waitFor(() => events.some((e) => e.kind === "order" && e.status === "filled"));
    const kinds = events.map((e) => (e.kind === "order" ? `order:${e.status}` : e.kind));
    expect(kinds).toContain("order:accepted");
    expect(kinds).toContain("fill");
    const fill = events.find((e) => e.kind === "fill");
    expect(fill).toMatchObject({ rq: 1, sn: res.sn, size: 0.002 });
    if (fill?.kind === "fill") {
      expect(fill.price).toBeGreaterThan(100_000);
      expect(fill.fee).toBeGreaterThan(0);
      expect(fill.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(fill.block).toBeGreaterThan(0);
    }
    await waitFor(() => events.some((e) => e.kind === "positions"));
    await waitFor(() => events.some((e) => e.kind === "account"));

    const positions: Position[] = await server.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ market: "BTC", side: "long", size: 0.002 });
    expect(positions[0]?.notionalUsd).toBeGreaterThan(200);
    const acc = await server.getAccount();
    expect(acc.openNotionalUsd).toBeGreaterThan(200);
    expect(acc.collateralUsd).toBeLessThan(10_000);

    // close it with the same API: CloseLong
    const close = await server.placeOrder({ marketId: 16, type: 3, size: 0.002, leverage: 1, maxSlippageBps: 50 });
    expect(close.rq).toBe(2);
    await waitFor(() => events.filter((e) => e.kind === "order" && e.status === "filled").length === 2);
    expect(await server.getPositions()).toEqual([]);
    expect((await server.getAccount()).realizedPnlTodayUsd).toBeLessThan(0.1); // fees dominate with no price move

    off();
    await server.close();
    expect(server.isConnected()).toBe(false);
  });

  it("business failures before send reject with PerplOrderRejectedError and emit a rejected order event", async () => {
    rig = await startRig({ connect: false, account: { forwarding: false } });
    const server = toServerClient(rig.client);
    const events: ServerPerplEvent[] = [];
    server.onStatus((e) => events.push(e));
    await server.connect();
    await expect(server.placeOrder({ marketId: 16, type: 1, size: 0.001, leverage: 2 })).rejects.toMatchObject({ name: "PerplOrderRejectedError", code: "forwarding_disabled" });
    expect(events.find((e) => e.kind === "order")).toMatchObject({ status: "rejected", errorCode: "forwarding_disabled" });
    await expect(server.placeOrder({ marketId: 999, type: 1, size: 1 })).rejects.toBeInstanceOf(PerplOrderRejectedError);
  });

  it("a rejection AFTER send is reported only through events", async () => {
    rig = await startRig({ connect: false });
    const server = toServerClient(rig.client);
    const events: ServerPerplEvent[] = [];
    server.onStatus((e) => events.push(e));
    await server.connect();
    rig.sim.inject({ kind: "reject", sr: 44, fr: 1 });
    const res = await server.placeOrder({ marketId: 16, type: 1, size: 0.001, leverage: 2 });
    expect(res.rq).toBe(1);
    await waitFor(() => events.some((e) => e.kind === "order" && e.status === "rejected"));
    const rej = events.find((e) => e.kind === "order" && e.status === "rejected");
    expect(rej).toMatchObject({ errorCode: "sr:44", rq: 1 });
  });

  it("limit order rests, then cancel through the adapter", async () => {
    rig = await startRig({ connect: false });
    const server = toServerClient(rig.client);
    const events: ServerPerplEvent[] = [];
    server.onStatus((e) => events.push(e));
    await server.connect();
    const px = await server.getMarkPrice(32);
    const res = await server.placeOrder({ marketId: 32, type: 1, size: 1, price: Math.round(px * 0.9), leverage: 2, flags: 0 });
    await waitFor(() => events.some((e) => e.kind === "order" && e.status === "accepted" && e.orderId));
    const accepted = events.find((e) => e.kind === "order" && e.status === "accepted" && e.orderId);
    const orderId = accepted?.kind === "order" ? accepted.orderId : undefined;
    expect(orderId).toBeTruthy();
    const c = await server.cancel({ marketId: 32, orderId: orderId as string });
    expect(c.rq).toBe(res.rq + 1);
    await waitFor(() => events.some((e) => e.kind === "order" && e.status === "cancelled"));
  });
});
