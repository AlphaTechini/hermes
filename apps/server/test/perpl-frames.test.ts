/**
 * Raw Perpl frames per order, Perpl link health (head block, block time, round trip), the onboarding context and the
 * account lookup, against the real registry + executor + in-process simulator.
 */
import { Ed25519Signer, startPerplSimulator, type PerplSimulator } from "@hermes/perpl";
import type { AlertDetail, PerplConnectionDTO, PerplContextDTO } from "@hermes/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPerplLayer } from "../src/perpl/layer";
import { generateSimCredentials } from "../src/perpl/sim-keys";
import { createStrategy, makeHarness, postHook, waitFor, type Harness } from "./support/harness";

let sim: PerplSimulator;
let h: Harness;
beforeEach(async () => {
  sim = await startPerplSimulator({ port: 0, seed: 11, latencyMs: [10, 30], volMultiplier: 0.2, heartbeatIntervalMs: 100, blockTimeMs: 50 });
  h = await makeHarness({ perplLayer: createPerplLayer({ simulator: sim, registry: { tickMs: 0 } }) });
});
afterEach(async () => {
  await h?.close();
  await sim.stop();
});

const get = async <T>(url: string): Promise<T> => (await h.app.inject({ method: "GET", url })).json<T>();
const connect = () => h.app.inject({ method: "POST", url: "/api/perpl/sim/connect" });

describe("raw frames per order", () => {
  it("stores the exact mt:22 frame sent and every mt:3 / mt:24 / mt:25 received, on GET /api/alerts/:id", async () => {
    expect((await connect()).statusCode).toBe(200);
    const s = await createStrategy(h.app, { name: "F", defaultMarket: "BTC" });
    const res = await postHook(h.app, s.id, { secret: s.secret, action: "buy", size_usd: 1000, price: sim.getPrice("BTC"), leverage: 2, time: new Date().toISOString(), id: "frames-1" });
    const { alertId } = res.json<{ alertId: string }>();
    await waitFor(() => h.repos.alerts.get(alertId)?.status === "filled" || undefined, 8000);
    const frameMts = () => h.repos.alertDetail(alertId)!.orders[0]!.frames!.map((f) => f.mt);
    await waitFor(() => (frameMts().includes(25) ? true : undefined), 3000);

    const d = await get<AlertDetail>(`/api/alerts/${alertId}`);
    const order = d.orders[0]!;
    const frames = order.frames!;
    const out = frames.filter((f) => f.direction === "out");
    expect(out).toHaveLength(1);
    expect(out[0]!.mt).toBe(22);
    const sent = JSON.parse(out[0]!.json) as Record<string, number>;
    expect(sent).toMatchObject({ mt: 22, rq: order.rq, sn: order.sn, lb: order.lb });
    for (const k of ["mkt", "acc", "t", "s", "lv", "fl"]) expect(sent).toHaveProperty(k);
    expect(sent.lv).toBe(200); // 2x in hundredths
    const incoming = frames.filter((f) => f.direction === "in");
    expect(new Set(incoming.map((f) => f.mt))).toEqual(new Set([3, 24, 25]));
    const status = JSON.parse(incoming.find((f) => f.mt === 3)!.json) as { cid: number; status: { code: number } };
    expect(status.cid).toBe(order.sn);
    expect(status.status.code).toBe(0);
    const ord = JSON.parse(incoming.find((f) => f.mt === 24)!.json) as { d: Array<{ rq: number }> };
    expect(ord.d.every((o) => o.rq === order.rq)).toBe(true);
    // oldest first, receive times after the send time, sub-millisecond precision
    expect(frames.map((f) => f.atMs)).toEqual([...frames.map((f) => f.atMs)].sort((a, b) => a - b));
    expect(frames[0]!.direction).toBe("out");
    // the first status frame also gives the Perpl round trip (mt:22 -> mt:3)
    const health = (await get<PerplConnectionDTO>("/api/perpl/connection")).health!;
    expect(health.latencySource).toBe("order");
    expect(health.latencyMs).toBeGreaterThan(0);
    expect(health.latencyMs).toBeLessThan(500);
  });
});

describe("Perpl link health", () => {
  it("always carries headBlock, blockTimeMs and latencyMs from the Perpl client (sim)", async () => {
    await connect();
    const health = (await get<PerplConnectionDTO>("/api/perpl/connection")).health!;
    expect(health).toMatchObject({ connected: true, mode: "sim" });
    expect(health.headBlock).toBeGreaterThan(0);
    expect(health.blockTimeMs).toBeGreaterThan(0);
    expect(health.latencyMs).not.toBeNull();
    // heartbeats move the head and let the block time converge on the simulator's 50 ms
    const first = health.headBlock!;
    await waitFor(() => (h.perplLayer!.registry.health("usr_demo")!.headBlock! > first ? true : undefined), 3000);
    await waitFor(() => (Math.abs(h.perplLayer!.registry.health("usr_demo")!.blockTimeMs! - 50) < 30 ? true : undefined), 5000);
    expect(h.perplLayer!.registry.health("usr_demo")!.headBlock).toBeGreaterThan(first);
  });
});

describe("GET /api/perpl/context", () => {
  it("returns the simulator's context for onboarding", async () => {
    const ctx = await get<PerplContextDTO>("/api/perpl/context");
    expect(ctx).toMatchObject({
      mode: "sim",
      collateralToken: "AUSD",
      collateralDecimals: 6,
      minAccountOpenAusd: 100,
      minDepositAusd: 10,
    });
    expect(ctx.markets.find((m) => m.symbol === "BTC")).toEqual({ symbol: "BTC", id: 16, priceDecimals: 1, sizeDecimals: 5 });
    expect(ctx.markets.length).toBeGreaterThanOrEqual(5);
  });
});

describe("PUT /api/perpl/connection without accountId", () => {
  it("finds the account the simulator enrolled for the key", async () => {
    const creds = h.perplLayer!.registry.provisionSim("usr_demo");
    const res = await h.app.inject({ method: "PUT", url: "/api/perpl/connection", payload: { apiKeyPublic: creds.apiKeyPublic, apiKeyPrivate: creds.apiKeyPrivate } });
    expect(res.statusCode).toBe(200);
    expect(res.json<PerplConnectionDTO>()).toMatchObject({ configured: true, accountId: creds.accountId, status: "connected" });
  });

  it("still accepts an explicit accountId", async () => {
    const creds = generateSimCredentials(4242);
    sim.createAccount({ accountId: 4242 });
    sim.enrollKey(Ed25519Signer.fromSecret(creds.apiKeyPrivate).publicKey, 4242, { apiKey: creds.apiKeyPublic });
    const res = await h.app.inject({ method: "PUT", url: "/api/perpl/connection", payload: { ...creds, accountId: 4242 } });
    expect(res.statusCode).toBe(200);
    expect(res.json<PerplConnectionDTO>().accountId).toBe("4242");
  });

  it("answers 400 perpl_account_not_found for a key no account belongs to", async () => {
    const creds = generateSimCredentials(1);
    const res = await h.app.inject({ method: "PUT", url: "/api/perpl/connection", payload: { apiKeyPublic: creds.apiKeyPublic, apiKeyPrivate: creds.apiKeyPrivate } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("perpl_account_not_found");
    expect((await get<PerplConnectionDTO>("/api/perpl/connection")).configured).toBe(false);
  });
});
