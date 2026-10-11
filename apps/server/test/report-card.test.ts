import type { AlertStatus, BlockReason } from "@hermes/shared";
import { describe, expect, it } from "vitest";
import type { ReportAlertInput } from "../src/db/repos";
import { buildReportCard, percentile } from "../src/reports/report-card";

const NOW = Date.parse("2026-10-11T12:00:00Z");
let n = 0;
function alert(over: Partial<ReportAlertInput> & { latency?: number; fillPrice?: number | number[] } = {}): ReportAlertInput {
  const { latency, fillPrice, ...rest } = over;
  const recv = NOW - 3600_000 + n * 1000;
  const prices = fillPrice === undefined ? [] : Array.isArray(fillPrice) ? fillPrice : [fillPrice];
  const a: ReportAlertInput = {
    id: `a${++n}`,
    status: "filled" as AlertStatus,
    blockReason: null,
    errorCode: null,
    market: "BTC",
    side: "long",
    kind: "open",
    alertPrice: 100_000,
    receivedAtMs: recv,
    receivedEventAtMs: recv + 0.25,
    firstFillEventAtMs: latency === undefined ? null : recv + 0.25 + latency,
    fills: prices.map((price, i) => ({ price, size: 0.01, fee: 0.1, realizedPnl: null, atMs: recv + 500 + i })),
    ...rest,
  };
  return a;
}
const card = (alerts: ReportAlertInput[], range: "7d" | "30d" | "all" = "all") =>
  buildReportCard({ strategy: { id: "s1", name: "S" }, range, now: NOW, alerts });

describe("percentile", () => {
  it("interpolates", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5], 0.95)).toBe(5);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([0, 100], 0.95)).toBeCloseTo(95);
  });
});

describe("slippage", () => {
  it("is signed so positive = worse: longs pay more, shorts receive less", () => {
    const c = card([
      alert({ side: "long", kind: "open", fillPrice: 100_050, latency: 500 }), // buy 5 bps higher: +5
      alert({ side: "long", kind: "open", fillPrice: 99_980, latency: 500 }), // buy cheaper: -2 (better)
      alert({ side: "short", kind: "open", fillPrice: 99_900, latency: 500 }), // sell 10 bps lower: +10
      alert({ side: "short", kind: "open", fillPrice: 100_030, latency: 500 }), // sell higher: -3 (better)
      alert({ side: "long", kind: "close", fillPrice: 99_950, latency: 500 }), // close long = sell lower: +5
      alert({ side: "short", kind: "close", fillPrice: 100_100, latency: 500 }), // close short = buy higher: +10
    ]);
    expect(c.slippage.series.map((p) => p.bps)).toEqual([5, -2, 10, -3, 5, 10]);
    expect(c.slippage.count).toBe(6);
    expect(c.slippage.worstBps).toBe(10);
    expect(c.slippage.avgBps).toBeCloseTo(25 / 6, 2);
    expect(c.slippage.medianBps).toBe(5);
  });

  it("buckets the distribution (lower bound inclusive)", () => {
    const px = (bps: number) => 100_000 * (1 + bps / 1e4);
    const c = card([-1, 0, 1.9, 2, 4.9, 5, 9.9, 10, 19.9, 20, 55].map((b) => alert({ fillPrice: px(b), latency: 400 })));
    expect(c.slippage.buckets.map((b) => b.count)).toEqual([1, 2, 2, 2, 2, 2]);
    expect(c.slippage.buckets.reduce((s, b) => s + b.count, 0)).toBe(11);
  });

  it("measures each fill of a multi-fill alert and skips alerts without a price", () => {
    const c = card([alert({ fillPrice: [100_010, 100_020], latency: 100 }), alert({ alertPrice: null, fillPrice: 1, latency: 100 })]);
    expect(c.slippage.series.map((p) => p.bps)).toEqual([1, 2]);
  });
});

describe("latency", () => {
  it("is received -> first fill, with median / p95 / series", () => {
    const lat = [300, 400, 500, 600, 700, 800, 900, 1000, 1100, 5000];
    const c = card(lat.map((l) => alert({ latency: l, fillPrice: 100_000 })));
    expect(c.latency.count).toBe(10);
    expect(c.latency.medianMs).toBe(750);
    expect(c.latency.p95Ms).toBeCloseTo(300 + 0 + (5000 - 1100) * 0.55 + 1100 - 300, 0);
    expect(c.latency.minMs).toBe(300);
    expect(c.latency.maxMs).toBe(5000);
    expect(c.latency.series).toHaveLength(10);
    expect(c.latency.series[0]?.latencyMs).toBe(300);
  });
});

describe("counts, fill rate and missed", () => {
  const set = () => [
    alert({ status: "filled", latency: 500, fillPrice: 100_000 }),
    alert({ status: "filled", latency: 500, fillPrice: 100_000 }),
    alert({ status: "partially_filled", latency: 500, fillPrice: 100_000 }),
    alert({ status: "blocked", blockReason: "size_above_max" as BlockReason }),
    alert({ status: "blocked", blockReason: "size_above_max" as BlockReason }),
    alert({ status: "blocked", blockReason: "stale_alert" as BlockReason }),
    alert({ status: "expired", blockReason: "approval_expired" as BlockReason }),
    alert({ status: "failed", errorCode: "order_rejected" }),
    alert({ status: "rejected_auth" }),
    alert({ status: "duplicate" }),
    alert({ status: "invalid" }),
    alert({ status: "accepted" }),
  ];

  it("counts statuses and computes fill rate over verified, terminal alerts", () => {
    const c = card(set());
    expect(c.counts).toMatchObject({
      total: 12,
      filled: 2,
      partiallyFilled: 1,
      blocked: 3,
      expired: 1,
      failed: 1,
      rejectedAuth: 1,
      duplicate: 1,
      invalid: 1,
      inFlight: 1,
      shouldHaveTraded: 8,
      verified: 9,
    });
    expect(c.fillRate).toBeCloseTo(3 / 8, 4);
  });

  it("groups blocked / expired / failed by reason, most frequent first", () => {
    const c = card(set());
    expect(c.missed.map((m) => [m.kind, m.reason, m.count])).toEqual([
      ["blocked", "size_above_max", 2],
      ["expired", "approval_expired", 1], // ties are ordered by reason
      ["failed", "order_rejected", 1],
      ["blocked", "stale_alert", 1],
    ]);
    expect(c.missed[0]?.label).toMatch(/exceed/i);
  });

  it("has a null fill rate and no grade when nothing is terminal", () => {
    const c = card([alert({ status: "accepted" }), alert({ status: "duplicate" })]);
    expect(c.fillRate).toBeNull();
    expect(c.grade).toBeNull();
    expect(c.score).toBeNull();
    expect(card([]).counts.total).toBe(0);
  });
});

describe("pnl", () => {
  it("sums realised pnl, fees, win rate and a daily series", () => {
    const day1 = Date.parse("2026-10-09T10:00:00Z");
    const day2 = Date.parse("2026-10-10T10:00:00Z");
    const mk = (pnl: number, atMs: number) =>
      alert({ kind: "close", fills: [{ price: 1, size: 1, fee: 0.5, realizedPnl: pnl, atMs }], latency: 100 });
    const c = card([mk(10, day1), mk(-4, day1 + 1000), mk(20, day2), alert({ fillPrice: 1, latency: 1 })]);
    expect(c.pnl).toMatchObject({ realizedUsd: 26, feesUsd: 1.6, netUsd: 24.4, closedTrades: 3, bestUsd: 20, worstUsd: -4 });
    expect(c.pnl.winRate).toBeCloseTo(2 / 3, 3);
    expect(c.pnl.daily).toEqual([
      { day: "2026-10-09", pnlUsd: 6, cumulativeUsd: 6 },
      { day: "2026-10-10", pnlUsd: 20, cumulativeUsd: 26 },
    ]);
  });
});

describe("grade", () => {
  const great = () => Array.from({ length: 20 }, () => alert({ latency: 400, fillPrice: 100_010 })); // +1 bps, 400 ms
  it("gives an A for fast, cheap, reliable execution (formula in gradeExplanation)", () => {
    const c = card(great());
    expect(c.gradeBreakdown.fillRate.points).toBe(35);
    expect(c.gradeBreakdown.slippage.points).toBeCloseTo(25 * (1 - 1 / 20), 1);
    expect(c.gradeBreakdown.latency.points).toBe(20);
    expect(c.gradeBreakdown.reliability.points).toBe(20);
    expect(c.score).toBeCloseTo(98.8, 1);
    expect(c.grade).toBe("A");
    expect(c.gradeExplanation).toMatch(/fill rate \(35\)/);
  });

  it("drops with blocked alerts, failures, slippage and latency", () => {
    const worse = card([
      ...Array.from({ length: 6 }, () => alert({ latency: 3000, fillPrice: 100_100 })), // 10 bps, 3 s
      ...Array.from({ length: 2 }, () => alert({ status: "blocked", blockReason: "stale_alert" })),
      ...Array.from({ length: 2 }, () => alert({ status: "failed", errorCode: "order_rejected" })),
    ]);
    // fill 6/10 -> 21; slippage 10bps -> 12.5; latency p95 3s -> 10; reliability 1 - 2/8 -> 15
    expect(worse.score).toBeCloseTo(58.5, 1);
    expect(worse.grade).toBe("F");
  });

  it("maps score boundaries to letters", () => {
    // all blocked: fill 0, slippage/latency unmeasured (half), reliability full => 12.5 + 10 + 20 = 42.5
    const c = card([alert({ status: "blocked", blockReason: "stale_alert" })]);
    expect(c.score).toBe(42.5);
    expect(c.grade).toBe("F");
  });

  it("filters by range when asked via the repo layer inputs (since is reported)", () => {
    expect(card([], "7d").since).toBe(NOW - 7 * 86_400_000);
    expect(card([], "30d").since).toBe(NOW - 30 * 86_400_000);
    expect(card([], "all").since).toBeNull();
  });
});
