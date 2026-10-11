import { afterEach, describe, expect, it } from "vitest";
import { HASH, startRig, waitFor, type Rig } from "./helpers";
import { PerplGeoBlockedError } from "../src/rest";
import { PerplSocketError } from "../src/trading-ws";
import { PerplClient } from "../src/client";
import { Ed25519Signer } from "../src/signing";
import { OrderStatus } from "../src/protocol";

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

describe("PerplClient against the simulator: happy path", () => {
  it("signs in, reads the account, head block and mark price", async () => {
    rig = await startRig();
    const { client, sim, key } = rig;
    expect(client.isConnected()).toBe(true);
    expect(client.markets.map((m) => m.symbol)).toEqual(["BTC", "ETH", "SOL", "MON", "ZEC"]);
    expect(client.context.collateral).toMatchObject({ symbol: "AUSD", decimals: 6, address: "0xa9012a055bd4e0edff8ce09f960291c09d5322dc" });
    expect(client.context.minAccountOpenAmount).toBe(100_000_000n);
    expect(client.context.markets.find((m) => m.symbol === "BTC")).toMatchObject({ id: 16, instanceId: 12, priceDecimals: 1, sizeDecimals: 5, orderTtlBlocks: 20, maxLeverageHdths: 1500 });

    const acc = await client.getAccount();
    expect(acc).toMatchObject({ connected: true, accountId: key.accountId, instanceId: 12, forwardingEnabled: true, balanceUsd: 10_000, equityUsd: 10_000, availableUsd: 10_000, openNotionalUsd: 0 });
    expect(await client.getPositions()).toEqual([]);

    const head = await client.headBlock();
    expect(head).toBeGreaterThanOrEqual(55_000_000);
    expect(head).toBeLessThanOrEqual(sim.blockNumber());

    const px = await client.getMarkPrice("BTC");
    expect(px).toBeGreaterThan(111_000);
    expect(px).toBeLessThan(113_000);
    expect(await client.getMarkPrice(48)).toBeGreaterThan(200);
    expect(await client.getMarkPrice("MON")).toBeCloseTo(0.04, 2);
    expect(await client.getMarkPrice("ZEC")).toBeGreaterThan(50);
  });

  it("market long on BTC -> fill -> position -> close -> realised PnL", async () => {
    rig = await startRig();
    const { client, sim, key } = rig;
    const events: string[] = [];
    client.on("realized", (r) => events.push(`realized:${r.pnlUsd.toFixed(4)}`));
    const lifecycle: string[] = [];
    const handlers = {
      sent: () => lifecycle.push("sent"),
      accepted: (e: { source: string }) => lifecycle.push(`accepted:${e.source}`),
      filled: () => lifecycle.push("filled"),
      partially_filled: () => lifecycle.push("partial"),
    };

    const open = await client.placeMarketOrder({ market: "BTC", side: "long", kind: "open", sizeUsd: 500, leverage: 3, maxSlippageBps: 50, tag: "alert-1", handlers });
    expect(open.status).toBe("filled");
    expect(open.tag).toBe("alert-1");
    expect(open.rq).toBe(1); // first rq after lfr 0
    expect(open.attempts).toBe(1);
    expect(open.fills).toHaveLength(1);
    expect(open.txHashes[0]).toMatch(HASH);
    expect(open.fills[0]?.block).toBeGreaterThanOrEqual(55_000_000);
    expect(open.fills[0]?.liquidity).toBe("taker");
    expect(lifecycle[0]).toBe("sent");
    expect(lifecycle).toContain("accepted:status");
    expect(lifecycle[lifecycle.length - 1]).toBe("filled");
    // 500 / ~112000 = 0.00446 BTC, floored to 5 decimals
    expect(open.filledSize).toBeGreaterThan(0.0044);
    expect(open.filledSize).toBeLessThanOrEqual(0.00447);
    expect(open.requestedSize).toBe(open.filledSize);
    // fee = notional * 345 micros
    const notional = open.filledSize * (open.avgPrice as number);
    expect(open.feeUsd).toBeCloseTo((notional * 345) / 1e6, 5);
    // adverse slippage 0..8 bps vs the mark at the time
    expect(open.avgPrice as number).toBeGreaterThan(sim.getPrice("BTC") * (1 - 0.002));

    const positions = await client.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ market: "BTC", marketId: 16, side: "long", leverage: 3 });
    expect(positions[0]?.size).toBe(open.filledSize);
    expect(positions[0]?.entryPrice).toBeCloseTo(open.avgPrice as number, 1);
    expect(positions[0]?.collateralUsd).toBeCloseTo(notional / 3, 2);

    const acc = await client.getAccount();
    expect(acc.positionCollateralUsd).toBeCloseTo(notional / 3, 2);
    expect(acc.balanceUsd).toBeCloseTo(10_000 - notional / 3 - open.feeUsd, 4);
    expect(acc.availableUsd).toBeCloseTo(acc.balanceUsd, 6);
    expect(acc.equityUsd).toBeCloseTo(10_000 - open.feeUsd + acc.unrealizedPnlUsd, 4);

    // move the market up 1% so the close realises a profit
    sim.setPrice("BTC", sim.getPrice("BTC") * 1.01);
    const close = await client.placeMarketOrder({ market: "BTC", side: "long", kind: "close", closeAll: true, maxSlippageBps: 50 });
    expect(close.status).toBe("filled");
    expect(close.rq).toBe(open.rq + 1);
    expect(close.filledSize).toBe(open.filledSize);
    expect(close.txHashes[0]).toMatch(HASH);
    expect(close.txHashes[0]).not.toBe(open.txHashes[0]);

    const expected = (close.avgPrice as number) * close.filledSize - (open.avgPrice as number) * open.filledSize - open.feeUsd - close.feeUsd;
    expect(close.realizedPnlUsd).toBeDefined();
    expect(close.realizedPnlUsd as number).toBeCloseTo(expected, 3);
    expect(close.realizedPnlUsd as number).toBeGreaterThan(0);
    expect(events).toHaveLength(1);

    expect(await client.getPositions()).toEqual([]);
    const after = await client.getAccount();
    expect(after.positionCollateralUsd).toBe(0);
    expect(after.realizedPnlTodayUsd).toBeCloseTo(close.realizedPnlUsd as number, 6);
    expect(after.balanceUsd).toBeCloseTo(10_000 + (close.realizedPnlUsd as number), 3);
    expect(sim.account(key.accountId)?.balanceAusd).toBeCloseTo(after.balanceUsd, 3);
    expect(sim.account(key.accountId)?.realizedPnlAusd).toBeCloseTo(close.realizedPnlUsd as number, 3);
    expect(sim.executedOrders()).toHaveLength(2);
    // rq were persisted before sending and are strictly increasing
    expect(rig.rqLog).toEqual([open.rq, close.rq]);
  });

  it("short that loses money, partial close, then the rest", async () => {
    rig = await startRig();
    const { client, sim } = rig;
    const open = await client.placeMarketOrder({ market: "ETH", side: "short", kind: "open", sizeBase: 1, leverage: 5 });
    expect(open.status).toBe("filled");
    expect(open.filledSize).toBe(1);
    sim.setPrice("ETH", sim.getPrice("ETH") * 1.02);
    const half = await client.placeMarketOrder({ market: "ETH", side: "short", kind: "close", sizeBase: 0.4 });
    expect(half.status).toBe("filled");
    expect(half.filledSize).toBe(0.4);
    expect(half.realizedPnlUsd as number).toBeLessThan(0);
    const p = await client.getPositions();
    expect(p[0]?.size).toBeCloseTo(0.6, 6);
    // asking for more than the position closes only what exists (reduce-only clamp)
    const rest = await client.placeMarketOrder({ market: "ETH", side: "short", kind: "close", sizeBase: 5 });
    expect(rest.filledSize).toBeCloseTo(0.6, 6);
    expect(await client.getPositions()).toEqual([]);
    const acc = await client.getAccount();
    expect(acc.realizedPnlTodayUsd).toBeLessThan(0);
    expect(acc.balanceUsd).toBeCloseTo(10_000 + acc.realizedPnlTodayUsd, 3);
  });

  it("adding to a long keeps one position with a weighted entry", async () => {
    rig = await startRig();
    const { client } = rig;
    const a = await client.placeMarketOrder({ market: "SOL", side: "long", kind: "open", sizeBase: 10, leverage: 2 });
    const b = await client.placeMarketOrder({ market: "SOL", side: "long", kind: "open", sizeBase: 5, leverage: 2 });
    const p = await client.getPositions();
    expect(p).toHaveLength(1);
    expect(p[0]?.size).toBe(15);
    const avg = ((a.avgPrice as number) * 10 + (b.avgPrice as number) * 5) / 15;
    expect(p[0]?.entryPrice).toBeCloseTo(avg, 1);
  });

  it("emits typed events: order, fill, positions, status, heartbeat, account", async () => {
    rig = await startRig();
    const { client } = rig;
    const seen = new Set<string>();
    client.on("order", () => seen.add("order"));
    client.on("fill", (f) => {
      seen.add("fill");
      expect(f.market).toBe("BTC");
    });
    client.on("positions", () => seen.add("positions"));
    client.on("status", () => seen.add("status"));
    client.on("heartbeat", () => seen.add("heartbeat"));
    client.on("account", () => seen.add("account"));
    await client.placeMarketOrder({ market: "BTC", side: "long", kind: "open", sizeBase: 0.001, leverage: 2 });
    await waitFor(() => seen.has("positions") && seen.has("account") && seen.has("heartbeat"));
    expect([...seen].sort()).toEqual(["account", "fill", "heartbeat", "order", "positions", "status"]);
  });

  it("a reconnect snapshot restores positions", async () => {
    rig = await startRig();
    const { client, sim } = rig;
    await client.placeMarketOrder({ market: "BTC", side: "long", kind: "open", sizeBase: 0.002, leverage: 2 });
    sim.dropConnections(1001, "restart");
    await waitFor(() => client.tradingSocket.epoch >= 2 && client.isConnected());
    const p = await client.getPositions();
    expect(p).toHaveLength(1);
    expect(p[0]?.size).toBe(0.002);
  });
});

describe("rejections and local validation", () => {
  it("forwarding disabled fails locally (nothing sent) until allowOrderForwarding is on", async () => {
    rig = await startRig({ account: { forwarding: false } });
    const { client, sim, key } = rig;
    const out = await client.placeMarketOrder({ market: "BTC", side: "long", kind: "open", sizeBase: 0.001, leverage: 2 });
    expect(out.status).toBe("failed");
    expect(out.failure?.code).toBe("forwarding_disabled");
    expect(sim.receivedOrderFrames()).toBe(0);
    expect(rig.rqLog).toEqual([]);
    sim.setForwarding(key.accountId, true);
    await waitFor(() => client.getAccounts().find((a) => a.id === key.accountId)?.fw === true);
    const ok = await client.placeMarketOrder({ market: "BTC", side: "long", kind: "open", sizeBase: 0.001, leverage: 2 });
    expect(ok.status).toBe("filled");
  });

  it("the gateway sr 34 path (forwarding switched off behind the client's back)", async () => {
    rig = await startRig();
    const { client, sim, key } = rig;
    // flip it on the server WITHOUT the client having processed the mt:21 yet: disable the local check
    const out = await (async () => {
      sim.setForwarding(key.accountId, false);
      await waitFor(() => client.getAccounts()[0]?.fw === false);
      client.orderTracker.setAccounts([{ ...client.getAccounts()[0]!, fw: true }]);
      return client.placeMarketOrder({ market: "BTC", side: "long", kind: "open", sizeBase: 0.001, leverage: 2 });
    })();
    expect(out.status).toBe("failed");
    expect(out.failure).toMatchObject({ source: "order", code: "sr:34", st: OrderStatus.Failed, sr: 34 });
    expect(out.failure?.message).toMatch(/allowOrderForwarding/);
  });

  it("insufficient balance: settlement failure with readable fr", async () => {
    rig = await startRig({ account: { balanceAusd: 100 } });
    const out = await rig.client.placeMarketOrder({ market: "BTC", side: "long", kind: "open", sizeUsd: 50_000, leverage: 5 });
    expect(out.status).toBe("failed");
    expect(out.failure).toMatchObject({ code: "sr:44", fr: 1 });
    expect(out.failure?.message).toMatch(/balance is below the collateral/);
    expect(await rig.client.getPositions()).toEqual([]);
  });

  it("leverage above the market maximum, zero lots and missing size never reach the wire", async () => {
    rig = await startRig();
    const { client, sim } = rig;
    const lev = await client.placeMarketOrder({ market: "MON", side: "long", kind: "open", sizeBase: 1000, leverage: 10 });
    expect(lev.failure?.code).toBe("invalid_order");
    expect(lev.failure?.message).toMatch(/exceeds the market maximum 3x/);
    const dust = await client.placeMarketOrder({ market: "BTC", side: "long", kind: "open", sizeUsd: 0.5, leverage: 2 });
    expect(dust.failure?.code).toBe("size_too_small");
    const none = await client.placeMarketOrder({ market: "BTC", side: "long", kind: "open", leverage: 2 });
    expect(none.failure?.code).toBe("invalid_order");
    const noPos = await client.placeMarketOrder({ market: "BTC", side: "long", kind: "close" });
    expect(noPos.failure?.code).toBe("no_position");
    expect(sim.receivedOrderFrames()).toBe(0);
    await expect(client.placeMarketOrder({ market: "DOGE", side: "long", kind: "open", sizeBase: 1 })).rejects.toThrow(/unknown Perpl market/);
  });

  it("max slippage is clamped to the market maximum", async () => {
    rig = await startRig();
    const { client } = rig;
    const frames: Array<Record<string, unknown>> = [];
    const sock = client.tradingSocket;
    const orig = sock.send.bind(sock);
    sock.send = (f: object, o?: { maxWaitMs?: number }) => {
      frames.push(f as Record<string, unknown>);
      return orig(f, o);
    };
    await client.placeMarketOrder({ market: "MON", side: "long", kind: "open", sizeBase: 1000, leverage: 2, maxSlippageBps: 900 });
    expect(frames[0]).toMatchObject({ mkt: 64, ms: 100, fl: 4, p: 0, lb: 0, lv: 200, s: 1000, t: 1 });
  });
});

describe("connection errors", () => {
  it("bad signature -> 3401 surfaced as PerplSocketError", async () => {
    rig = await startRig({ connect: false });
    const wrong = new PerplClient({ restUrl: rig.sim.url, wsUrl: rig.sim.wsUrl, apiKey: rig.key.apiKey, apiSecret: Ed25519Signer.generate().seedHex });
    await expect(wrong.connect()).rejects.toThrow(PerplSocketError);
    await expect(wrong.connect()).rejects.toThrow(/3401/);
    await wrong.close();
  });

  it("HTTP 451 is surfaced clearly", async () => {
    rig = await startRig({ sim: { geoBlocked: true }, connect: false });
    await expect(rig.client.connect()).rejects.toThrow(PerplGeoBlockedError);
    await expect(rig.client.connect()).rejects.toThrow(/451.*geo/s);
  });
});
