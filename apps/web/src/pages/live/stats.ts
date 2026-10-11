import type { AlertRecord } from "@hermes/shared";

export type OutcomeFilter = "all" | "filled" | "blocked" | "missed" | "dry_run";

/** Local midnight (epoch ms) of the day containing `now`. */
export function startOfToday(now: number = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const FILLED = new Set(["filled", "partially_filled"]);

/** Outcome bucket used by the stream filter and the KPI breakdown. Null = shown only under "All". */
export function bucketOf(a: Pick<AlertRecord, "status">): Exclude<OutcomeFilter, "all"> | null {
  if (FILLED.has(a.status)) return "filled";
  if (a.status === "blocked") return "blocked";
  // The strategy is in dry-run mode: every check ran, nothing was sent. Neither a fill nor a miss.
  if (a.status === "dry_run") return "dry_run";
  // Passed every limit but did not fill: failed orders and approvals that ran out.
  if (a.status === "failed" || a.status === "expired") return "missed";
  return null;
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx] ?? null;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? null) : (((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}

export interface TodayStats {
  total: number;
  filled: number;
  blocked: number;
  missed: number;
  /** Dry runs: all checks ran, nothing was sent. Not part of the fill rate. */
  dryRun: number;
  /** filled + missed: alerts that passed every limit and reached an end state. */
  eligible: number;
  /** 0..100, null when nothing is eligible yet. */
  fillRate: number | null;
  medianMs: number | null;
  p95Ms: number | null;
  medianSlipBps: number | null;
}

export function todayStats(alerts: AlertRecord[]): TodayStats {
  let filled = 0;
  let blocked = 0;
  let missed = 0;
  let dryRun = 0;
  const lat: number[] = [];
  const slip: number[] = [];
  for (const a of alerts) {
    const b = bucketOf(a);
    if (b === "filled") {
      filled++;
      // `latencyMs` already leaves out the time spent waiting for a human approval, so approved fills count as they are.
      if (a.latencyMs !== null) lat.push(a.latencyMs);
      if (a.slippageBps !== null) slip.push(a.slippageBps);
    } else if (b === "blocked") blocked++;
    else if (b === "missed") missed++;
    else if (b === "dry_run") dryRun++;
  }
  const eligible = filled + missed;
  const sorted = lat.slice().sort((a, b) => a - b);
  return {
    total: alerts.length,
    filled,
    blocked,
    missed,
    dryRun,
    eligible,
    fillRate: eligible > 0 ? (filled / eligible) * 100 : null,
    medianMs: median(lat),
    p95Ms: percentile(sorted, 0.95),
    medianSlipBps: median(slip),
  };
}
