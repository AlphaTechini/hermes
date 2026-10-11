/**
 * End to end through the real stack: Fastify app + PerplClientRegistry + PerplExecutor + a real PerplClient talking
 * WebSocket/REST to the in-process Perpl simulator. Nothing in the Perpl path is mocked.
 */
import { startPerplSimulator, type PerplSimulator } from "@hermes/perpl";
import type { AlertRecord, PerplConnectionDTO, Position, ReportCard, StreamEvent } from "@hermes/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPerplLayer } from "../src/perpl/layer";
import { DEMO_PRIVY_DID, DEMO_USER_ID } from "../src/auth/verifier";
import { openDb } from "../src/db/connection";
import { encrypt } from "../src/crypto";
import { createStrategy, makeHarness, postHook, waitFor, type Harness } from "./support/harness";

let sim: PerplSimulator;
let h: Harness;
const extraSims: PerplSimulator[] = [];

beforeEach(async () => {
  sim = await startPerplSimulator({ port: 0, seed: 7, latencyMs: [20, 60], volMultiplier: 0.2 });
});
afterEach(async () => {
  await h?.close();
  await sim.stop();
  for (const s of extraSims.splice(0)) await s.stop();
});

async function boot(opts: { simulator?: PerplSimulator } = {}) {
  const simulator = opts.simulator ?? sim;
  h = await makeHarness({ perplLayer: createPerplLayer({ simulator, registry: { tickMs: 0 } }) });
  const events: StreamEvent[] = [];
  h.bus.subscribe((m) => events.push(m.event));
  return { events, simulator };
}

const get = async <T>(url: string): Promise<T> => (await h.app.inject({ method: "GET", url })).json<T>();
const post = (url: string, payload?: object) => h.app.inject({ method: "POST", url, ...(payload ? { payload } : {}) });

async function connectSim(): Promise<PerplConnectionDTO> {
  const res = await post("/api/perpl/sim/connect");
  expect(res.statusCode).toBe(200);
  return res.json<PerplConnectionDTO>();
}

async function strategy() {
  return createStrategy(h.app, { name: "E2E", defaultMarket: "BTC" });
}

async function send(s: { id: string; secret: string }, over: Record<string, unknown>) {
  const res = await postHook(h.app, s.id, { secret: s.secret, time: new Date().toISOString(), ...over });
  return res.json<{ alertId: string; duplicate?: boolean }>();
}

const statusOf = (id: string) => h.repos.alerts.get(id)?.status;
const filled = (id: string) => waitFor(() => statusOf(id) === "filled" || undefined, 8000);
const stages = (id: string) => (h.repos.alerts.record(id) as AlertRecord).events.map((e) => e.status);

describe("simulated Perpl account, end to end", () => {
  it("connects with one call, then alert -> sent -> accepted -> filled with fill, position, order ids and report card", async () => {
    const { events } = await boot();
    const conn = await connectSim();
    expect(conn).toMatchObject({ configured: true, status: "connected", mode: "sim", collateral: 10_000 });
    expect(conn.health).toMatchObject({ connected: true, status: "connected" });
    await waitFor(() => events.some((e) => e.type === "perpl_status" && e.health.connected) || undefined);
    expect(conn.apiKeyPublic).toMatch(/^pk_sim_/);
    expect(JSON.stringify(conn)).not.toMatch(/apiKeyPrivate/);

    const s = await strategy();
    const price = sim.getPrice("BTC");
    const { alertId } = await send(s, { action: "buy", size_usd: 1000, price, leverage: 2, id: "t1" });
    await filled(alertId);

    expect(stages(alertId)).toEqual(["received", "verified", "risk_checked", "sent", "accepted", "filled"]);
    const rec = h.repos.alerts.record(alertId)!;
    const times = rec.events.map((e) => e.atMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times); // strictly ordered
    expect(times.some((t) => !Number.isInteger(t))).toBe(true); // sub-millisecond precision
    expect(rec.latencyMs).toBeGreaterThan(0);
    expect(rec.latencyMs).toBeLessThan(3000);
    expect(rec.avgFillPrice).toBeGreaterThan(price * 0.99);

    const detail = h.repos.alertDetail(alertId)!;
    expect(detail.orders).toHaveLength(1);
    expect(detail.orders[0]).toMatchObject({ status: "filled", market: "BTC", side: "long", kind: "open" });
    expect(detail.orders[0]!.rq).toBeGreaterThan(0);
    expect(detail.orders[0]!.sn).toBeGreaterThan(0);
    expect(detail.orders[0]!.perplOrderId).toBeTruthy();
    expect(detail.orders[0]!.size).toBeCloseTo(1000 / price, 3);
    expect(detail.fills).toHaveLength(1);
    expect(detail.fills[0]!.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(detail.fills[0]!.block).toBeGreaterThan(0);
    expect(detail.fills[0]!.fee).toBeGreaterThan(0);
    // the persisted high-water mark covers the rq that was used
    expect(h.repos.connections.get("usr_demo")!.lastRq).toBeGreaterThanOrEqual(detail.orders[0]!.rq!);

    await waitFor(() => h.repos.positions.list("usr_demo").length === 1 || undefined);
    const positions = await get<Position[]>("/api/positions");
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ market: "BTC", side: "long" });
    expect(positions[0]!.notionalUsd).toBeGreaterThan(900);

    const account = await get<import("@hermes/shared").AccountSummary>("/api/account");
    expect(account).toMatchObject({ connected: true, live: true });
    expect(account.marginUsedUsd).toBeGreaterThan(400); // 1000 USD at 2x
    expect(account.equityUsd).toBeGreaterThan(9_900);
    expect(account.availableUsd).toBeLessThan(9_600);
    expect(account.openNotionalUsd).toBeGreaterThan(900);

    const report = await get<ReportCard>(`/api/reports/${s.id}?range=all`);
    expect(report.counts).toMatchObject({ total: 1, filled: 1, shouldHaveTraded: 1 });
    expect(report.fillRate).toBe(1);
    expect(report.latency.count).toBe(1);

    await waitFor(() => events.some((e) => e.type === "account" && e.account.openNotionalUsd > 0) || undefined);
    const types = new Set(events.map((e) => e.type));
    for (const t of ["alert", "order", "fill", "positions", "account", "perpl_status"]) expect([t, types.has(t as StreamEvent["type"])]).toEqual([t, true]);
  });

  it("closes the position, books realised PnL (price PnL only; fees stay separate) and reports no position afterwards", async () => {
    await boot();
    await connectSim();
    const s = await strategy();
    sim.setPrice("BTC", 100_000);
    const open = await send(s, { action: "long", size_usd: 1500, price: 100_000, id: "o" });
    await filled(open.alertId);
    sim.setPrice("BTC", 101_000);
    const close = await send(s, { action: "close_long", price: 101_000, id: "c" });
    await filled(close.alertId);

    const d = h.repos.alertDetail(close.alertId)!;
    expect(d).toMatchObject({ kind: "close", side: "long" });
    const fill = d.fills[0]!;
    expect(fill.realizedPnl).toBeGreaterThan(5); // ~ +1% on 1500
    expect(fill.realizedPnl).toBeLessThan(25);
    const today = new Date().toISOString().slice(0, 10);
    expect(h.repos.dailyPnl.get("usr_demo", today)).toBeCloseTo(fill.realizedPnl!, 6);
    await waitFor(() => h.repos.positions.list("usr_demo").length === 0 || undefined);

    const again = await send(s, { action: "close_long", price: 101_000, id: "c2" });
    await waitFor(() => statusOf(again.alertId) === "blocked" || undefined);
    expect(h.repos.alerts.get(again.alertId)).toMatchObject({ status: "blocked", blockReason: "no_position_to_close" });
  });

  it("does not execute a duplicate alert twice", async () => {
    await boot();
    await connectSim();
    const s = await strategy();
    const body = { action: "buy", size_usd: 800, price: sim.getPrice("BTC"), id: "dup-1" };
    const first = await send(s, body);
    const second = await send(s, body);
    expect(second.duplicate).toBe(true);
    await filled(first.alertId);
    expect(h.repos.alerts.get(second.alertId)!.status).toBe("duplicate");
    await new Promise((r) => setTimeout(r, 400));
    expect(sim.executedOrders()).toHaveLength(1);
    expect(h.repos.fills.list("usr_demo", 10)).toHaveLength(1);
  });

  it("blocks an over-limit size and a disallowed market before anything reaches Perpl", async () => {
    await boot();
    await connectSim();
    const s = await strategy();
    const big = await send(s, { action: "buy", size_usd: 20_000, price: sim.getPrice("BTC"), id: "big" });
    await waitFor(() => statusOf(big.alertId) === "blocked" || undefined);
    expect(h.repos.alerts.get(big.alertId)!.blockReason).toBe("size_above_max");
    const zec = await send(s, { action: "buy", market: "DOGEUSDT.P", size_usd: 500, price: 0.2, id: "doge" });
    await waitFor(() => statusOf(zec.alertId) === "blocked" || undefined);
    expect(h.repos.alerts.get(zec.alertId)!.blockReason).toBe("market_not_allowed");
    expect(sim.receivedOrderFrames()).toBe(0);
  });

  it("blocks with perpl_not_connected when the user has no connection", async () => {
    await boot();
    const s = await strategy();
    const a = await send(s, { action: "buy", size_usd: 500, price: 100_000, id: "nc" });
    await waitFor(() => statusOf(a.alertId) === "blocked" || undefined);
    expect(h.repos.alerts.get(a.alertId)!.blockReason).toBe("perpl_not_connected");
  });

  it.each([
    ["never reached Perpl", false],
    ["executed but the result was lost", true],
  ])("a disconnect before any status (%s) still yields exactly one fill", async (_name, execute) => {
    await boot();
    await connectSim();
    const s = await strategy();
    sim.inject({ kind: "disconnect_before_status", execute });
    const { alertId } = await send(s, { action: "buy", size_usd: 700, price: sim.getPrice("BTC"), id: `dc-${execute}` });
    await filled(alertId);
    await new Promise((r) => setTimeout(r, 500));
    expect(sim.executedOrders()).toHaveLength(1);
    expect(h.repos.fills.list("usr_demo", 10)).toHaveLength(1);
    expect(h.repos.orders.byAlert(alertId)).toHaveLength(1);
    expect(stages(alertId).filter((x) => x === "filled")).toHaveLength(1);
    const view = sim.account(Number(h.repos.connections.get("usr_demo")!.accountId));
    expect(view?.positions).toHaveLength(1);
  });

  it("a rejected order fails the alert with a readable code and message", async () => {
    await boot();
    await connectSim();
    const s = await strategy();
    sim.inject({ kind: "reject", sr: 34 });
    const { alertId } = await send(s, { action: "buy", size_usd: 500, price: sim.getPrice("BTC"), id: "rej" });
    await waitFor(() => statusOf(alertId) === "failed" || undefined);
    const rec = h.repos.alerts.record(alertId)!;
    expect(rec.errorCode).toBeTruthy();
    const failed = rec.events.find((e) => e.status === "failed")!;
    expect(String(failed.detail?.message ?? "").length).toBeGreaterThan(5);
    expect(h.repos.fills.list("usr_demo", 10)).toHaveLength(0);
  });

  it("deleting the connection closes the client and reports not_configured", async () => {
    await boot();
    await connectSim();
    await waitFor(() => sim.tradingConnections() > 0 || undefined);
    const res = await h.app.inject({ method: "DELETE", url: "/api/perpl/connection" });
    expect(res.json<PerplConnectionDTO>()).toMatchObject({ configured: false, status: "not_configured" });
    await waitFor(() => sim.tradingConnections() === 0 || undefined);
  });
});

describe("saving a connection validates it against Perpl first", () => {
  it("rejects a key that is not a key, saving nothing", async () => {
    await boot();
    const res = await h.app.inject({ method: "PUT", url: "/api/perpl/connection", payload: { accountId: 5001, apiKeyPublic: "pk", apiKeyPrivate: "definitely not a key" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "perpl_invalid_key_format" } });
    expect(h.repos.connections.get("usr_demo")).toBeUndefined();
  });

  it("rejects an account whose order forwarding is off (409), saving nothing", async () => {
    await boot();
    sim.createAccount({ accountId: 5002, forwarding: false });
    const res = await h.app.inject({
      method: "PUT",
      url: "/api/perpl/connection",
      payload: { accountId: 5002, apiKeyPublic: "pk_x", apiKeyPrivate: "11".repeat(32) },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "perpl_forwarding_disabled" } });
    expect(h.repos.connections.get("usr_demo")).toBeUndefined();
  });

  it("answers 451 geo_blocked when Perpl refuses the region", async () => {
    const blocked = await startPerplSimulator({ port: 0, geoBlocked: true });
    extraSims.push(blocked);
    await boot({ simulator: blocked });
    const res = await h.app.inject({
      method: "PUT",
      url: "/api/perpl/connection",
      payload: { accountId: 5003, apiKeyPublic: "pk_y", apiKeyPrivate: "22".repeat(32) },
    });
    expect(res.statusCode).toBe(451);
    expect(res.json()).toMatchObject({ error: { code: "perpl_geo_blocked" } });
    expect(h.repos.connections.get("usr_demo")).toBeUndefined();
  });

  it("a pasted key saves and connects exactly like the one-click simulated account", async () => {
    await boot();
    const res = await h.app.inject({
      method: "PUT",
      url: "/api/perpl/connection",
      payload: { accountId: "5004", apiKeyPublic: "pk_pasted", apiKeyPrivate: "33".repeat(32) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<PerplConnectionDTO>()).toMatchObject({ configured: true, status: "connected", accountId: "5004" });
  });
});

describe("sim connect endpoint", () => {
  it("is not available outside sim mode", async () => {
    h = await makeHarness({ env: { PERPL_MODE: "live" } });
    const res = await h.app.inject({ method: "POST", url: "/api/perpl/sim/connect" });
    expect(res.statusCode).toBe(404);
  });
});

describe("registry behaviour", () => {
  it("reconnects after the socket is dropped and keeps trading, announcing the state changes", async () => {
    const { events } = await boot();
    await connectSim();
    const s = await strategy();
    sim.dropConnections(1001, "going away");
    await waitFor(() => events.some((e) => e.type === "perpl_status" && e.health.status === "reconnecting") || undefined, 4000);
    await waitFor(() => h.perplLayer!.registry.health("usr_demo")?.connected || undefined, 8000);
    expect(h.perplLayer!.registry.health("usr_demo")).toMatchObject({ connected: true, reconnects: 1 });
    const { alertId } = await send(s, { action: "buy", size_usd: 600, price: sim.getPrice("BTC"), id: "after-drop" });
    await filled(alertId);
    expect(sim.executedOrders()).toHaveLength(1);
  });

  it("blocks alerts while the link is down instead of sending them into the void", async () => {
    await boot();
    await connectSim();
    const s = await strategy();
    await h.perplLayer!.registry.stop(); // simulates a dead link: clients closed, nothing reachable
    const { alertId } = await send(s, { action: "buy", size_usd: 600, price: 100_000, id: "down" });
    await waitFor(() => statusOf(alertId) === "blocked" || undefined);
    expect(sim.receivedOrderFrames()).toBe(0);
  });

  it("a stored key that is not a valid key is reported, not retried, and does not break boot", async () => {
    const db = openDb(":memory:");
    h = await makeHarness({ db });
    h.repos.users.upsertByPrivyDid(DEMO_PRIVY_DID, { id: DEMO_USER_ID });
    h.repos.connections.upsert({ userId: "usr_demo", accountId: "1001", apiKeyPublic: "demo-api-key-public", apiKeyPrivateEnc: encrypt("demo-not-a-real-key", h.config.masterKey) });
    await h.close();
    h = await makeHarness({ db, perplLayer: createPerplLayer({ simulator: sim, registry: { tickMs: 0 } }) });
    await waitFor(() => h.perplLayer!.registry.health("usr_demo")?.lastErrorCode || undefined);
    expect(h.perplLayer!.registry.health("usr_demo")).toMatchObject({ connected: false, status: "disconnected", lastErrorCode: "perpl_invalid_key_format" });
    const dto = await get<PerplConnectionDTO>("/api/perpl/connection");
    expect(dto).toMatchObject({ configured: true, status: "disconnected" });
    expect(dto.health?.lastError).toMatch(/Ed25519/);
    db.close();
  });

  it("survives a server restart: stored key re-enrolls with a brand new simulator and the rq counter keeps going", async () => {
    const db = openDb(":memory:");
    h = await makeHarness({ db, perplLayer: createPerplLayer({ simulator: sim, registry: { tickMs: 0 } }) });
    await connectSim();
    const s = await strategy();
    const first = await send(s, { action: "buy", size_usd: 500, price: sim.getPrice("BTC"), id: "r1" });
    await filled(first.alertId);
    const rq1 = h.repos.orders.byAlert(first.alertId)[0]!.rq!;
    const key = h.config.masterKey;
    await h.close();
    await sim.stop();

    // "restart": same database and master key, new process memory, new simulator that has never heard of this key
    sim = await startPerplSimulator({ port: 0, seed: 9, latencyMs: [20, 60], volMultiplier: 0.2 });
    h = await makeHarness({ db, perplLayer: createPerplLayer({ simulator: sim, registry: { tickMs: 0 } }), env: { HERMES_MASTER_KEY: key.toString("hex") } });
    await waitFor(() => h.perplLayer!.registry.health("usr_demo")?.connected || undefined, 8000);
    expect(h.repos.connections.get("usr_demo")!.lastRq).toBeGreaterThanOrEqual(rq1);
    // the stored position is re-opened on the fresh simulated account, so the next close alert has something to close
    await waitFor(() => (h.repos.positions.list("usr_demo")[0]?.market === "BTC" && sim.account(Number(h.repos.connections.get("usr_demo")!.accountId))?.positions.length === 1) || undefined, 8000);
    const close = await send(s, { action: "close_long", price: sim.getPrice("BTC"), id: "r2" });
    await filled(close.alertId);
    expect(h.repos.orders.byAlert(close.alertId)[0]!.rq!).toBeGreaterThan(rq1);
    db.close();
  });
});
