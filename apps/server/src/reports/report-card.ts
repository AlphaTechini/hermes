import {
  BLOCK_REASON_LABELS,
  slippageBpsFor,
  type AlertStatus,
  type BlockReason,
  type Grade,
  type GradePart,
  type HistogramBucket,
  type MissedGroup,
  type ReportCard,
  type ReportRange,
} from "@hermes/shared";
import type { ReportAlertInput } from "../db/repos";

/**
 * GRADE FORMULA (DESIGN.md 10.8, score 0..100, higher is better):
 *
 *   score = 0.40 fillScore + 0.35 slipScore + 0.25 speedScore            (one decimal)
 *
 *   fillScore  = filled / eligible x 100. Eligible = alerts that passed every check and were meant to trade: filled,
 *                partially filled, failed (Perpl refused or no fill) and expired approvals. Blocks (including a
 *                rejected approval), duplicates, dry runs and alerts still in flight are NOT eligible, so a limit the
 *                user asked for never lowers the grade.
 *   slipScore  = clamp(100 - (medianBps - 2) / 18 x 100, 0, 100)     100 at <= 2 bps, 0 at 20 bps
 *   speedScore = clamp(100 - (p95Ms - 500) / 2500 x 100, 0, 100)     100 at <= 500 ms, 0 at 3 s
 *                alert to fill excludes the time an alert waited for human approval (the clock starts at the decision).
 *
 *   Grade: A >= 90, B >= 80, C >= 70, D >= 60, otherwise F. No grade (null) below 20 eligible alerts.
 *   A part that cannot be measured (no fills, or fills without an alert price) scores 0.
 */
export const GRADE_EXPLANATION =
  "Score = 40% fill rate + 35% slippage score + 25% speed score. " +
  "Fill rate only counts alerts that passed your limits, so a block you asked for never lowers the grade. " +
  "Slippage score is 100 at a median of 2 bps or less and 0 at 20 bps. " +
  "Speed score is 100 when p95 alert to fill is 500 ms or less and 0 at 3 s. " +
  "Time spent waiting for your approval is not counted. " +
  "A is 90 and up, B 80, C 70, D 60, F below 60. Needs 20 eligible alerts.";

export const GRADE_MIN_ELIGIBLE = 20;
const W_FILL = 0.4;
const W_SLIP = 0.35;
const W_SPEED = 0.25;

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
  perpl_timeout: "No final status from Perpl (outcome unknown)",
  unfilled: "Not filled (no liquidity within the slippage limit)",
  forwarding_disabled: "Order forwarding is off on the Perpl account",
  size_too_small: "Order size rounded to zero lots",
  no_position: "No position to close on Perpl",
  socket_closed_1011: "Perpl closed the connection while the order was in flight",
  limit_orders_unsupported: "Limit orders are not supported",
  invalid_order: "Order rejected before sending (invalid)",
};

const failureLabel = (code: string): string =>
  FAILURE_LABELS[code] ?? (code.startsWith("sr:") ? `Perpl rejected the order (reason ${code.slice(3)})` : `Failed: ${code}`);


const RANGE_MS: Record<Exclude<ReportRange, "all">, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };

export function rangeStart(range: ReportRange, now: number): number | null {
  return range === "all" ? null : now - RANGE_MS[range];
}

/** The window right before `range` and of the same length, or null for "all". */
export function priorWindow(range: ReportRange, now: number): { since: number; until: number } | null {
  if (range === "all") return null;
  const until = now - RANGE_MS[range];
  return { since: until - RANGE_MS[range], until };
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
function bucketSizeMs(range: ReportRange, spanMs: number): number {
  if (range === "24h") return HOUR;
  if (range === "7d") return 6 * HOUR;
  if (range === "30d") return DAY;
  return spanMs > 180 * DAY ? 7 * DAY : DAY; // "all"
}

const fmtMs = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);
const fmtSecs = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** Alerts that passed every limit and were meant to trade. */
const isEligible = (s: AlertStatus): boolean => s === "filled" || s === "partially_filled" || s === "failed" || s === "expired";

interface LatencyPoint {
  alertId: string;
  atMs: number;
  latencyMs: number;
  sentCount: number;
}

/** Everything derived from one set of alerts; run once for the range and once for the prior window. */
function analyze(alerts: ReportAlertInput[]) {
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
    dryRun: 0,
    eligible: 0,
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
      case "dry_run": c.dryRun++; break;
      default: c.inFlight++;
    }
  }
  c.shouldHaveTraded = c.filled + c.partiallyFilled + c.blocked + c.expired + c.failed;
  c.verified =
    c.shouldHaveTraded + c.dryRun + alerts.filter((a) => isStatus(a.status, "verified", "risk_checked", "pending_approval", "sent", "accepted")).length;
  c.eligible = alerts.filter((a) => isEligible(a.status)).length;
  const traded = c.filled + c.partiallyFilled;
  const fillRate = c.eligible > 0 ? traded / c.eligible : null;

  // --- latency: alert received -> first fill, both on our clock. For an approved alert the clock starts at the
  // human decision, so waiting for the user never shows up as slowness. ---
  const latSeries: LatencyPoint[] = alerts
    .filter((a) => a.firstFillEventAtMs !== null)
    .map((a) => {
      const start = a.approvalGated && a.approvalDecidedAtMs !== null ? Math.max(a.receivedEventAtMs, a.approvalDecidedAtMs) : a.receivedEventAtMs;
      return {
        alertId: a.id,
        atMs: Math.round(a.receivedAtMs),
        latencyMs: round((a.firstFillEventAtMs as number) - start, 1),
        sentCount: a.sentCount,
      };
    })
    .filter((p) => p.latencyMs >= 0);
  const lats = latSeries.map((p) => p.latencyMs).sort((x, y) => x - y);
  const avg = lats.length ? lats.reduce((s, x) => s + x, 0) / lats.length : null;

  // --- slippage per fill, and what it cost in USD ---
  const slipSeries: ReportCard["slippage"]["series"] = [];
  let costUsd = 0;
  for (const a of alerts) {
    if (!a.alertPrice || !a.side || !a.kind) continue;
    for (const f of a.fills) {
      const bps = slippageBpsFor(a.alertPrice, f.price, a.side, a.kind);
      if (!Number.isFinite(bps)) continue;
      slipSeries.push({ alertId: a.id, atMs: Math.round(a.receivedAtMs), market: a.market, bps: round(bps, 2) });
      costUsd += (bps / 1e4) * a.alertPrice * f.size; // positive = the trader paid more than the alert price
    }
  }
  const slips = slipSeries.map((p) => p.bps).sort((x, y) => x - y);
  return {
    c,
    traded,
    fillRate,
    latSeries,
    lats,
    avg,
    slipSeries,
    slips,
    costUsd,
    medianLatency: nullableRound(percentile(lats, 0.5), 1),
    p95Latency: nullableRound(percentile(lats, 0.95), 1),
    medianSlip: nullableRound(percentile(slips, 0.5), 2),
  };
}

export function buildReportCard(args: {
  strategy: { id: string; name: string };
  range: ReportRange;
  now: number;
  alerts: ReportAlertInput[];
  /** Alerts of the window right before this one ({@link priorWindow}); omit when unknown. */
  priorAlerts?: ReportAlertInput[] | undefined;
  /** The strategy's max slippage in bps (its own setting, else the account default). */
  slippageCapBps?: number | undefined;
}): ReportCard {
  const { strategy, range, now, alerts } = args;
  const since = rangeStart(range, now);
  const a = analyze(alerts);
  const { c, traded, fillRate, latSeries, lats, slips, slipSeries } = a;

  const latencyBase = {
    count: lats.length,
    medianMs: a.medianLatency,
    p95Ms: a.p95Latency,
    avgMs: nullableRound(a.avg, 1),
    minMs: lats.length ? (lats[0] as number) : null,
    maxMs: lats.length ? (lats[lats.length - 1] as number) : null,
    series: latSeries.map(({ sentCount: _s, ...p }) => p),
  };
  const firstAt = alerts.length ? (alerts[0] as ReportAlertInput).receivedAtMs : now;
  const bucketMs = bucketSizeMs(range, now - firstAt);
  const byBucket = new Map<number, number[]>();
  for (const p of latSeries) {
    const start = Math.floor(p.atMs / bucketMs) * bucketMs;
    const list = byBucket.get(start);
    if (list) list.push(p.latencyMs);
    else byBucket.set(start, [p.latencyMs]);
  }
  const buckets = [...byBucket.entries()]
    .sort(([x], [y]) => x - y)
    .map(([atMs, xs]) => {
      const sorted = [...xs].sort((x, y) => x - y);
      return { atMs, count: sorted.length, medianMs: round(percentile(sorted, 0.5) as number, 1), p95Ms: round(percentile(sorted, 0.95) as number, 1) };
    });
  let worst: LatencyPoint | undefined;
  for (const p of latSeries) if (!worst || p.latencyMs > worst.latencyMs) worst = p;
  const maxPoint: ReportCard["latency"]["maxPoint"] = worst
    ? {
        at: worst.atMs,
        ms: worst.latencyMs,
        alertId: worst.alertId,
        ...(worst.sentCount > 1 ? { note: "Order was resent after no status from Perpl" } : {}),
      }
    : null;
  const latency: ReportCard["latency"] = { ...latencyBase, bucketMs, buckets, maxPoint };

  const histogram: HistogramBucket[] = BUCKETS.map((b) => ({
    label: b.label,
    minBps: b.min,
    maxBps: b.max,
    count: slips.filter((x) => (b.min === null || x >= b.min) && (b.max === null || x < b.max)).length,
  }));
  const slippage: ReportCard["slippage"] = {
    count: slips.length,
    avgBps: nullableRound(slips.length ? slips.reduce((s, x) => s + x, 0) / slips.length : null, 2),
    medianBps: a.medianSlip,
    p95Bps: nullableRound(percentile(slips, 0.95), 2),
    worstBps: slips.length ? (slips[slips.length - 1] as number) : null,
    costUsd: round(a.costUsd, 2),
    buckets: histogram,
    series: slipSeries,
  };

  // --- missed (blocked / expired / failed) by reason ---
  const groups = new Map<string, MissedGroup>();
  for (const al of alerts) {
    let g: Omit<MissedGroup, "count" | "lastAt"> | undefined;
    if (al.status === "blocked" || al.status === "expired") {
      const reason: BlockReason = al.blockReason ?? (al.status === "expired" ? "approval_expired" : "market_not_allowed");
      g = { kind: al.status, reason, label: BLOCK_REASON_LABELS[reason] };
    } else if (al.status === "failed") {
      const code = al.errorCode ?? "unknown";
      g = { kind: "failed", reason: code, label: failureLabel(code) };
    }
    if (!g) continue;
    const key = `${g.kind}:${g.reason}`;
    const existing = groups.get(key);
    const at = Math.round(al.receivedAtMs);
    if (existing) {
      existing.count++;
      existing.lastAt = Math.max(existing.lastAt, at);
    } else groups.set(key, { ...g, count: 1, lastAt: at });
  }
  const missed = [...groups.values()].sort((x, y) => y.count - x.count || x.reason.localeCompare(y.reason));

  // --- pnl ---
  let realized = 0;
  let fees = 0;
  let wins = 0;
  let closed = 0;
  let best: number | null = null;
  let worstPnl: number | null = null;
  const perDay = new Map<string, number>();
  for (const al of alerts) {
    let alertPnl: number | null = null;
    for (const f of al.fills) {
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
      worstPnl = worstPnl === null ? alertPnl : Math.min(worstPnl, alertPnl);
    }
  }
  let cumulative = 0;
  const daily = [...perDay.entries()]
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([day, p]) => {
      cumulative += p;
      return { day, pnlUsd: round(p), cumulativeUsd: round(cumulative) };
    });
  const pnl = {
    realizedUsd: round(realized),
    feesUsd: round(fees, 4),
    netUsd: round(realized - fees),
    closedTrades: closed,
    winRate: closed ? round(wins / closed, 4) : null,
    bestUsd: best === null ? null : round(best),
    worstUsd: worstPnl === null ? null : round(worstPnl),
    daily,
  };

  // --- grade ---
  const fillScore = fillRate === null ? 0 : fillRate * 100;
  const slipScore = slippage.medianBps === null ? 0 : clamp100(100 - ((slippage.medianBps - 2) / 18) * 100);
  const speedScore = latency.p95Ms === null ? 0 : clamp100(100 - ((latency.p95Ms - 500) / 2500) * 100);
  const rawScore = W_FILL * fillScore + W_SLIP * slipScore + W_SPEED * speedScore;
  const enough = c.eligible >= GRADE_MIN_ELIGIBLE;
  const score = enough ? round(rawScore, 1) : null;
  const grade: Grade | null = score === null ? null : score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
  const gradeParts: GradePart[] = enough
    ? [
        {
          key: "fillRate",
          label: "Fill rate",
          weight: W_FILL,
          measured: fillRate === null ? null : round(fillRate, 4),
          measuredLabel: fillRate === null ? "No data" : `${(fillRate * 100).toFixed(1)}%`,
          score: round(fillScore, 1),
        },
        {
          key: "slippage",
          label: "Slippage",
          weight: W_SLIP,
          measured: slippage.medianBps,
          measuredLabel: slippage.medianBps === null ? "No fills" : `${slippage.medianBps.toFixed(1)} bps`,
          score: round(slipScore, 1),
        },
        {
          key: "speed",
          label: "Speed",
          weight: W_SPEED,
          measured: latency.p95Ms,
          measuredLabel: latency.p95Ms === null ? "No fills" : `p95 ${fmtMs(latency.p95Ms)}`,
          score: round(speedScore, 1),
        },
      ]
    : [];
  const gradeSummary = enough ? summarize(grade as Grade, c.eligible - traded, slippage.medianBps, latency.p95Ms, fillScore, slipScore, speedScore) : null;
  const gradeBreakdown: ReportCard["gradeBreakdown"] = {
    // legacy shape kept for existing consumers: points now follow the 40 / 35 / 25 formula, reliability is retired
    fillRate: { points: round(W_FILL * fillScore, 2), max: 40, value: fillRate === null ? null : round(fillRate, 4) },
    slippage: { points: round(W_SLIP * slipScore, 2), max: 35, value: slippage.medianBps },
    latency: { points: round(W_SPEED * speedScore, 2), max: 25, value: latency.p95Ms },
    reliability: { points: 0, max: 0, value: null },
  };

  // --- prior window ---
  let prior: ReportCard["prior"] = null;
  const pw = priorWindow(range, now);
  if (pw && args.priorAlerts) {
    const p = analyze(args.priorAlerts);
    const delta = (cur: number | null, old: number | null, dp: number): number | null => (cur === null || old === null ? null : round(cur - old, dp));
    prior = {
      since: pw.since,
      until: pw.until,
      eligible: p.c.eligible,
      fillRate: p.fillRate === null ? null : round(p.fillRate, 4),
      medianLatencyMs: p.medianLatency,
      p95LatencyMs: p.p95Latency,
      medianSlippageBps: p.medianSlip,
      medianLatencyDeltaMs: delta(latency.medianMs, p.medianLatency, 1),
      fillRateDelta: delta(fillRate, p.fillRate, 4),
      medianSlippageDeltaBps: delta(slippage.medianBps, p.medianSlip, 2),
    };
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
    gradeReason: enough ? null : `Grades start after ${GRADE_MIN_ELIGIBLE} alerts that pass your limits. ${c.eligible} so far.`,
    gradeMinEligible: GRADE_MIN_ELIGIBLE,
    gradeParts,
    gradeSummary,
    gradeBreakdown,
    gradeExplanation: GRADE_EXPLANATION,
    approvalGated: alerts.filter((x) => x.approvalGated).length,
    slippageCapBps: args.slippageCapBps ?? 0,
    prior,
  };
}

/** One line naming the part that costs the most points. */
function summarize(
  grade: Grade,
  missedEligible: number,
  medianBps: number | null,
  p95Ms: number | null,
  fillScore: number,
  slipScore: number,
  speedScore: number,
): string {
  const losses = [
    { part: "fill" as const, lost: W_FILL * (100 - fillScore) },
    { part: "slip" as const, lost: W_SLIP * (100 - slipScore) },
    { part: "speed" as const, lost: W_SPEED * (100 - speedScore) },
  ].sort((x, y) => y.lost - x.lost);
  const worst = losses[0] as { part: "fill" | "slip" | "speed"; lost: number };
  if (worst.lost < 0.05) return "Nothing is dragging the grade down.";
  const lead = grade === "A" ? "Strong execution. " : "An A starts at 90. ";
  switch (worst.part) {
    case "fill":
      return `${lead}The biggest drag is ${missedEligible} alert${missedEligible === 1 ? "" : "s"} that passed your limits but did not fill.`;
    case "slip":
      return `${lead}The biggest drag is ${medianBps === null ? "slippage that could not be measured" : `median slippage of ${medianBps.toFixed(1)} bps`}.`;
    case "speed":
      return `${lead}The biggest drag is ${p95Ms === null ? "a speed that could not be measured" : `a p95 time of ${fmtSecs(p95Ms)}`}.`;
  }
}

const clamp100 = (x: number): number => Math.min(100, Math.max(0, x));

function nullableRound(x: number | null, dp: number): number | null {
  return x === null ? null : round(x, dp);
}
