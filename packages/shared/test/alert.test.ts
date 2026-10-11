import { describe, expect, it } from "vitest";
import {
  AlertPayload,
  normalizeMarket,
  parseAlert,
  renderTradingViewMessage,
  resolveIntent,
  tradeDirection,
  tradingViewTemplates,
} from "../src";

describe("normalizeMarket", () => {
  it.each([
    ["BTC", "BTC"],
    ["btc", "BTC"],
    ["BTCUSD", "BTC"],
    ["BTCUSDT", "BTC"],
    ["BTCUSDT.P", "BTC"],
    ["BINANCE:BTCUSDT.P", "BTC"],
    ["BYBIT:ETHUSDT.P", "ETH"],
    ["BTC-PERP", "BTC"],
    ["SOL-USD-PERP", "SOL"],
    ["BTC/USDT:USDT", "BTC"],
    ["BTC_USDT", "BTC"],
    ["MONUSDT", "MON"],
    ["ZECUSDC", "ZEC"],
    ["XBTUSD", "BTC"],
    ["  eth/usd ", "ETH"],
    ["DOGEUSDT.P", "DOGE"],
    ["", ""],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeMarket(input)).toBe(expected);
  });
});

describe("resolveIntent", () => {
  it("explicit actions ignore market_position", () => {
    expect(resolveIntent({ action: "long", market_position: "flat" })).toEqual({ side: "long", kind: "open" });
    expect(resolveIntent({ action: "short" })).toEqual({ side: "short", kind: "open" });
    expect(resolveIntent({ action: "close_long" })).toEqual({ side: "long", kind: "close" });
    expect(resolveIntent({ action: "close_short", market_position: "long" })).toEqual({ side: "short", kind: "close" });
    expect(resolveIntent({ action: "close" })).toEqual({ side: null, kind: "close" });
    expect(resolveIntent({ action: "flat" })).toEqual({ side: null, kind: "close" });
  });
  it("plain buy/sell are opens", () => {
    expect(resolveIntent({ action: "buy" })).toEqual({ side: "long", kind: "open" });
    expect(resolveIntent({ action: "sell" })).toEqual({ side: "short", kind: "open" });
  });
  it("strategy placeholders: market_position is the position AFTER the order", () => {
    expect(resolveIntent({ action: "buy", market_position: "long" })).toEqual({ side: "long", kind: "open" });
    expect(resolveIntent({ action: "sell", market_position: "short" })).toEqual({ side: "short", kind: "open" });
    expect(resolveIntent({ action: "sell", market_position: "flat" })).toEqual({ side: "long", kind: "close" });
    expect(resolveIntent({ action: "buy", market_position: "flat" })).toEqual({ side: "short", kind: "close" });
    expect(resolveIntent({ action: "sell", market_position: "long" })).toEqual({ side: "long", kind: "close" });
    expect(resolveIntent({ action: "buy", market_position: "short" })).toEqual({ side: "short", kind: "close" });
  });
});

describe("tradeDirection", () => {
  it("maps position side + kind to book direction", () => {
    expect(tradeDirection("long", "open")).toBe("buy");
    expect(tradeDirection("short", "open")).toBe("sell");
    expect(tradeDirection("long", "close")).toBe("sell");
    expect(tradeDirection("short", "close")).toBe("buy");
  });
});

describe("AlertPayload", () => {
  it("coerces strings, case-insensitive action, ISO time", () => {
    const p = AlertPayload.parse({
      secret: "s3cret",
      action: "  BUY ",
      market: "BINANCE:BTCUSDT.P",
      size_usd: "250.5",
      price: "112,034.5",
      leverage: "3",
      max_slippage_bps: "25",
      time: "2026-10-11T12:00:00Z",
      market_position: "LONG",
      id: 42,
    });
    expect(p).toMatchObject({
      secret: "s3cret",
      action: "buy",
      market: "BTC",
      size_usd: 250.5,
      price: 112034.5,
      leverage: 3,
      max_slippage_bps: 25,
      time: Date.parse("2026-10-11T12:00:00Z"),
      market_position: "long",
      id: "42",
    });
  });
  it("treats empty strings as absent and accepts epoch seconds and ms", () => {
    const a = AlertPayload.parse({ secret: "x", action: "close", size: "", limit_price: "", time: "1760184000" });
    expect(a.size).toBeUndefined();
    expect(a.time).toBe(1760184000_000);
    const b = AlertPayload.parse({ secret: "x", action: "close", time: 1760184000123 });
    expect(b.time).toBe(1760184000123);
  });
  it("rejects both size_usd and size, bad action, unresolved placeholders, limit without price", () => {
    expect(AlertPayload.safeParse({ secret: "x", action: "buy", size: 1, size_usd: 5 }).success).toBe(false);
    expect(AlertPayload.safeParse({ secret: "x", action: "moon" }).success).toBe(false);
    expect(AlertPayload.safeParse({ secret: "x", action: "buy", size: "{{strategy.order.contracts}}" }).success).toBe(false);
    expect(AlertPayload.safeParse({ secret: "x", action: "buy", size_usd: -5 }).success).toBe(false);
    expect(AlertPayload.safeParse({ secret: "x", action: "buy", order_type: "limit" }).success).toBe(false);
    expect(AlertPayload.safeParse({ action: "buy" }).success).toBe(false);
  });
});

describe("parseAlert", () => {
  it("requires exactly one size for opens, none for closes", () => {
    const open = parseAlert({ secret: "x", action: "buy", market: "BTCUSDT" });
    expect(open.ok).toBe(false);
    const close = parseAlert({ secret: "x", action: "close_long", market: "BTCUSDT" });
    expect(close.ok).toBe(true);
    const ok = parseAlert({ secret: "x", action: "long", market: "ETH", size_usd: 100 });
    expect(ok).toMatchObject({ ok: true, value: { market: "ETH", sizeUsd: 100, intent: { side: "long", kind: "open" } } });
  });
  it("applies strategy defaults for opens only", () => {
    const d = { market: "BTC-PERP", sizeUsd: 200, leverage: 2 };
    const open = parseAlert({ secret: "x", action: "sell" }, d);
    expect(open).toMatchObject({ ok: true, value: { market: "BTC", sizeUsd: 200, leverage: 2 } });
    const close = parseAlert({ secret: "x", action: "close" }, d);
    expect(close.ok && close.value.sizeUsd).toBeFalsy();
  });
  it("fails without market and default", () => {
    const r = parseAlert({ secret: "x", action: "close" });
    expect(r.ok).toBe(false);
  });
  it("never carries the secret", () => {
    const r = parseAlert({ secret: "topsecret", action: "buy", market: "BTC", size_usd: 1 });
    expect(JSON.stringify(r)).not.toContain("topsecret");
  });
});

describe("templates", () => {
  it("render to a body parseAlert accepts", () => {
    const t = tradingViewTemplates("abc");
    const body = renderTradingViewMessage(t.strategy, {
      "strategy.order.id": "Long",
      timenow: "2026-10-11T12:00:00Z",
      "strategy.order.action": "buy",
      ticker: "BTCUSDT.P",
      "strategy.order.contracts": "0.01",
      "strategy.market_position": "long",
      close: "112000.5",
    });
    const r = parseAlert(JSON.parse(body));
    expect(r).toMatchObject({ ok: true, value: { market: "BTC", size: 0.01, price: 112000.5, intent: { kind: "open" } } });
    const ind = renderTradingViewMessage(t.indicator, { ticker: "ETHUSDT", close: "3000", timenow: "2026-10-11T12:00:00Z" });
    expect(parseAlert(JSON.parse(ind)).ok).toBe(true);
  });
});
