import { useQuery } from "@tanstack/react-query";
import {
  BLOCK_REASON_LABELS,
  type AlertListResponse,
  type AlertRecord,
  type BlockReason,
  type Fill,
  type Grade,
  type GradeComponent,
  type MissedGroup,
  type ReportCard,
  type ReportRange,
} from "@hermes/shared";
import { useAuthEnabled } from "../../auth/context";
import { get } from "../../lib/api";
import { formatBps, formatMs } from "../../lib/format";
import { qk, useReport } from "../../lib/queries";

/** The Report card range control. The API knows 7d, 30d and all; 24h is built here from alerts and fills. */
export type UiRange = "24h" | ReportRange;
export const UI_RANGES: UiRange[] = ["24h", "7d", "30d", "all"];
export const isUiRange = (v: string | null): v is UiRange => v !== null && (UI_RANGES as string[]).includes(v);

const DAY = 86_400_000;
/** Grades start after this many eligible alerts (DESIGN.md 10.8). */
export const MIN_GRADE_ALERTS = 20;

// --- fetching ------------------------------------------------------------------------

export interface ReportResult {
  data: ReportCard | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

/** `GET /api/reports/:id?range=` for 7d, 30d and all; a client-built card for 24h. Both are refreshed by the SSE stream. */
export function useReportCard(strategyId: string | undefined, range: UiRange, strategyName: string | undefined): ReportResult {
  const enabledAuth = useAuthEnabled();
  const is24 = range === "24h";
  const api = useReport(is24 ? undefined : strategyId, is24 ? "7d" : range);
  const local = useQuery({
    queryKey: qk.reports.one(strategyId ?? "", "24h" as unknown as ReportRange),
    enabled: enabledAuth && is24 && Boolean(strategyId),
    queryFn: async () => {
      const now = Date.now();
      const since = now - DAY;
      const alerts: AlertRecord[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const res = await get<AlertListResponse>("/api/alerts", { strategyId, limit: 200, cursor });
        alerts.push(...res.items.filter((a) => a.receivedAt >= since));
        const oldest = res.items[res.items.length - 1];
        if (!res.nextCursor || !oldest || oldest.receivedAt < since) break;
        cursor = res.nextCursor;
      }
      const fills = await get<Fill[]>("/api/fills", { limit: 500 });
      return buildLocalReport({ strategyId: strategyId ?? "", strategyName: strategyName ?? "", alerts, fills, now });
    },
  });
  if (is24) return { data: local.data, isLoading: local.isLoading, isError: local.isError, refetch: () => void local.refetch() };
  return { data: api.data, isLoading: api.isLoading, isError: api.isError, refetch: () => void api.refetch() };
}

// --- 24h card, same formulas as the server's report card -------------------------------

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const round = (x: number, dp = 2) => Math.round(x * 10 ** dp) / 10 ** dp;
const nr = (x: number | null, dp: number) => (x === null ? null : round(x, dp));

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const idx = clamp01(p) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

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
};
const failureLabel = (code: string) => FAILURE_LABELS[code] ?? (code.startsWith("sr:") ? `Perpl rejected the order (reason ${code.slice(3)})` : `Failed: ${code.replace(/_/g, " ")}`);

export const GRADE_EXPLANATION =
  "Score out of 100 = fill rate (35) + slippage (25) + latency (20) + reliability (20). " +
  "Fill rate = filled or partially filled alerts divided by verified alerts that should have traded (blocked, expired and failed count against it). " +
  "Slippage: median bps vs the alert price, full marks at 0 bps or better, zero at 20 bps or worse. " +
  "Latency: p95 alert-to-first-fill, full marks at 1 s or less, zero at 5 s or more. " +
  "Reliability: share of attempted orders that did not fail. " +
  "Slippage or latency that cannot be measured earns half its points. Grades: A 90+, B 80+, C 70+, D 60+, otherwise F.";

export function buildLocalReport(args: { strategyId: string; strategyName: string; alerts: AlertRecord[]; fills: Fill[]; now: number }): ReportCard {
  const { alerts, now } = args;
  const ids = new Set(alerts.map((a) => a.id));
  const fills = args.fills.filter((f) => f.alertId && ids.has(f.alertId));

  const c = { total: alerts.length, verified: 0, shouldHaveTraded: 0, filled: 0, partiallyFilled: 0, blocked: 0, expired: 0, failed: 0, rejectedAuth: 0, duplicate: 0, invalid: 0, inFlight: 0 };
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
  c.verified = c.shouldHaveTraded + alerts.filter((a) => ["verified", "risk_checked", "pending_approval", "sent", "accepted"].includes(a.status)).length;
  const traded = c.filled + c.partiallyFilled;
  const fillRate = c.shouldHaveTraded > 0 ? traded / c.shouldHaveTraded : null;

  const latSeries = alerts.filter((a) => a.latencyMs !== null && a.latencyMs >= 0).map((a) => ({ alertId: a.id, atMs: a.receivedAt, latencyMs: round(a.latencyMs as number, 1) }));
  const lats = latSeries.map((p) => p.latencyMs).sort((x, y) => x - y);
  const latency: ReportCard["latency"] = {
    count: lats.length,
    medianMs: nr(percentile(lats, 0.5), 1),
    p95Ms: nr(percentile(lats, 0.95), 1),
    avgMs: nr(lats.length ? lats.reduce((s, x) => s + x, 0) / lats.length : null, 1),
    minMs: lats.length ? lats[0]! : null,
    maxMs: lats.length ? lats[lats.length - 1]! : null,
    series: latSeries,
  };

  const slipSeries = alerts.filter((a) => a.slippageBps !== null).map((a) => ({ alertId: a.id, atMs: a.receivedAt, market: a.market, bps: round(a.slippageBps as number, 2) }));
  const slips = slipSeries.map((p) => p.bps).sort((x, y) => x - y);
  const slippage: ReportCard["slippage"] = {
    count: slips.length,
    avgBps: nr(slips.length ? slips.reduce((s, x) => s + x, 0) / slips.length : null, 2),
    medianBps: nr(percentile(slips, 0.5), 2),
    p95Bps: nr(percentile(slips, 0.95), 2),
    worstBps: slips.length ? slips[slips.length - 1]! : null,
    buckets: [],
    series: slipSeries,
  };

  const groups = new Map<string, MissedGroup>();
  for (const a of alerts) {
    let g: MissedGroup | undefined;
    if (a.status === "blocked" || a.status === "expired") {
      const reason: BlockReason = a.blockReason ?? (a.status === "expired" ? "approval_expired" : "market_not_allowed");
      g = { kind: a.status, reason, label: BLOCK_REASON_LABELS[reason], count: 0 };
    } else if (a.status === "failed") {
      const code = a.errorCode ?? "unknown";
      g = { kind: "failed", reason: code, label: failureLabel(code), count: 0 };
    }
    if (!g) continue;
    const key = `${g.kind}:${g.reason}`;
    const ex = groups.get(key);
    if (ex) ex.count++;
    else groups.set(key, { ...g, count: 1 });
  }
  const missed = [...groups.values()].sort((x, y) => y.count - x.count || x.reason.localeCompare(y.reason));

  let realized = 0, feesTotal = 0, wins = 0, closed = 0;
  let best: number | null = null;
  let worst: number | null = null;
  const perAlert = new Map<string, number>();
  for (const f of fills) {
    feesTotal += f.fee;
    if (f.realizedPnl !== null && f.alertId) {
      realized += f.realizedPnl;
      perAlert.set(f.alertId, (perAlert.get(f.alertId) ?? 0) + f.realizedPnl);
    }
  }
  for (const v of perAlert.values()) {
    closed++;
    if (v > 0) wins++;
    best = best === null ? v : Math.max(best, v);
    worst = worst === null ? v : Math.min(worst, v);
  }
  const pnl: ReportCard["pnl"] = {
    realizedUsd: round(realized),
    feesUsd: round(feesTotal, 4),
    netUsd: round(realized - feesTotal),
    closedTrades: closed,
    winRate: closed ? round(wins / closed, 4) : null,
    bestUsd: best === null ? null : round(best),
    worstUsd: worst === null ? null : round(worst),
    daily: [],
  };

  const attempted = traded + c.failed;
  const comp = (points: number, max: number, value: number | null): GradeComponent => ({ points: round(points, 2), max, value });
  const gradeBreakdown: ReportCard["gradeBreakdown"] = {
    fillRate: comp(35 * (fillRate ?? 0), 35, fillRate === null ? null : round(fillRate, 4)),
    slippage: slippage.medianBps === null ? comp(12.5, 25, null) : comp(25 * clamp01(1 - Math.max(slippage.medianBps, 0) / 20), 25, slippage.medianBps),
    latency: latency.p95Ms === null ? comp(10, 20, null) : comp(20 * clamp01(1 - (latency.p95Ms - 1000) / 4000), 20, latency.p95Ms),
    reliability: comp(attempted === 0 ? 20 : 20 * (1 - c.failed / attempted), 20, attempted === 0 ? null : round(c.failed / attempted, 4)),
  };
  let score: number | null = null;
  let grade: Grade | null = null;
  if (fillRate !== null) {
    score = round(gradeBreakdown.fillRate.points + gradeBreakdown.slippage.points + gradeBreakdown.latency.points + gradeBreakdown.reliability.points, 1);
    grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
  }

  return {
    strategyId: args.strategyId,
    strategyName: args.strategyName,
    range: "7d",
    since: now - DAY,
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

// --- derived view numbers ---------------------------------------------------------------

/** Alerts that passed every limit: filled, partly filled, expired approvals and failures (blocks are excluded). */
export const eligibleAlerts = (r: ReportCard): number => r.counts.filled + r.counts.partiallyFilled + r.counts.expired + r.counts.failed;
/** Whether a grade is shown (needs 20 eligible alerts and a computed score). */
export const gradeReady = (r: ReportCard | undefined): boolean => Boolean(r && r.grade && r.score !== null && eligibleAlerts(r) >= MIN_GRADE_ALERTS);

/** Latency buckets (median and p95 per bucket). Empty buckets are left out so the lines never invent data. */
export interface LatencyBucket {
  start: number;
  median: number;
  p95: number;
  count: number;
}
export type Granularity = "hour" | "6h" | "day";
const STEP: Record<Granularity, number> = { hour: 3_600_000, "6h": 6 * 3_600_000, day: DAY };

export function pickGranularity(range: UiRange, series: ReportCard["latency"]["series"]): Granularity {
  if (range === "24h") return "hour";
  if (range === "7d") return "6h";
  if (range === "30d") return "day";
  if (series.length === 0) return "day";
  const span = Math.max(...series.map((p) => p.atMs)) - Math.min(...series.map((p) => p.atMs));
  return span <= 2 * DAY ? "hour" : span <= 10 * DAY ? "6h" : "day";
}

export function latencyBuckets(series: ReportCard["latency"]["series"], g: Granularity): LatencyBucket[] {
  const step = STEP[g];
  const tzOffset = new Date().getTimezoneOffset() * 60_000;
  // Align to local clock boundaries so "06:00" means local 06:00.
  const align = (t: number) => Math.floor((t - tzOffset) / step) * step + tzOffset;
  const map = new Map<number, number[]>();
  for (const p of series) {
    const k = align(p.atMs);
    const arr = map.get(k);
    if (arr) arr.push(p.latencyMs);
    else map.set(k, [p.latencyMs]);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, vals]) => {
      const s = vals.sort((a, b) => a - b);
      return { start, median: percentile(s, 0.5) ?? 0, p95: percentile(s, 0.95) ?? 0, count: s.length };
    });
}

/** Per-fill slippage histogram: `<0`, then 1 bps bins `0` to `11`, then `12+`. */
export interface SlipBin {
  label: string;
  count: number;
  /** Lower bound in bps, null for the `<0` bin. */
  from: number | null;
}
export function slippageBins(series: ReportCard["slippage"]["series"]): SlipBin[] {
  const bins: SlipBin[] = [{ label: "<0", count: 0, from: null }];
  for (let i = 0; i < 12; i++) bins.push({ label: String(i), count: 0, from: i });
  bins.push({ label: "12+", count: 0, from: 12 });
  for (const p of series) {
    const i = p.bps < 0 ? 0 : p.bps >= 12 ? 13 : 1 + Math.floor(p.bps);
    bins[i]!.count++;
  }
  return bins;
}
/** Position of a bps value on the histogram axis, in bin units. */
export const medianAt = (bps: number): number => (bps < 0 ? 0.5 : bps >= 12 ? 13.5 : 1 + bps);

/** The grade component that lost the most points, as a sentence for the grade panel. */
export function biggestDrag(r: ReportCard): string | null {
  const b = r.gradeBreakdown;
  const parts = [
    { key: "fill", lost: b.fillRate.max - b.fillRate.points },
    { key: "slip", lost: b.slippage.max - b.slippage.points },
    { key: "lat", lost: b.latency.max - b.latency.points },
    { key: "rel", lost: b.reliability.max - b.reliability.points },
  ].sort((a, c) => c.lost - a.lost);
  const top = parts[0]!;
  if (top.lost < 0.5) return null;
  const c = r.counts;
  switch (top.key) {
    case "fill": {
      const n = c.blocked + c.expired + c.failed;
      return `The biggest drag is ${n} ${n === 1 ? "alert" : "alerts"} that did not fill.`;
    }
    case "slip":
      return r.slippage.medianBps === null ? "The biggest drag is slippage that could not be measured yet." : `The biggest drag is median slippage of ${formatBps(r.slippage.medianBps)}.`;
    case "lat":
      return r.latency.p95Ms === null ? "The biggest drag is speed that could not be measured yet." : `The biggest drag is a p95 time of ${formatMs(r.latency.p95Ms)}.`;
    default:
      return `The biggest drag is ${c.failed} ${c.failed === 1 ? "order" : "orders"} that failed.`;
  }
}
