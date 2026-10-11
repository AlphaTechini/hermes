import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PerplConnectionDTO, ReportCard, StrategyDTO, StrategySecretDTO } from "@hermes/shared";
import { openDb, runMigrations } from "../src/db/connection";
import { createStrategy, makeHarness, postHook, settled, type Harness } from "./support/harness";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

const get = (url: string) => h.app.inject({ method: "GET", url });
const send = (method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  h.app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe("strategies", () => {
  it("creates, lists (no secrets), updates, rotates and deletes", async () => {
    const created = await send("POST", "/api/strategies", { name: "BTC trend 15m", defaultMarket: "BTCUSDT.P", defaultSizeUsd: 120 });
    expect(created.statusCode).toBe(201);
    const c = created.json() as StrategySecretDTO;
    expect(c.id).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(c.secret.length).toBeGreaterThanOrEqual(32);
    expect(c.defaultMarket).toBe("BTC");
    expect(c.webhookUrl).toBe(`https://hermes.test/hooks/${c.id}`);
    expect(c.templatesWithSecret.indicator).toContain(c.secret);
    expect(c.templates.strategy).toContain("{{strategy.order.action}}");
    expect(c.templates.strategy).toContain("{{strategy.market_position}}");
    expect(c.templates.strategy).toContain("{{strategy.order.contracts}}");
    expect(c.templates.indicator).toContain("{{close}}");
    expect(c.templates.indicator).toContain("{{timenow}}");
    expect(c.templates.indicator).toContain("{{ticker}}");
    expect(c.templates.strategy).toContain("{{strategy.order.id}}");

    const list = await get("/api/strategies");
    expect(list.body).not.toContain(c.secret);
    expect(list.json<StrategyDTO[]>()).toHaveLength(1);

    const patched = await send("PATCH", `/api/strategies/${c.id}`, { name: "Renamed", enabled: false });
    expect(patched.json<StrategyDTO>()).toMatchObject({ name: "Renamed", enabled: false });

    const reveal = await get(`/api/strategies/${c.id}/secret`);
    expect(reveal.json<StrategySecretDTO>().secret).toBe(c.secret);

    const rotated = await send("POST", `/api/strategies/${c.id}/rotate-secret`);
    const newSecret = rotated.json<StrategySecretDTO>().secret;
    expect(newSecret).not.toBe(c.secret);
    // old secret no longer authenticates
    await send("PATCH", `/api/strategies/${c.id}`, { enabled: true });
    expect((await postHook(h.app, c.id, { secret: c.secret, action: "close" })).statusCode).toBe(401);
    expect((await postHook(h.app, c.id, { secret: newSecret, action: "close" })).statusCode).toBe(202);

    expect((await send("DELETE", `/api/strategies/${c.id}`)).statusCode).toBe(200);
    expect((await get(`/api/strategies/${c.id}`)).statusCode).toBe(404);
  });

  it("stores the secret encrypted at rest", async () => {
    const s = await createStrategy(h.app);
    const row = h.db.prepare("SELECT secret_enc FROM strategies WHERE id = ?").get(s.id) as { secret_enc: string };
    expect(row.secret_enc).not.toContain(s.secret);
    expect(row.secret_enc.startsWith("v1.")).toBe(true);
  });

  it("validates input with the standard error shape", async () => {
    const res = await send("POST", "/api/strategies", { name: "" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "validation_error", message: expect.any(String) } });
    expect((await get("/api/nope")).json()).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("limits", () => {
  it("returns defaults, round-trips updates and normalises markets", async () => {
    const def = (await get("/api/limits")).json();
    expect(def).toMatchObject({ maxAlertAgeSec: 60, maxOrdersPerMinute: 30, defaultSlippageBps: 50, paused: false });
    const put = await send("PUT", "/api/limits", { ...def, allowedMarkets: ["btc", "ETHUSDT.P"], maxPositionUsd: 1234, paused: true });
    expect(put.statusCode).toBe(200);
    expect((await get("/api/limits")).json()).toMatchObject({ allowedMarkets: ["BTC", "ETH"], maxPositionUsd: 1234, paused: true });
    expect((await send("PUT", "/api/limits", { ...def, allowedMarkets: ["DOGE"] })).statusCode).toBe(400);
    expect((await send("PUT", "/api/limits", { ...def, maxLeverage: -1 })).statusCode).toBe(400);
  });
});

describe("perpl connection", () => {
  it("stores the private key encrypted and never returns it", async () => {
    expect((await get("/api/perpl/connection")).json<PerplConnectionDTO>()).toMatchObject({ configured: false, status: "not_configured" });
    const put = await send("PUT", "/api/perpl/connection", { accountId: 42, apiKeyPublic: "pub-key", apiKeyPrivate: "SUPER-PRIVATE" });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain("SUPER-PRIVATE");
    expect(put.json<PerplConnectionDTO>()).toMatchObject({ configured: true, accountId: "42", apiKeyPublic: "pub-key" });
    expect((await get("/api/perpl/connection")).body).not.toContain("SUPER-PRIVATE");
    const row = h.db.prepare("SELECT api_key_private_enc FROM perpl_connections").get() as { api_key_private_enc: string };
    expect(row.api_key_private_enc).not.toContain("SUPER-PRIVATE");
    const del = await send("DELETE", "/api/perpl/connection");
    expect(del.json<PerplConnectionDTO>().configured).toBe(false);
  });
});

describe("session", () => {
  it("serves the demo user in dev mode and accepts a wallet registration", async () => {
    const me = (await get("/api/me")).json();
    expect(me).toMatchObject({ id: "usr_demo", authMode: "dev", perplMode: "sim" });
    expect(me.walletAddress).toMatch(/^0x[0-9a-f]{40}$/);
    const wallet = "0x" + "ab".repeat(20);
    const upd = await send("POST", "/api/me/wallet", { address: wallet });
    expect(upd.json().walletAddress).toBe(wallet);
    expect((await send("POST", "/api/me/wallet", { address: "nope" })).statusCode).toBe(400);
    expect((await get("/api/me")).json().walletAddress).toBe(wallet); // not reset to the placeholder
  });

  it("requires a verified token in privy mode", async () => {
    const strict = await makeHarness({
      env: { AUTH_MODE: "privy", PRIVY_APP_ID: "app", PRIVY_APP_SECRET: "secret" },
    });
    try {
      expect((await strict.app.inject({ method: "GET", url: "/api/me" })).statusCode).toBe(401);
      expect((await strict.app.inject({ method: "GET", url: "/api/me", headers: { authorization: "Bearer junk" } })).statusCode).toBe(401);
      expect((await strict.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
      expect((await strict.app.inject({ method: "POST", url: "/hooks/abc", payload: "{}" })).statusCode).toBe(401);
    } finally {
      await strict.close();
    }
  });
});

describe("alerts API", () => {
  it("lists with filters + cursor pagination and returns detail with events", async () => {
    const s = await createStrategy(h.app, { name: "A", defaultMarket: "BTC", defaultSizeUsd: 50 });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await postHook(h.app, s.id, { secret: s.secret, action: "buy", id: `x${i}` });
      ids.push(r.json<{ alertId: string }>().alertId);
      await settled(h, ids[i]!);
    }
    await postHook(h.app, s.id, { secret: "bad", action: "buy" });

    const page1 = (await get(`/api/alerts?strategyId=${s.id}&limit=2`)).json();
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = (await get(`/api/alerts?strategyId=${s.id}&limit=10&cursor=${encodeURIComponent(page1.nextCursor)}`)).json();
    const all = [...page1.items, ...page2.items].map((a: { id: string }) => a.id);
    expect(new Set(all).size).toBe(6);
    expect(page2.nextCursor).toBeNull();

    const failed = (await get(`/api/alerts?status=failed`)).json();
    expect(failed.items).toHaveLength(5);
    expect((await get(`/api/alerts?status=bogus`)).statusCode).toBe(400);

    const detail = (await get(`/api/alerts/${ids[0]}`)).json();
    expect(detail.events.length).toBeGreaterThanOrEqual(4);
    expect(detail).toMatchObject({ orders: [expect.objectContaining({ status: "failed" })], fills: [], approval: null });
    expect(detail.rawBody).not.toContain(s.secret);
    expect((await get(`/api/alerts/alr_missing`)).statusCode).toBe(404);
  });

  it("serves orders, fills, positions, account and the report card", async () => {
    const s = await createStrategy(h.app, { name: "R", defaultMarket: "BTC", defaultSizeUsd: 50 });
    const r = await postHook(h.app, s.id, { secret: s.secret, action: "buy" });
    await settled(h, r.json<{ alertId: string }>().alertId);
    expect((await get("/api/orders")).json()).toHaveLength(1);
    expect((await get("/api/fills")).json()).toEqual([]);
    expect((await get("/api/positions")).json()).toEqual([]);
    expect((await get("/api/account")).json()).toMatchObject({ connected: false, live: false });
    const card = (await get(`/api/reports/${s.id}?range=7d`)).json<ReportCard>();
    expect(card).toMatchObject({ strategyId: s.id, range: "7d", counts: { total: 1, failed: 1 } });
    expect(card.gradeExplanation).toBeTruthy();
    expect((await get(`/api/reports/${s.id}?range=1y`)).statusCode).toBe(400);
    expect((await get(`/api/reports/nope`)).statusCode).toBe(404);
  });
});

describe("stream", () => {
  it("mints short-lived tickets and rejects bad ones", async () => {
    const t = (await send("POST", "/api/stream-ticket")).json<{ ticket: string; expiresAt: number }>();
    expect(t.ticket.length).toBeGreaterThan(20);
    expect(t.expiresAt).toBeGreaterThan(Date.now());
    expect((await get("/api/stream?ticket=bogus")).statusCode).toBe(401);
  });

  it("streams per-user events over SSE with a ready event", async () => {
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = h.app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const { ticket } = (await send("POST", "/api/stream-ticket")).json<{ ticket: string }>();
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/stream?ticket=${ticket}`, { signal: ctrl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const s = await createStrategy(h.app, { name: "S", defaultMarket: "BTC", defaultSizeUsd: 10 });
    await postHook(h.app, s.id, { secret: s.secret, action: "buy" });
    const deadline = Date.now() + 3000;
    while (!text.includes('"status":"failed"') && Date.now() < deadline) {
      const { value } = await reader.read();
      text += dec.decode(value);
    }
    ctrl.abort();
    expect(text).toContain("event: ready");
    expect(text).toContain("event: alert");
    expect(text).toContain('"status":"failed"');
    expect(text).not.toContain(s.secret);
  });
});

describe("migrations", () => {
  it("are idempotent", () => {
    const db = openDb(":memory:");
    expect(runMigrations(db)).toEqual([]);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of ["users", "perpl_connections", "strategies", "risk_limits", "alerts", "alert_events", "orders", "fills", "positions", "approvals", "daily_pnl"]) {
      expect(tables).toContain(t);
    }
    db.close();
  });
});
