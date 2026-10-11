import { DEFAULT_RISK_LIMITS, type RiskLimits } from "@hermes/shared";
import { describe, expect, it } from "vitest";
import { evaluate, evaluateDetailed, type RiskIntent, type RiskState } from "../src/risk/evaluate";

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

  it("counts unrealised loss toward the daily loss stop (realised + unrealised, like the top bar)", () => {
    expect(evaluate(open(), limits(), state({ realizedPnlTodayUsd: -100, unrealizedPnlUsd: -99 })).ok).toBe(true);
    const r = evaluate(open(), limits(), state({ realizedPnlTodayUsd: -100, unrealizedPnlUsd: -100 }));
    expect(r).toMatchObject({ ok: false, reason: "daily_loss_stop_hit" });
    expect(r.ok === false && r.detail).toMatch(/realised -\$100\.00, unrealised -\$100\.00/);
    // a winning open position offsets a realised loss
    expect(evaluate(open(), limits(), state({ realizedPnlTodayUsd: -250, unrealizedPnlUsd: 120 })).ok).toBe(true);
    // a closed-out profit does not hide an unrealised loss beyond the stop
    expect(evaluate(open(), limits(), state({ realizedPnlTodayUsd: 50, unrealizedPnlUsd: -250 }))).toMatchObject({ reason: "daily_loss_stop_hit" });
    // closes are never blocked by the stop
    expect(evaluate(close(), limits(), state({ unrealizedPnlUsd: -999, positions: { BTC: { side: "long", size: 1, notionalUsd: 1 } } })).ok).toBe(true);
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

describe("evaluateDetailed: per-rule results", () => {
  const keys = (cs: { key: string }[]) => cs.map((c) => c.key);

  it("lists every rule with value, limit and unit when the order passes", () => {
    const r = evaluateDetailed(open({ notionalUsd: 600, leverage: 3 }), limits(), state({ realizedPnlTodayUsd: -50, unrealizedPnlUsd: -20, alertAgeSec: 2.34, ordersLastMinute: 4 }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.needsApproval).toBe(true);
    expect(keys(r.checks)).toEqual(["strategy_enabled", "alert_age", "rate_limit", "perpl_connected", "pause", "markets", "daily_loss", "size_known", "leverage", "size", "approval"]);
    expect(r.checks.every((c) => c.passed === true && !c.skipped)).toBe(true);
    const by = Object.fromEntries(r.checks.map((c) => [c.key, c]));
    expect(by.alert_age).toMatchObject({ value: 2.3, limit: 60, unit: "s" });
    expect(by.rate_limit).toMatchObject({ value: 4, limit: 10, unit: "orders/min" });
    expect(by.markets).toMatchObject({ value: "BTC", unit: null });
    expect(by.daily_loss).toMatchObject({ value: 70, limit: 200, unit: "USD" });
    expect(by.leverage).toMatchObject({ value: 3, limit: 5, unit: "x" });
    expect(by.size).toMatchObject({ value: 600, limit: 1000, unit: "USD" });
    expect(by.approval).toMatchObject({ value: 600, limit: 500, unit: "USD", passed: true });
    expect(by.approval?.detail).toMatch(/above the approval threshold/i);
  });

  it("on a block: the failing check, everything before it, and the rest skipped", () => {
    const r = evaluateDetailed(open({ market: "ETH" }), limits({ allowedMarkets: ["BTC"] }), state());
    expect(r).toMatchObject({ ok: false, reason: "market_not_allowed" });
    const failed = r.checks.findIndex((c) => c.passed === false);
    expect(r.checks[failed]).toMatchObject({ key: "markets", passed: false, skipped: false, value: "ETH", limit: "BTC" });
    expect(r.checks.slice(0, failed).every((c) => c.passed === true)).toBe(true);
    const rest = r.checks.slice(failed + 1);
    expect(keys(rest)).toEqual(["daily_loss", "size_known", "leverage", "size", "approval"]);
    expect(rest.every((c) => c.passed === null && c.skipped === true)).toBe(true);
  });

  it("evaluates the same rules in the same order as evaluate()", () => {
    for (const [i, l, s] of [
      [open(), limits({ paused: true }), state()],
      [open({ leverage: 9 }), limits(), state()],
      [open({ notionalUsd: 5000 }), limits(), state()],
      [open(), limits(), state({ perplConnected: false })],
      [open(), limits(), state({ realizedPnlTodayUsd: -500 })],
    ] as const) {
      const detailed = evaluateDetailed(i, l, s);
      const { checks: _c, ...plain } = detailed;
      expect(plain).toEqual(evaluate(i, l, s));
    }
  });

  it("closes evaluate the global rules and the position, and skip the open-only limits", () => {
    const withLong = state({ positions: { BTC: { side: "long", size: 0.01, notionalUsd: 1000 } } });
    const r = evaluateDetailed(close(), limits({ paused: true }), withLong);
    expect(r).toEqual({ ok: true, needsApproval: false, checks: r.checks });
    expect(r.checks.filter((c) => c.passed === true).map((c) => c.key)).toEqual(["strategy_enabled", "alert_age", "rate_limit", "perpl_connected", "position_to_close"]);
    expect(r.checks.filter((c) => c.skipped).map((c) => c.key)).toEqual(["pause", "markets", "daily_loss", "size_known", "leverage", "size", "approval"]);
    const none = evaluateDetailed(close(), limits(), state());
    expect(none).toMatchObject({ ok: false, reason: "no_position_to_close" });
    expect(none.checks.find((c) => c.key === "position_to_close")).toMatchObject({ passed: false, value: "None" });
  });
});
