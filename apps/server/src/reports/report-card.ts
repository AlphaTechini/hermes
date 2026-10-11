import {
  BLOCK_REASON_LABELS,
  slippageBpsFor,
  type AlertStatus,
  type BlockReason,
  type Grade,
  type GradeComponent,
  type HistogramBucket,
  type MissedGroup,
  type ReportCard,
  type ReportRange,
} from "@hermes/shared";
import type { ReportAlertInput } from "../db/repos";

/**
 * GRADE FORMULA (score 0..100, higher is better). Four components:
 *
 *   Fill rate    35 pts = 35 * fillRate
 *                fillRate = (filled + partially_filled) / alerts that should have traded
 *                (verified alerts that reached a terminal state: filled, partially_filled, blocked, expired, failed)
 *   Slippage     25 pts = 25 * clamp(1 - max(medianSlippageBps, 0) / 20, 0, 1)
 *                0 bps or better = full marks, 20 bps or worse = zero. Positive bps = worse for the trader.
 *   Latency      20 pts = 20 * clamp(1 - (p95LatencyMs - 1000) / 4000, 0, 1)
 *                p95 alert-to-first-fill of 1 s or less = full marks, 5 s or more = zero.
 *   Reliability  20 pts = 20 * (1 - failed / (filled + partially_filled + failed))
 *                share of orders that were actually attempted and did not fail. Full marks if none attempted.
 *
 *   If slippage or latency cannot be measured (no fills with an alert price / no fills) that component earns
 *   half of its points.
 *
 *   Grade: A >= 90, B >= 80, C >= 70, D >= 60, otherwise F. No grade (null) when nothing has reached a terminal state.
 */
export const GRADE_EXPLANATION =
  "Score out of 100 = fill rate (35) + slippage (25) + latency (20) + reliability (20). " +
  "Fill rate = filled or partially filled alerts divided by verified alerts that should have traded (blocked, expired and failed count against it). " +
  "Slippage: median bps vs the alert price, full marks at 0 bps or better, zero at 20 bps or worse. " +
  "Latency: p95 alert-to-first-fill, full marks at 1 s or less, zero at 5 s or more. " +
  "Reliability: share of attempted orders that did not fail. " +
  "Slippage or latency that cannot be measured earns half its points. Grades: A 90+, B 80+, C 70+, D 60+, otherwise F.";

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const round = (x: number, dp = 2) => Math.round(x * 10 ** dp) / 10 ** dp;

/** Linear-interpolated percentile of an ascending array (p in 0..1). */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0] as number;
  const idx = clamp01(p) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (idx - lo);
}

const BUCKETS: { label: string; min: number | null; max: number | null }[] = [
  { label: "better than alert", min: null, max: 0 },
  { label: "0 to 2 bps", min: 0, max: 2 },
  { label: "2 to 5 bps", min: 2, max: 5 },
  { label: "5 to 10 bps", min: 5, max: 10 },
  { label: "10 to 20 bps", min: 10, max: 20 },
  { label: "20+ bps", min: 20, max: null },
];

const FAILURE_LABELS: Record<string, string> = {
  perpl_not_connected: "Perpl was not connected",
  order_rejected: "Perpl rejected the order",
  timeout: "No status from Perpl in time",
  pipeline_error: "Internal error",
  executor_error: "Executor error",
};

const RANGE_DAYS: Record<Exclude<ReportRange, "all">, number> = { "7d": 7, "30d": 30 };

export function rangeStart(range: ReportRange, now: number): number | null {
  return range === "all" ? null : now - RANGE_DAYS[range] * 86_400_000;
}

const isStatus = (s: AlertStatus, ...list: AlertStatus[]) => list.includes(s);

export function buildReportCard(args: {
  strategy: { id: string; name: string };
  range: ReportRange;
  now: number;
  alerts: ReportAlertInput[];
}): ReportCard {
  const { strategy, range, now, alerts } = args;
  const since = rangeStart(range, now);

  // --- counts ---
  const c = {
    total: alerts.length,
    verified: 0,
    shouldHaveTraded: 0,
    filled: 0,
    partiallyFilled: 0,
    blocked: 0,
    expired: 0,
    failed: 0,
    rejectedAuth: 0,
    duplicate: 0,
    invalid: 0,
    inFlight: 0,
  };
  for (const a of alerts) {
    switch (a.status) {
      case "filled": c.filled++; break;
      case "partially_filled": c.partiallyFilled++; break;
      case "blocked": c.blocked++; break;
      case "expired": c.expired++; break;
      case "failed": c.failed++; break;
      case "rejected_auth": c.rejectedAuth++; break;
      case "duplicate": c.duplicate++; break;
      case "invalid": c.invalid++; break;
      default: c.inFlight++;
    }
  }
  c.shouldHaveTraded = c.filled + c.partiallyFilled + c.blocked + c.expired + c.failed;
  c.verified = c.shouldHaveTraded + alerts.filter((a) => isStatus(a.status, "verified", "risk_checked", "pending_approval", "sent", "accepted")).length;
  const traded = c.filled + c.partiallyFilled;
  const fillRate = c.shouldHaveTraded > 0 ? traded / c.shouldHaveTraded : null;

  // --- latency (alert received -> first fill event, both on our clock) ---
  const latSeries = alerts
    .filter((a) => a.firstFillEventAtMs !== null)
    .map((a) => ({
      alertId: a.id,
      atMs: Math.round(a.receivedAtMs),
      latencyMs: round((a.firstFillEventAtMs as number) - a.receivedEventAtMs, 1),
    }))
    .filter((p) => p.latencyMs >= 0);
  const lats = latSeries.map((p) => p.latencyMs).sort((x, y) => x - y);
  const avg = lats.length ? lats.reduce((s, x) => s + x, 0) / lats.length : null;
  const latency = {
    count: lats.length,
    medianMs: nullableRound(percentile(lats, 0.5), 1),
    p95Ms: nullableRound(percentile(lats, 0.95), 1),
    avgMs: nullableRound(avg, 1),
    minMs: lats.length ? (lats[0] as number) : null,
    maxMs: lats.length ? (lats[lats.length - 1] as number) : null,
    series: latSeries,
  };

  // --- slippage per fill ---
  const slipSeries: ReportCard["slippage"]["series"] = [];
  for (const a of alerts) {
    if (!a.alertPrice || !a.side || !a.kind) continue;
    for (const f of a.fills) {
      const bps = slippageBpsFor(a.alertPrice, f.price, a.side, a.kind);
      if (Number.isFinite(bps)) slipSeries.push({ alertId: a.id, atMs: Math.round(a.receivedAtMs), market: a.market, bps: round(bps, 2) });
    }
  }
  const slips = slipSeries.map((p) => p.bps).sort((x, y) => x - y);
  const buckets: HistogramBucket[] = BUCKETS.map((b) => ({
    label: b.label,
    minBps: b.min,
    maxBps: b.max,
    count: slips.filter((x) => (b.min === null || x >= b.min) && (b.max === null || x < b.max)).length,
  }));
  const slippage = {
    count: slips.length,
    avgBps: nullableRound(slips.length ? slips.reduce((s, x) => s + x, 0) / slips.length : null, 2),
    medianBps: nullableRound(percentile(slips, 0.5), 2),
    p95Bps: nullableRound(percentile(slips, 0.95), 2),
    worstBps: slips.length ? (slips[slips.length - 1] as number) : null,
    buckets,
    series: slipSeries,
  };

  // --- missed (blocked / expired / failed) by reason ---
  const groups = new Map<string, MissedGroup>();
  for (const a of alerts) {
    let g: MissedGroup | undefined;
    if (a.status === "blocked" || a.status === "expired") {
      const reason: BlockReason = a.blockReason ?? (a.status === "expired" ? "approval_expired" : "market_not_allowed");
      g = { kind: a.status, reason, label: BLOCK_REASON_LABELS[reason], count: 0 };
    } else if (a.status === "failed") {
      const code = a.errorCode ?? "unknown";
      g = { kind: "failed", reason: code, label: FAILURE_LABELS[code] ?? `Failed: ${code}`, count: 0 };
    }
    if (!g) continue;
    const key = `${g.kind}:${g.reason}`;
    const existing = groups.get(key);
    if (existing) existing.count++;
    else groups.set(key, { ...g, count: 1 });
  }
  const missed = [...groups.values()].sort((x, y) => y.count - x.count || x.reason.localeCompare(y.reason));

  // --- pnl ---
  let realized = 0;
  let fees = 0;
  let wins = 0;
  let closed = 0;
  let best: number | null = null;
  let worst: number | null = null;
  const perDay = new Map<string, number>();
  for (const a of alerts) {
    let alertPnl: number | null = null;
    for (const f of a.fills) {
      fees += f.fee;
      if (f.realizedPnl !== null) {
        realized += f.realizedPnl;
        alertPnl = (alertPnl ?? 0) + f.realizedPnl;
        const day = new Date(f.atMs).toISOString().slice(0, 10);
        perDay.set(day, (perDay.get(day) ?? 0) + f.realizedPnl);
      }
    }
    if (alertPnl !== null) {
      closed++;
      if (alertPnl > 0) wins++;
      best = best === null ? alertPnl : Math.max(best, alertPnl);
      worst = worst === null ? alertPnl : Math.min(worst, alertPnl);
    }
  }
  let cumulative = 0;
  const daily = [...perDay.entries()]
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([day, pnl]) => {
      cumulative += pnl;
      return { day, pnlUsd: round(pnl), cumulativeUsd: round(cumulative) };
    });
  const pnl = {
    realizedUsd: round(realized),
    feesUsd: round(fees, 4),
    netUsd: round(realized - fees),
    closedTrades: closed,
    winRate: closed ? round(wins / closed, 4) : null,
    bestUsd: best === null ? null : round(best),
    worstUsd: worst === null ? null : round(worst),
    daily,
  };

  // --- grade ---
  const attempted = traded + c.failed;
  const comp = (points: number, max: number, value: number | null): GradeComponent => ({ points: round(points, 2), max, value });
  const gradeBreakdown: ReportCard["gradeBreakdown"] = {
    fillRate: comp(35 * (fillRate ?? 0), 35, fillRate === null ? null : round(fillRate, 4)),
    slippage:
      slippage.medianBps === null
        ? comp(12.5, 25, null)
        : comp(25 * clamp01(1 - Math.max(slippage.medianBps, 0) / 20), 25, slippage.medianBps),
    latency:
      latency.p95Ms === null
        ? comp(10, 20, null)
        : comp(20 * clamp01(1 - (latency.p95Ms - 1000) / 4000), 20, latency.p95Ms),
    reliability: comp(attempted === 0 ? 20 : 20 * (1 - c.failed / attempted), 20, attempted === 0 ? null : round(c.failed / attempted, 4)),
  };
  let score: number | null = null;
  let grade: Grade | null = null;
  if (fillRate !== null) {
    score = round(
      gradeBreakdown.fillRate.points + gradeBreakdown.slippage.points + gradeBreakdown.latency.points + gradeBreakdown.reliability.points,
      1,
    );
    grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
  }

  return {
    strategyId: strategy.id,
    strategyName: strategy.name,
    range,
    since,
    generatedAt: now,
    counts: c,
    fillRate: fillRate === null ? null : round(fillRate, 4),
    latency,
    slippage,
    missed,
    pnl,
    grade,
    score,
    gradeBreakdown,
    gradeExplanation: GRADE_EXPLANATION,
  };
}

function nullableRound(x: number | null, dp: number): number | null {
  return x === null ? null : round(x, dp);
}
