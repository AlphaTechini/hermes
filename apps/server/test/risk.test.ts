import { DEFAULT_RISK_LIMITS, type RiskLimits } from "@hermes/shared";
import { describe, expect, it } from "vitest";
import { evaluate, type RiskIntent, type RiskState } from "../src/risk/evaluate";

const limits = (over: Partial<RiskLimits> = {}): RiskLimits => ({
  ...DEFAULT_RISK_LIMITS,
  maxPositionUsd: 1000,
  maxLeverage: 5,
  dailyLossStopUsd: 200,
  approvalThresholdUsd: 500,
  maxAlertAgeSec: 60,
  maxOrdersPerMinute: 10,
  ...over,
});
const state = (over: Partial<RiskState> = {}): RiskState => ({
  strategyEnabled: true,
  positions: {},
  realizedPnlTodayUsd: 0,
  openNotionalUsd: 0,
  ordersLastMinute: 0,
  perplConnected: true,
  alertAgeSec: 1,
  ...over,
});
const open = (over: Partial<RiskIntent> = {}): RiskIntent => ({
  market: "BTC",
  kind: "open",
  side: "long",
  notionalUsd: 100,
  leverage: 2,
  ...over,
});
const close = (over: Partial<RiskIntent> = {}): RiskIntent => ({
  market: "BTC",
  kind: "close",
  side: "long",
  notionalUsd: null,
  ...over,
});

describe("evaluate: opens", () => {
  it("passes a normal order without approval", () => {
    expect(evaluate(open(), limits(), state())).toEqual({ ok: true, needsApproval: false });
  });

  it("requires approval at or above the threshold", () => {
    expect(evaluate(open({ notionalUsd: 499.99 }), limits(), state())).toEqual({ ok: true, needsApproval: false });
    expect(evaluate(open({ notionalUsd: 500 }), limits(), state())).toEqual({ ok: true, needsApproval: true });
  });

  it("threshold 0 disables approvals", () => {
    expect(evaluate(open({ notionalUsd: 900 }), limits({ approvalThresholdUsd: 0 }), state())).toEqual({
      ok: true,
      needsApproval: false,
    });
  });

  it("blocks markets outside the allow list and unknown markets", () => {
    const r = evaluate(open({ market: "ETH" }), limits({ allowedMarkets: ["BTC"] }), state());
    expect(r).toMatchObject({ ok: false, reason: "market_not_allowed" });
    const unknown = evaluate(open({ market: "DOGE" }), limits({ allowedMarkets: ["DOGE", "BTC"] }), state());
    expect(unknown).toMatchObject({ ok: false, reason: "market_not_allowed" });
  });

  it("is case-insensitive on market names", () => {
    expect(evaluate(open({ market: "btc" }), limits({ allowedMarkets: ["btc"] }), state()).ok).toBe(true);
  });

  it("blocks oversized orders and counts the existing same-side position", () => {
    expect(evaluate(open({ notionalUsd: 1000.01 }), limits(), state())).toMatchObject({ ok: false, reason: "size_above_max" });
    expect(evaluate(open({ notionalUsd: 1000 }), limits({ approvalThresholdUsd: 0 }), state()).ok).toBe(true);
    const s = state({ positions: { BTC: { side: "long", size: 0.008, notionalUsd: 800 } } });
    expect(evaluate(open({ notionalUsd: 300 }), limits(), s)).toMatchObject({ ok: false, reason: "size_above_max" });
    expect(evaluate(open({ notionalUsd: 200 }), limits(), s).ok).toBe(true);
    // an opposite-side position does not add to the new side's exposure
    const opp = state({ positions: { BTC: { side: "short", size: 0.01, notionalUsd: 900 } } });
    expect(evaluate(open({ notionalUsd: 200 }), limits(), opp).ok).toBe(true);
  });

  it("blocks leverage above the max, allows equal and unspecified", () => {
    expect(evaluate(open({ leverage: 5.01 }), limits(), state())).toMatchObject({ ok: false, reason: "leverage_above_max" });
    expect(evaluate(open({ leverage: 5 }), limits(), state()).ok).toBe(true);
    expect(evaluate(open({ leverage: undefined }), limits(), state()).ok).toBe(true);
  });

  it("blocks when the daily loss stop is hit", () => {
    expect(evaluate(open(), limits(), state({ realizedPnlTodayUsd: -199.99 })).ok).toBe(true);
    expect(evaluate(open(), limits(), state({ realizedPnlTodayUsd: -200 }))).toMatchObject({ ok: false, reason: "daily_loss_stop_hit" });
    expect(evaluate(open(), limits({ dailyLossStopUsd: 0 }), state({ realizedPnlTodayUsd: -9999 })).ok).toBe(true);
  });

  it("blocks invalid sizes", () => {
    for (const n of [null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(evaluate(open({ notionalUsd: n }), limits(), state())).toMatchObject({ ok: false, reason: "invalid_size" });
    }
  });

  it("blocks new positions while paused", () => {
    expect(evaluate(open(), limits({ paused: true }), state())).toMatchObject({ ok: false, reason: "trading_paused" });
  });
});

describe("evaluate: global checks", () => {
  it("blocks a disabled strategy, stale alerts, rate limits and a disconnected Perpl", () => {
    expect(evaluate(open(), limits(), state({ strategyEnabled: false }))).toMatchObject({ reason: "strategy_disabled" });
    expect(evaluate(open(), limits(), state({ alertAgeSec: 60 })).ok).toBe(true);
    expect(evaluate(open(), limits(), state({ alertAgeSec: 60.1 }))).toMatchObject({ reason: "stale_alert" });
    expect(evaluate(open(), limits(), state({ ordersLastMinute: 9 })).ok).toBe(true);
    expect(evaluate(open(), limits(), state({ ordersLastMinute: 10 }))).toMatchObject({ reason: "rate_limited" });
    expect(evaluate(open(), limits(), state({ perplConnected: false }))).toMatchObject({ reason: "perpl_not_connected" });
  });

  it("reports the first failing check in documented order", () => {
    const r = evaluate(
      open({ market: "DOGE", notionalUsd: 1e9 }),
      limits({ paused: true }),
      state({ strategyEnabled: false, alertAgeSec: 999, perplConnected: false }),
    );
    expect(r).toMatchObject({ reason: "strategy_disabled" });
    expect(evaluate(open(), limits(), state({ alertAgeSec: 999, perplConnected: false }))).toMatchObject({ reason: "stale_alert" });
    expect(evaluate(open(), limits({ paused: true }), state({ perplConnected: false }))).toMatchObject({ reason: "perpl_not_connected" });
  });

  it("returns a human readable detail", () => {
    const r = evaluate(open({ market: "ETH" }), limits({ allowedMarkets: ["BTC"] }), state());
    expect(r.ok === false && r.detail).toContain("ETH");
  });
});

describe("evaluate: closes", () => {
  const withLong = state({ positions: { BTC: { side: "long", size: 0.01, notionalUsd: 1000 } } });

  it("needs an open position on the right side", () => {
    expect(evaluate(close(), limits(), state())).toMatchObject({ ok: false, reason: "no_position_to_close" });
    expect(evaluate(close({ side: "short" }), limits(), withLong)).toMatchObject({ ok: false, reason: "no_position_to_close" });
    expect(evaluate(close(), limits(), withLong)).toEqual({ ok: true, needsApproval: false });
    expect(evaluate(close({ side: null }), limits(), withLong)).toEqual({ ok: true, needsApproval: false });
  });

  it("is reduce-only: ignores pause, market list, daily loss stop and approvals", () => {
    const l = limits({ paused: true, allowedMarkets: ["ETH"], approvalThresholdUsd: 1 });
    expect(evaluate(close(), l, { ...withLong, realizedPnlTodayUsd: -10_000 })).toEqual({ ok: true, needsApproval: false });
  });

  it("still honours disabled, stale, rate limit and connectivity", () => {
    expect(evaluate(close(), limits(), { ...withLong, alertAgeSec: 500 })).toMatchObject({ reason: "stale_alert" });
    expect(evaluate(close(), limits(), { ...withLong, ordersLastMinute: 99 })).toMatchObject({ reason: "rate_limited" });
    expect(evaluate(close(), limits(), { ...withLong, perplConnected: false })).toMatchObject({ reason: "perpl_not_connected" });
    expect(evaluate(close(), limits(), { ...withLong, strategyEnabled: false })).toMatchObject({ reason: "strategy_disabled" });
  });
});
