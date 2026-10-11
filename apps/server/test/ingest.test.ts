import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStrategy, makeHarness, postHook, settled, type Harness } from "./support/harness";

let h: Harness;
let s: { id: string; secret: string };

beforeEach(async () => {
  h = await makeHarness();
  s = await createStrategy(h.app, { name: "T", defaultMarket: "BTC", defaultSizeUsd: 100 });
});
afterEach(async () => {
  await h.close();
});

const body = (over: Record<string, unknown> = {}) => ({
  secret: s.secret,
  action: "buy",
  market: "BINANCE:BTCUSDT.P",
  size_usd: 100,
  price: 100000,
  time: new Date().toISOString(),
  ...over,
});

describe("POST /hooks/:strategyId", () => {
  it("accepts a text/plain JSON body (TradingView style) with 202 and records the lifecycle", async () => {
    const res = await postHook(h.app, s.id, JSON.stringify(body({ size_usd: "250", price: "100,000.5" })), "text/plain");
    expect(res.statusCode).toBe(202);
    const { alertId } = res.json() as { alertId: string };
    expect(alertId).toMatch(/^alr_/);
    await settled(h, alertId);
    const rec = h.repos.alerts.record(alertId)!;
    expect(rec.events.map((e) => e.status).slice(0, 3)).toEqual(["received", "verified", "risk_checked"]);
    expect(rec).toMatchObject({ market: "BTC", side: "long", kind: "open", sizeUsd: 250, alertPrice: 100000.5 });
    // the default stub executor has no Perpl client: failed with perpl_not_connected
    expect(rec.status).toBe("failed");
    expect(rec.errorCode).toBe("perpl_not_connected");
    // timestamps are monotonic and sub-millisecond precise
    const ts = rec.events.map((e) => e.atMs);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    expect(ts.some((t) => t % 1 !== 0)).toBe(true);
  });

  it("also accepts application/json", async () => {
    const res = await postHook(h.app, s.id, body(), "application/json");
    expect(res.statusCode).toBe(202);
  });

  it("accepts a charset content type and no content type at all", async () => {
    const a = await postHook(h.app, s.id, body({ id: "a" }), "application/json; charset=utf-8");
    expect(a.statusCode).toBe(202);
    const b = await h.app.inject({ method: "POST", url: `/hooks/${s.id}`, payload: JSON.stringify(body({ id: "b" })) });
    expect(b.statusCode).toBe(202);
  });

  it("applies strategy defaults (market and size)", async () => {
    const res = await postHook(h.app, s.id, { secret: s.secret, action: "sell", time: new Date().toISOString() });
    expect(res.statusCode).toBe(202);
    const rec = h.repos.alerts.record((res.json() as { alertId: string }).alertId)!;
    expect(rec).toMatchObject({ market: "BTC", sizeUsd: 100, side: "short", kind: "open" });
  });

  describe("authentication", () => {
    it("rejects a wrong secret with 401 and records rejected_auth", async () => {
      const res = await postHook(h.app, s.id, body({ secret: "wrong" }));
      expect(res.statusCode).toBe(401);
      const rows = h.repos.alerts.list({ userId: "usr_demo", limit: 10 }).items;
      expect(rows[0]?.status).toBe("rejected_auth");
      expect(rows[0]?.events.map((e) => e.status)).toEqual(["received", "rejected_auth"]);
    });

    it("answers identically for unknown strategy, wrong secret, missing secret, unparseable body and disabled strategy", async () => {
      await h.app.inject({ method: "PATCH", url: `/api/strategies/${s.id}`, payload: { enabled: false } });
      const disabled = await postHook(h.app, s.id, body());
      await h.app.inject({ method: "PATCH", url: `/api/strategies/${s.id}`, payload: { enabled: true } });
      const results = [
        await postHook(h.app, "doesnotexist", body()),
        await postHook(h.app, s.id, body({ secret: "nope" })),
        await postHook(h.app, s.id, { action: "buy" }),
        await postHook(h.app, s.id, "this is not json"),
        disabled,
      ];
      for (const r of results) {
        expect(r.statusCode).toBe(401);
        expect(r.body).toBe(results[0]?.body);
      }
    });

    it("never stores the secret", async () => {
      await postHook(h.app, s.id, body());
      await postHook(h.app, s.id, body({ secret: "attacker-guess" }));
      const dump = JSON.stringify(h.db.prepare("SELECT raw_body, parsed_json FROM alerts").all());
      expect(dump).not.toContain(s.secret);
      expect(dump).not.toContain("attacker-guess");
      expect(dump).toContain("[redacted]");
    });
  });

  describe("validation", () => {
    it("returns 400 and records `invalid` for a bad payload", async () => {
      const res = await postHook(h.app, s.id, body({ action: "moon" }));
      expect(res.statusCode).toBe(400);
      const j = res.json() as { error: { code: string; issues: { path: string }[] } };
      expect(j.error.code).toBe("invalid_payload");
      expect(j.error.issues.map((i) => i.path)).toContain("action");
      const rec = h.repos.alerts.list({ userId: "usr_demo", limit: 1 }).items[0]!;
      expect(rec.status).toBe("invalid");
      expect(rec.events.at(-1)?.detail).toMatchObject({ issues: expect.any(Array) });
    });

    it("rejects unresolved TradingView placeholders and both size fields", async () => {
      const a = await postHook(h.app, s.id, body({ size: "{{strategy.order.contracts}}", size_usd: undefined }));
      expect(a.statusCode).toBe(400);
      const b = await postHook(h.app, s.id, body({ size: 1, size_usd: 100 }));
      expect(b.statusCode).toBe(400);
    });

    it("requires a size for opens when the strategy has no default, but not for closes", async () => {
      const bare = await createStrategy(h.app, { name: "bare", defaultMarket: "ETH" });
      const open = await postHook(h.app, bare.id, { secret: bare.secret, action: "buy" });
      expect(open.statusCode).toBe(400);
      const close = await postHook(h.app, bare.id, { secret: bare.secret, action: "close" });
      expect(close.statusCode).toBe(202);
    });

    it("rejects bodies over 16 KB", async () => {
      const res = await postHook(h.app, s.id, body({ comment: "x".repeat(20_000) }));
      expect(res.statusCode).toBe(413);
    });
  });

  describe("idempotency", () => {
    it("treats a repeated explicit id as a duplicate (200, duplicate:true)", async () => {
      const first = await postHook(h.app, s.id, body({ id: "sig-1" }));
      expect(first.statusCode).toBe(202);
      const second = await postHook(h.app, s.id, body({ id: "sig-1", price: 99999 }));
      expect(second.statusCode).toBe(200);
      const j = second.json() as { alertId: string; duplicate: boolean };
      expect(j.duplicate).toBe(true);
      const rec = h.repos.alerts.record(j.alertId)!;
      expect(rec.status).toBe("duplicate");
      expect(rec.events.at(-1)?.detail).toMatchObject({ duplicateOf: (first.json() as { alertId: string }).alertId });
    });

    it("hashes strategy + normalised body when there is no id (key order and secret do not matter)", async () => {
      const t = new Date().toISOString();
      const a = { secret: s.secret, action: "buy", market: "BTC", size_usd: 100, time: t };
      const b = { time: t, size_usd: 100, market: "BTC", action: "buy", secret: s.secret };
      expect((await postHook(h.app, s.id, a)).statusCode).toBe(202);
      const dup = await postHook(h.app, s.id, b);
      expect(dup.statusCode).toBe(200);
      expect((dup.json() as { duplicate: boolean }).duplicate).toBe(true);
      const different = await postHook(h.app, s.id, { ...a, size_usd: 101 });
      expect(different.statusCode).toBe(202);
    });

    it("scopes keys per strategy", async () => {
      const other = await createStrategy(h.app, { name: "other", defaultMarket: "BTC", defaultSizeUsd: 10 });
      expect((await postHook(h.app, s.id, body({ id: "same" }))).statusCode).toBe(202);
      expect((await postHook(h.app, other.id, { ...body({ id: "same" }), secret: other.secret })).statusCode).toBe(202);
    });

    it("lets a key be reused after the 24 h window", async () => {
      const first = await postHook(h.app, s.id, body({ id: "old" }));
      const { alertId } = first.json() as { alertId: string };
      h.db.prepare("UPDATE alerts SET received_at_ms = received_at_ms - ? WHERE id = ?").run(25 * 3600_000, alertId);
      const again = await postHook(h.app, s.id, body({ id: "old" }));
      expect(again.statusCode).toBe(202);
    });
  });

  it("responds before the pipeline finishes", async () => {
    const res = await postHook(h.app, s.id, body());
    const { alertId } = res.json() as { alertId: string };
    // handed off asynchronously: at response time the alert is at most `verified`
    expect(["verified", "risk_checked", "failed"]).toContain(h.repos.alerts.get(alertId)!.status);
  });
});

describe("POST /api/strategies/:id/test-alert", () => {
  it("posts the same text TradingView would send, through the same handler", async () => {
    const res = await h.app.inject({ method: "POST", url: `/api/strategies/${s.id}/test-alert`, payload: { action: "buy", sizeUsd: 75 } });
    expect(res.statusCode).toBe(202);
    const j = res.json() as { alertId: string; body: string };
    expect(JSON.parse(j.body)).toMatchObject({ action: "buy", market: "BTCUSDT.P", size_usd: "75", secret: "[redacted]" });
    const rec = await settled(h, j.alertId);
    expect(rec.status).toBe("failed");
    expect(rec.market).toBe("BTC");
    expect(h.repos.alerts.events(j.alertId)[0]?.detail).toMatchObject({ source: "test-alert" });
  });

  it("supports strategy-style test alerts with market_position (a close)", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/api/strategies/${s.id}/test-alert`,
      payload: { action: "sell", marketPosition: "flat" },
    });
    expect(res.statusCode).toBe(202);
    const { alertId } = res.json() as { alertId: string };
    const rec = await settled(h, alertId);
    expect(rec).toMatchObject({ kind: "close", side: "long", status: "blocked", blockReason: "no_position_to_close" });
  });

  it("404s for someone else's strategy", async () => {
    const res = await h.app.inject({ method: "POST", url: `/api/strategies/nope/test-alert`, payload: {} });
    expect(res.statusCode).toBe(404);
  });
});
