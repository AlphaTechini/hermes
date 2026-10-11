import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startPerplSimulator, type PerplSimulator } from "../src/sim";
import { buildSignInFrame } from "../src/signing";
import { PerplRest, PerplHttpError } from "../src/rest";
import { buildOrderRequest, parseServerFrame, type ServerFrame } from "../src/protocol";
import { HASH, waitFor } from "./helpers";

let sim: PerplSimulator | undefined;
afterEach(async () => {
  await sim?.stop();
  sim = undefined;
});

const fast = { seed: 3, latencyMs: [20, 40] as [number, number], blockTimeMs: 30, heartbeatIntervalMs: 60 };

interface Raw {
  ws: WebSocket;
  frames: ServerFrame[];
  closed: Promise<{ code: number; reason: string }>;
  send(o: object): void;
}

function rawConnect(url: string, path = "/ws/v1/trading"): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url + path);
    const frames: ServerFrame[] = [];
    const closed = new Promise<{ code: number; reason: string }>((res) => ws.on("close", (code, reason) => res({ code, reason: reason.toString() })));
    ws.on("message", (d) => {
      const r = parseServerFrame(d.toString());
      if (r.ok) frames.push(r.frame);
    });
    ws.on("open", () => resolve({ ws, frames, closed, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.on("error", reject);
  });
}

async function setup(opts: Parameters<typeof startPerplSimulator>[0] = {}) {
  sim = await startPerplSimulator({ ...fast, ...opts });
  const key = sim.enrollNewKey();
  return { sim, key };
}

describe("simulator: trading socket protocol", () => {
  it("signs in with a verified signature and sends 19, 23, 26 in that order, then heartbeats +1", async () => {
    const { sim, key } = await setup();
    const c = await rawConnect(sim.wsUrl);
    c.send(buildSignInFrame(key.signer, 10143, key.apiKey));
    await waitFor(() => c.frames.filter((f) => f.mt === 100).length >= 4);
    expect(c.frames.slice(0, 3).map((f) => f.mt)).toEqual([19, 23, 26]);
    const wallet = c.frames[0] as { sn: number; as: Array<{ id: number; in: number; fw: boolean; lfr: number; b: string }> };
    expect(wallet.as[0]).toMatchObject({ id: key.accountId, in: 12, fw: true, lfr: 0, b: "10000000000" });
    const hbs = c.frames.filter((f) => f.mt === 100) as Array<{ sn: number; h: number }>;
    expect(hbs[0]?.sn).toBe(wallet.sn + 1);
    for (let i = 1; i < hbs.length; i++) {
      expect(hbs[i]?.sn).toBe((hbs[i - 1] as { sn: number }).sn + 1);
      expect(hbs[i]?.h).toBeGreaterThanOrEqual((hbs[i - 1] as { h: number }).h);
    }
    c.ws.close();
  });

  it("rejects a bad signature, an unknown key, a replayed nonce and a stale timestamp with 3401", async () => {
    const { sim, key } = await setup();
    const other = (await import("../src/signing")).Ed25519Signer.generate().signer;
    const cases: Array<[string, object]> = [
      ["bad signature", buildSignInFrame(other, 10143, key.apiKey)],
      ["unknown key", buildSignInFrame(key.signer, 10143, "nope")],
      ["stale", buildSignInFrame(key.signer, 10143, key.apiKey, { nowMs: Date.now() - 60_000 })],
      ["wrong chain", buildSignInFrame(key.signer, 1, key.apiKey)],
    ];
    for (const [name, frame] of cases) {
      const c = await rawConnect(sim.wsUrl);
      c.send(frame);
      const close = await c.closed;
      expect(close.code, name).toBe(3401);
    }
    // replay: the same frame twice
    const frame = buildSignInFrame(key.signer, 10143, key.apiKey);
    const a = await rawConnect(sim.wsUrl);
    a.send(frame);
    await waitFor(() => a.frames.length > 0);
    const b = await rawConnect(sim.wsUrl);
    b.send(frame);
    expect((await b.closed).code).toBe(3401);
    a.ws.close();
  });

  it("first frame must be the sign-in", async () => {
    const { sim } = await setup();
    const c = await rawConnect(sim.wsUrl);
    c.send({ mt: 1, t: Date.now() });
    expect((await c.closed).code).toBe(3401);
  });

  it("closes with 1008 `idle timeout` when no sign-in arrives in time", async () => {
    const { sim } = await setup({ idleTimeoutMs: 250 });
    const c = await rawConnect(sim.wsUrl);
    const t0 = Date.now();
    const close = await c.closed;
    expect(close).toEqual({ code: 1008, reason: "idle timeout" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
  });

  it("answers ping with pong", async () => {
    const { sim, key } = await setup();
    const c = await rawConnect(sim.wsUrl);
    c.send(buildSignInFrame(key.signer, 10143, key.apiKey));
    await waitFor(() => c.frames.length >= 3);
    c.send({ mt: 1, t: 123 });
    await waitFor(() => c.frames.some((f) => f.mt === 2));
    c.ws.close();
  });

  it("order flow on the wire: mt:3 (cid = sn) then mt:24, mt:25, mt:27, mt:21; duplicate rq does not execute twice", async () => {
    const { sim, key } = await setup();
    const c = await rawConnect(sim.wsUrl);
    c.send(buildSignInFrame(key.signer, 10143, key.apiKey));
    await waitFor(() => c.frames.length >= 3);
    const spec = { rq: 1001, mkt: 16, acc: key.accountId, t: 1, p: 0, s: 100, fl: 4, lv: 300, lb: 0, ms: 50 };
    const t0 = Date.now();
    c.send(buildOrderRequest(spec, 17));
    await waitFor(() => c.frames.some((f) => f.mt === 25));
    const dt = Date.now() - t0;
    expect(dt).toBeGreaterThanOrEqual(15);
    const st = c.frames.find((f) => f.mt === 3) as { cid: number; sid: number; status: { code: number } };
    expect(st).toMatchObject({ cid: 17, sid: 100, status: { code: 0 } });
    const order = (c.frames.find((f) => f.mt === 24) as unknown as { d: Array<Record<string, unknown>> }).d[0] as Record<string, unknown>;
    expect(order).toMatchObject({ rq: 1001, mkt: 16, acc: key.accountId, st: 4, sr: 43, os: 100, fs: 100, r: true });
    expect((order.at as { txid: string }).txid).toMatch(HASH);
    const fill = (c.frames.find((f) => f.mt === 25) as unknown as { d: Array<Record<string, unknown>> }).d[0];
    expect(fill).toMatchObject({ oid: order.oid, l: 2, s: 100 });
    expect(fill?.p).toBe(order.fp);
    await waitFor(() => c.frames.some((f) => f.mt === 27) && c.frames.some((f) => f.mt === 21));
    const acct = c.frames.find((f) => f.mt === 21) as { lfr: number };
    expect(acct.lfr).toBe(1001);
    // duplicate
    c.send(buildOrderRequest(spec, 18));
    await waitFor(() => c.frames.filter((f) => f.mt === 3).length === 2);
    await new Promise((r) => setTimeout(r, 150));
    expect(sim.executedOrders()).toHaveLength(1);
    expect(sim.account(key.accountId)?.positions[0]?.lots).toBe(100);
    // replay of the recorded result goes to the re-sender
    expect(c.frames.filter((f) => f.mt === 24).length).toBe(2);
    c.ws.close();
  });

  it("rq <= lfr (not a repeat) fails with sr 32 after an ok mt:3", async () => {
    const { sim, key } = await setup();
    const c = await rawConnect(sim.wsUrl);
    c.send(buildSignInFrame(key.signer, 10143, key.apiKey));
    await waitFor(() => c.frames.length >= 3);
    const base = { mkt: 16, acc: key.accountId, t: 1, p: 0, s: 100, fl: 4, lv: 300, lb: 0 };
    c.send(buildOrderRequest({ ...base, rq: 50 }, 1));
    await waitFor(() => c.frames.some((f) => f.mt === 25));
    c.send(buildOrderRequest({ ...base, rq: 40 }, 2));
    await waitFor(() => c.frames.filter((f) => f.mt === 24).length === 2);
    const second = (c.frames.filter((f) => f.mt === 24)[1] as { d: Array<{ rq: number; st: number; sr: number }> }).d[0];
    expect(second).toMatchObject({ rq: 40, st: 7, sr: 32 });
    expect(sim.executedOrders()).toHaveLength(1);
    c.ws.close();
  });

  it("lb validation: expired and too-high windows are mt:3 400", async () => {
    const { sim, key } = await setup();
    const c = await rawConnect(sim.wsUrl);
    c.send(buildSignInFrame(key.signer, 10143, key.apiKey));
    await waitFor(() => c.frames.length >= 3);
    const base = { mkt: 16, acc: key.accountId, t: 1, p: 0, s: 100, fl: 4, lv: 300 };
    c.send(buildOrderRequest({ ...base, rq: 1, lb: sim.blockNumber() - 1 }, 1));
    c.send(buildOrderRequest({ ...base, rq: 2, lb: sim.blockNumber() + 21 + 50 }, 2));
    c.send(buildOrderRequest({ ...base, rq: 3, lb: 0, mnp: 70000 }, 3));
    await waitFor(() => c.frames.filter((f) => f.mt === 3).length === 3);
    const st = c.frames.filter((f) => f.mt === 3) as Array<{ cid: number; status: { code: number; error: string } }>;
    expect(st.map((s) => [s.cid, s.status.code])).toEqual([[1, 400], [2, 400], [3, 400]]);
    expect(st[0]?.status.error).toBe("last exec block already expired");
    expect(st[1]?.status.error).toBe("last exec block too high");
    expect(st[2]?.status.error).toBe("max negative pnl collateralization out of range");
    expect(sim.executedOrders()).toHaveLength(0);
    c.ws.close();
  });

  it("unknown market, foreign account and unparseable frames close with 1011 and NO status", async () => {
    const { sim, key } = await setup();
    const base = { rq: 1, t: 1, p: 0, s: 100, fl: 4, lv: 300, lb: 0 };
    const cases: Array<[string, (c: Raw) => void]> = [
      ["unknown market", (c) => c.send(buildOrderRequest({ ...base, mkt: 999, acc: key.accountId }, 1))],
      ["foreign account", (c) => c.send(buildOrderRequest({ ...base, mkt: 16, acc: key.accountId + 1 }, 1))],
      ["negative mnp", (c) => c.send({ mt: 22, sn: 1, ...base, mkt: 16, acc: key.accountId, mnp: -1 })],
      ["bad json", (c) => c.ws.send("{nope")],
    ];
    for (const [name, act] of cases) {
      const c = await rawConnect(sim.wsUrl);
      c.send(buildSignInFrame(key.signer, 10143, key.apiKey));
      await waitFor(() => c.frames.length >= 3);
      act(c);
      const close = await c.closed;
      expect(close.code, name).toBe(1011);
      expect(c.frames.some((f) => f.mt === 3), name).toBe(false);
    }
  });

  it("read-scoped key: state is visible, orders get mt:3 403", async () => {
    const { sim } = await setup();
    const k = sim.enrollNewKey({ scope: "read" });
    const c = await rawConnect(sim.wsUrl);
    c.send(buildSignInFrame(k.signer, 10143, k.apiKey));
    await waitFor(() => c.frames.length >= 3);
    c.send(buildOrderRequest({ rq: 1, mkt: 16, acc: k.accountId, t: 1, p: 0, s: 100, fl: 4, lv: 300, lb: 0 }, 1));
    await waitFor(() => c.frames.some((f) => f.mt === 3));
    expect((c.frames.find((f) => f.mt === 3) as { status: { code: number; error: string } }).status).toEqual({ code: 403, error: "api key lacks trade scope" });
    c.ws.close();
  });

  it("rate limit: the 61st request in a minute closes with 1008", async () => {
    const { sim, key } = await setup();
    const c = await rawConnect(sim.wsUrl);
    c.send(buildSignInFrame(key.signer, 10143, key.apiKey));
    await waitFor(() => c.frames.length >= 3);
    for (let i = 0; i < 70; i++) if (c.ws.readyState === WebSocket.OPEN) c.send({ mt: 1, t: i });
    const close = await c.closed;
    expect(close).toEqual({ code: 1008, reason: "too many requests" });
  });

  it("at most 4 connections per wallet", async () => {
    const { sim, key } = await setup();
    const conns: Raw[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await rawConnect(sim.wsUrl);
      c.send(buildSignInFrame(key.signer, 10143, key.apiKey));
      await waitFor(() => c.frames.length >= 3);
      conns.push(c);
    }
    const fifth = await rawConnect(sim.wsUrl);
    fifth.send(buildSignInFrame(key.signer, 10143, key.apiKey));
    expect(await fifth.closed).toEqual({ code: 1008, reason: "too many connections" });
    expect(sim.tradingConnections()).toBe(4);
    for (const c of conns) c.ws.close();
  });

  it("resting limit order fills as maker when the market crosses it, cancel works", async () => {
    const { sim, key } = await setup();
    const c = await rawConnect(sim.wsUrl);
    c.send(buildSignInFrame(key.signer, 10143, key.apiKey));
    await waitFor(() => c.frames.length >= 3);
    sim.setPrice("ETH", 4100);
    // buy limit well below the market: rests
    c.send(buildOrderRequest({ rq: 1, mkt: 32, acc: key.accountId, t: 1, p: 400000, s: 1000, fl: 0, lv: 200, lb: 0 }, 1));
    await waitFor(() => c.frames.some((f) => f.mt === 24));
    const open = (c.frames.find((f) => f.mt === 24) as { d: Array<{ oid: number; st: number }> }).d[0];
    expect(open?.st).toBe(2);
    // cancel it
    c.send(buildOrderRequest({ rq: 2, mkt: 32, acc: key.accountId, oid: open?.oid as number, t: 5, s: 0, fl: 0, lv: 0, lb: 0 }, 2));
    await waitFor(() => c.frames.filter((f) => f.mt === 24).length === 2);
    expect((c.frames.filter((f) => f.mt === 24)[1] as { d: Array<{ st: number }> }).d[0]?.st).toBe(5);
    // another one that the market will cross
    c.send(buildOrderRequest({ rq: 3, mkt: 32, acc: key.accountId, t: 1, p: 405000, s: 1000, fl: 0, lv: 200, lb: 0 }, 3));
    await waitFor(() => c.frames.filter((f) => f.mt === 24).length === 3);
    sim.setPrice("ETH", 4040);
    await waitFor(() => c.frames.some((f) => f.mt === 25));
    const fill = (c.frames.find((f) => f.mt === 25) as { d: Array<{ l: number; p: number }> }).d[0];
    expect(fill).toMatchObject({ l: 1, p: 405000 });
    expect(sim.account(key.accountId)?.positions[0]).toMatchObject({ symbol: "ETH", lots: 1000, entryScaled: 405000 });
    c.ws.close();
  });
});

describe("simulator: signed REST", () => {
  it("serves the context and verifies request signatures", async () => {
    const { sim, key } = await setup();
    const rest = new PerplRest({ baseUrl: sim.url, chainId: 10143, apiKey: key.apiKey, apiSecret: key.signer });
    const ctx = await rest.getContext();
    expect(ctx.markets).toHaveLength(5);
    expect(ctx.geoBlock).toContain("US");
    expect(ctx.features).toMatchObject({ apiKeysEnabled: "on" });
    const w = await rest.getWallet();
    expect(w.as[0]).toMatchObject({ id: key.accountId, in: 12 });
    expect((await rest.getOrders()).d).toEqual([]);
    expect((await rest.getPositions()).d).toEqual([]);
    expect((await rest.getTicker()).sn).toBeGreaterThan(0);
    expect(Object.keys((await rest.getMarketTicker(16)).d)).toEqual(["16"]);
    const book = await rest.getBook(16, 3);
    expect(book.bid).toHaveLength(3);
    expect((await rest.getHeadBlock()) ?? 0).toBeGreaterThan(0);

    // wrong key -> 401
    const bad = new PerplRest({ baseUrl: sim.url, chainId: 10143, apiKey: key.apiKey, apiSecret: (await import("../src/signing")).Ed25519Signer.generate().signer });
    await expect(bad.getWallet()).rejects.toMatchObject({ status: 401 });
    // unsigned client -> auth error before any request
    const anon = new PerplRest({ baseUrl: sim.url, chainId: 10143 });
    await expect(anon.getWallet()).rejects.toThrow(/needs an API key/);
    // wrong chain id in the canonical string -> 401
    const wrongChain = new PerplRest({ baseUrl: sim.url, chainId: 1, apiKey: key.apiKey, apiSecret: key.signer });
    await expect(wrongChain.getWallet()).rejects.toBeInstanceOf(PerplHttpError);
  });

  it("history endpoints with pagination, and POST /v1/trading/orders", async () => {
    const { sim, key } = await setup();
    const rest = new PerplRest({ baseUrl: sim.url, chainId: 10143, apiKey: key.apiKey, apiSecret: key.signer });
    const specs = [1, 2, 3].map((rq) => ({ rq, mkt: 16, acc: key.accountId, t: 1, p: 0, s: 100, fl: 4, lv: 300, lb: 0 }));
    const res = await rest.postOrders(specs, 9);
    expect(res).toMatchObject({ mt: 31, cid: 9, status: { code: 0 } });
    expect(res.statuses?.map((s) => s.code)).toEqual([0, 0, 0]);
    // re-sending a known rq is the retry mechanism: accepted, never executed twice
    const again = await rest.postOrders([{ ...specs[0]!, rq: 2 }]);
    expect(again.statuses?.[0]?.code).toBe(0);
    // foreign account positional 403
    const mixed = await rest.postOrders([{ ...specs[0]!, rq: 10 }, { ...specs[0]!, rq: 11, acc: 99999 }]);
    expect(mixed.statuses?.map((s) => s.code)).toEqual([0, 403]);
    // an unknown rq below the last accepted one is refused up front with 400
    const low = await rest.postOrders([{ ...specs[0]!, rq: 5 }]);
    expect(low.statuses?.[0]?.code).toBe(400);
    await waitFor(() => sim.executedOrders().length === 4, 3000);

    const page1 = await rest.getFills({ count: 3 });
    expect(page1.d).toHaveLength(3);
    expect(page1.np).toBe("3");
    const all = await rest.fetchAllPages((q) => rest.getFills(q), { count: 3 });
    expect(all).toHaveLength(4);
    const hist = await rest.getOrderHistory({ count: 100 });
    expect(hist.d.map((o) => o.rq).sort((a, b) => a - b)).toEqual([1, 2, 3, 10]); // (newest first; execution order depends on the random latency)
    expect((await rest.getPositionHistory()).d.length).toBe(4);
    expect((await rest.getAccountHistory()).d.length).toBeGreaterThan(0);
    const found = await rest.findOrdersByRq(2, key.accountId);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rq: 2, st: 4 });
    expect(await rest.findOrdersByRq(777)).toEqual([]);
    const pos = await rest.getPositions();
    expect(pos.d[0]?.s).toBe(400);
  });

  it("a read-scoped key cannot POST orders (403)", async () => {
    const { sim } = await setup();
    const k = sim.enrollNewKey({ scope: "read" });
    const rest = new PerplRest({ baseUrl: sim.url, chainId: 10143, apiKey: k.apiKey, apiSecret: k.signer });
    const res = await rest.postOrders([{ rq: 1, mkt: 16, acc: k.accountId, t: 1, p: 0, s: 100, fl: 4, lv: 300, lb: 0 }]);
    expect(res.status).toMatchObject({ code: 403 });
  });
});

describe("simulator: market data", () => {
  it("honours subscriptions, 16-subscription cap and 10 requests/min", async () => {
    const { sim } = await setup();
    const c = await rawConnect(sim.wsUrl, "/ws/v1/market-data");
    c.send({ mt: 5, subs: [{ stream: "market-state@10143", subscribe: true }, { stream: "heartbeat@10143", subscribe: true }, { stream: "nope@1", subscribe: true }] });
    await waitFor(() => c.frames.some((f) => f.mt === 6));
    const resp = c.frames.find((f) => f.mt === 6) as { subs: Array<{ stream: string; status?: { code: number } }> };
    expect(resp.subs.map((s) => s.status?.code)).toEqual([0, 0, 404]);
    await waitFor(() => c.frames.some((f) => f.mt === 9) && c.frames.some((f) => f.mt === 100));
    const state = c.frames.find((f) => f.mt === 9) as { d: Record<string, { mrk: number }> };
    expect(Object.keys(state.d).sort()).toEqual(["16", "256", "32", "48", "64"]);
    expect(state.d["16"]?.mrk).toBeGreaterThan(1_000_000); // scaled by 1 decimal
    for (let i = 0; i < 12; i++) if (c.ws.readyState === WebSocket.OPEN) c.send({ mt: 5, subs: [] });
    expect((await c.closed).code).toBe(1008);
  });
});

describe("simulator: prices", () => {
  it("start at the configured levels and move like a random walk", async () => {
    const { sim } = await setup({ initialPrices: { BTC: 112000 }, volMultiplier: 50 });
    const start = { BTC: sim.getPrice("BTC"), ETH: sim.getPrice("ETH"), SOL: sim.getPrice("SOL"), MON: sim.getPrice("MON"), ZEC: sim.getPrice("ZEC") };
    expect(start.BTC).toBeCloseTo(112000, -1);
    expect(start.ETH).toBeCloseTo(4100, -1);
    expect(start.SOL).toBeCloseTo(210, 0);
    expect(start.MON).toBeCloseTo(0.04, 3);
    expect(start.ZEC).toBeCloseTo(60, 0);
    await new Promise((r) => setTimeout(r, 400));
    expect(sim.getPrice("BTC")).not.toBe(start.BTC);
    expect(Math.abs(sim.getPrice("BTC") / start.BTC - 1)).toBeLessThan(0.05);
  });

  it("is reproducible for a seed", async () => {
    const a = await startPerplSimulator({ seed: 99, blockTimeMs: 20, heartbeatIntervalMs: 1000 });
    const b = await startPerplSimulator({ seed: 99, blockTimeMs: 20, heartbeatIntervalMs: 1000 });
    await new Promise((r) => setTimeout(r, 300));
    const ratioA = a.getPrice("BTC");
    const ratioB = b.getPrice("BTC");
    // same seed and the same number of steps would be identical; allow a few steps of drift between the two timers
    expect(Math.abs(ratioA / ratioB - 1)).toBeLessThan(0.001);
    await a.stop();
    await b.stop();
  });
});
