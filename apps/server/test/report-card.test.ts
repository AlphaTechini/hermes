import type { AlertStatus, BlockReason, ReportRange } from "@hermes/shared";
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
    approvalGated: false,
    approvalDecidedAtMs: null,
    sentCount: 1,
    ...rest,
  };
  return a;
}
const card = (alerts: ReportAlertInput[], range: ReportRange = "all", extra: { priorAlerts?: ReportAlertInput[]; slippageCapBps?: number } = {}) =>
  buildReportCard({ strategy: { id: "s1", name: "S" }, range, now: NOW, alerts, ...extra });

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
      dryRun: 0,
      eligible: 5, // 3 traded + 1 expired approval + 1 failed; the 3 blocks are not eligible
    });
    // fill rate only counts alerts that passed the user's limits
    expect(c.fillRate).toBeCloseTo(3 / 5, 4);
  });

  it("groups blocked / expired / failed by reason, most frequent first", () => {
    const c = card(set());
    expect(c.missed.every((m) => m.lastAt > 0)).toBe(true);
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

describe("grade (DESIGN.md formula)", () => {
  const traded = (n: number, over: Partial<ReportAlertInput> & { latency?: number; fillPrice?: number } = {}) =>
    Array.from({ length: n }, () => alert({ latency: 400, fillPrice: 100_010, ...over })); // +1 bps, 400 ms

  it("needs 20 eligible alerts, otherwise grade is null with a reason", () => {
    const c = card(traded(19));
    expect(c.counts.eligible).toBe(19);
    expect(c.grade).toBeNull();
    expect(c.score).toBeNull();
    expect(c.gradeParts).toEqual([]);
    expect(c.gradeReason).toBe("Grades start after 20 alerts that pass your limits. 19 so far.");
    expect(c.gradeMinEligible).toBe(20);
    expect(card(traded(20)).grade).toBe("A");
  });

  it("scores 40% fill + 35% slippage + 25% speed", () => {
    const c = card(traded(20));
    expect(c.gradeParts.map((p) => [p.key, p.weight, p.score])).toEqual([
      ["fillRate", 0.4, 100],
      ["slippage", 0.35, 100], // 1 bps is under the 2 bps floor
      ["speed", 0.25, 100], // p95 400 ms is under 500 ms
    ]);
    expect(c.score).toBe(100);
    expect(c.gradeParts[0]).toMatchObject({ measured: 1, measuredLabel: "100.0%" });
    expect(c.gradeParts[1]).toMatchObject({ measured: 1, measuredLabel: "1.0 bps" });
    expect(c.gradeParts[2]).toMatchObject({ measured: 400, measuredLabel: "p95 400 ms" });
    expect(c.gradeExplanation).toMatch(/^Score = 40% fill rate \+ 35% slippage score \+ 25% speed score\./);
    expect(c.gradeExplanation).not.toContain("\u2014");
  });

  it("slippage is 100 at 2 bps, 0 at 20 bps, linear between", () => {
    const at = (bps: number) => card(traded(20, { fillPrice: 100_000 * (1 + bps / 1e4) })).gradeParts[1]?.score;
    expect(at(2)).toBe(100);
    expect(at(11)).toBeCloseTo(50, 1);
    expect(at(20)).toBe(0);
    expect(at(35)).toBe(0);
    expect(at(-3)).toBe(100); // better than the alert price
  });

  it("speed is 100 at p95 500 ms, 0 at 3 s, linear between", () => {
    const at = (ms: number) => card(traded(20, { latency: ms })).gradeParts[2]?.score;
    expect(at(500)).toBe(100);
    expect(at(1750)).toBeCloseTo(50, 1);
    expect(at(3000)).toBe(0);
    expect(at(9000)).toBe(0);
  });

  it("blocks and duplicates never lower the grade, misses and expired approvals do", () => {
    const base = traded(20);
    const withBlocks = card([
      ...base,
      ...Array.from({ length: 30 }, () => alert({ status: "blocked", blockReason: "size_above_max" })),
      ...Array.from({ length: 5 }, () => alert({ status: "duplicate" })),
      ...Array.from({ length: 4 }, () => alert({ status: "dry_run" })),
    ]);
    expect(withBlocks.score).toBe(100);
    expect(withBlocks.fillRate).toBe(1);
    expect(withBlocks.counts).toMatchObject({ blocked: 30, duplicate: 5, dryRun: 4, eligible: 20 });
    const withMisses = card([
      ...base,
      ...Array.from({ length: 4 }, () => alert({ status: "failed", errorCode: "unfilled" })),
      alert({ status: "expired", blockReason: "approval_expired" }),
    ]);
    expect(withMisses.counts.eligible).toBe(25);
    expect(withMisses.fillRate).toBeCloseTo(20 / 25, 4);
    expect(withMisses.gradeParts[0]?.score).toBe(80);
    expect(withMisses.score).toBeCloseTo(0.4 * 80 + 35 + 25, 1);
    expect(withMisses.grade).toBe("A"); // 92
  });

  it("maps score boundaries to letters (A 90, B 80, C 70, D 60, F below)", () => {
    // perfect slippage and speed are worth 60 points, so score = 0.4 x fill% + 60
    const withFill = (filled: number, missed: number) =>
      card([...traded(filled), ...Array.from({ length: missed }, () => alert({ status: "failed", errorCode: "unfilled" }))]);
    const letter = (filled: number, missed: number) => [withFill(filled, missed).score, withFill(filled, missed).grade];
    expect(letter(75, 25)).toEqual([90, "A"]);
    expect(letter(74, 26)).toEqual([89.6, "B"]);
    expect(letter(50, 50)).toEqual([80, "B"]);
    expect(letter(49, 51)).toEqual([79.6, "C"]);
    expect(letter(25, 75)).toEqual([70, "C"]);
    expect(letter(24, 76)).toEqual([69.6, "D"]);
    // slippage worth 0 (20 bps): 0.4 x 100 + 0.25 x 100 = 65 -> D; and a 3 s p95 on top -> 40 -> F
    const pricey = { fillPrice: 100_000 * (1 + 20 / 1e4) };
    expect(card(traded(20, pricey))).toMatchObject({ score: 65, grade: "D" });
    expect(card(traded(20, { ...pricey, latency: 3000 }))).toMatchObject({ score: 40, grade: "F" });
  });

  it("names the biggest drag in one line", () => {
    const slow = card(traded(20, { latency: 2100 }));
    expect(slow.gradeSummary).toBe("An A starts at 90. The biggest drag is a p95 time of 2.1 s.");
    const costly = card(traded(20, { fillPrice: 100_000 * (1 + 9.2 / 1e4) }));
    expect(costly.gradeSummary).toBe("An A starts at 90. The biggest drag is median slippage of 9.2 bps.");
    const missing = card([...traded(20), ...Array.from({ length: 13 }, () => alert({ status: "failed", errorCode: "unfilled" }))]);
    expect(missing.gradeSummary).toBe("An A starts at 90. The biggest drag is 13 alerts that passed your limits but did not fill.");
    expect(card(traded(20)).gradeSummary).toBe("Nothing is dragging the grade down.");
  });

  it("filters by range (since is reported) and knows the 24h range", () => {
    expect(card([], "24h").since).toBe(NOW - 86_400_000);
    expect(card([], "7d").since).toBe(NOW - 7 * 86_400_000);
    expect(card([], "30d").since).toBe(NOW - 30 * 86_400_000);
    expect(card([], "all").since).toBeNull();
  });
});

describe("approval wait is not latency", () => {
  it("starts the clock at the approval decision and counts gated alerts", () => {
    const recv = NOW - 3600_000;
    const gated = alert({
      receivedAtMs: recv,
      receivedEventAtMs: recv,
      firstFillEventAtMs: recv + 21_000 + 600, // waited 21 s for the human, then 600 ms to fill
      approvalGated: true,
      approvalDecidedAtMs: recv + 21_000,
      fillPrice: 100_000,
    });
    const plain = alert({ latency: 400, fillPrice: 100_000 });
    const c = card([gated, plain]);
    expect(c.latency.series.find((p) => p.alertId === gated.id)?.latencyMs).toBe(600);
    expect(c.latency.maxMs).toBe(600);
    expect(c.approvalGated).toBe(1);
  });
});

describe("report extras", () => {
  it("sums slippage cost in USD, positive = cost to the trader", () => {
    const c = card([
      alert({ side: "long", kind: "open", fillPrice: 100_100, latency: 100 }), // buy 10 bps worse: 100 x 0.01 = $1.00
      alert({ side: "short", kind: "open", fillPrice: 100_200, latency: 100 }), // sell 20 bps better: -$2.00
    ]);
    expect(c.slippage.costUsd).toBe(-1);
  });

  it("buckets latency per range with median, p95 and the slowest point", () => {
    const at = NOW - 2 * 3600_000;
    const mk = (offsetMin: number, latency: number, over: Partial<ReportAlertInput> = {}) =>
      alert({ receivedAtMs: at + offsetMin * 60_000, receivedEventAtMs: at + offsetMin * 60_000, firstFillEventAtMs: at + offsetMin * 60_000 + latency, fillPrice: 100_000, ...over });
    const alerts = [mk(0, 300), mk(10, 500), mk(20, 700), mk(70, 900, { sentCount: 2 })];
    const h = card(alerts, "24h").latency;
    expect(h.bucketMs).toBe(3_600_000);
    expect(h.buckets).toHaveLength(2);
    expect(h.buckets[0]).toMatchObject({ count: 3, medianMs: 500 });
    expect(h.buckets[0]?.p95Ms).toBeCloseTo(680, 0);
    expect(h.buckets[0]?.atMs % 3_600_000).toBe(0);
    expect(h.maxPoint).toMatchObject({ ms: 900, alertId: alerts[3]?.id, note: expect.stringMatching(/resent/i) });
    expect(card(alerts, "7d").latency.bucketMs).toBe(6 * 3_600_000);
    expect(card(alerts, "30d").latency.bucketMs).toBe(86_400_000);
    expect(card([], "7d").latency.maxPoint).toBeNull();
  });

  it("compares with the previous window of the same length", () => {
    const now = [alert({ latency: 400, fillPrice: 100_000 }), alert({ latency: 400, fillPrice: 100_000 }), alert({ status: "failed", errorCode: "unfilled" })];
    const before = [alert({ latency: 600, fillPrice: 100_000 }), alert({ status: "failed", errorCode: "unfilled" })];
    const c = card(now, "7d", { priorAlerts: before });
    expect(c.prior).toMatchObject({
      since: NOW - 14 * 86_400_000,
      until: NOW - 7 * 86_400_000,
      eligible: 2,
      fillRate: 0.5,
      medianLatencyMs: 600,
      medianLatencyDeltaMs: -200,
    });
    expect(c.prior?.fillRateDelta).toBeCloseTo(2 / 3 - 0.5, 4);
    expect(card(now, "all").prior).toBeNull();
    expect(card(now, "7d").prior).toBeNull(); // no prior alerts supplied
  });

  it("reports the slippage cap and the last time each reason hit", () => {
    const c = card([alert({ status: "blocked", blockReason: "stale_alert", receivedAtMs: NOW - 5000 }), alert({ status: "blocked", blockReason: "stale_alert", receivedAtMs: NOW - 9000 })], "all", { slippageCapBps: 30 });
    expect(c.slippageCapBps).toBe(30);
    expect(c.missed[0]?.lastAt).toBe(NOW - 5000);
  });
});
