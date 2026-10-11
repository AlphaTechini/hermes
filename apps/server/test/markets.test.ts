import { afterEach, describe, expect, it } from "vitest";
import { MARKETS, MARKET_SYMBOLS, type MarketDTO } from "@hermes/shared";
import { makeHarness, type Harness } from "./support/harness";
import { MockPerplClient, MockProvider } from "./support/mock-perpl";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("GET /api/markets", () => {
  it("returns every Perpl market with its mark price, with no position open", async () => {
    const client = new MockPerplClient();
    client.prices[MARKETS.SOL.id] = 190.25;
    h = await makeHarness({ perpl: new MockProvider(client) });
    const res = await h.app.inject({ method: "GET", url: "/api/markets" });
    expect(res.statusCode).toBe(200);
    const rows = res.json<MarketDTO[]>();
    expect(rows.map((r) => r.symbol)).toEqual([...MARKET_SYMBOLS]);
    expect(rows.find((r) => r.symbol === "BTC")).toMatchObject({ id: MARKETS.BTC.id, markPrice: 100_000 });
    expect(rows.find((r) => r.symbol === "SOL")).toMatchObject({ id: MARKETS.SOL.id, markPrice: 190.25 });
    // The mock has no price for MON: unavailable is null, never 0.
    expect(rows.find((r) => r.symbol === "MON")?.markPrice).toBeNull();
  });

  it("lists the markets with null prices when Perpl is not connected", async () => {
    const client = new MockPerplClient();
    client.connected = false;
    h = await makeHarness({ perpl: new MockProvider(client) });
    const rows = (await h.app.inject({ method: "GET", url: "/api/markets" })).json<MarketDTO[]>();
    expect(rows).toHaveLength(MARKET_SYMBOLS.length);
    expect(rows.every((r) => r.markPrice === null)).toBe(true);
  });

  it("works without any Perpl provider", async () => {
    h = await makeHarness();
    const res = await h.app.inject({ method: "GET", url: "/api/markets" });
    expect(res.statusCode).toBe(200);
    expect(res.json<MarketDTO[]>().every((r) => r.markPrice === null)).toBe(true);
  });
});
