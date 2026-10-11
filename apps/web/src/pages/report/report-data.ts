import type { ReportCard, ReportRange } from "@hermes/shared";
import { formatMs } from "../../lib/format";
import { useReport } from "../../lib/queries";

/** The Report card range control: 24h, 7d, 30d and all are all served by `GET /api/reports/:id?range=`. */
export type UiRange = ReportRange;
export const UI_RANGES: UiRange[] = ["24h", "7d", "30d", "all"];
export const isUiRange = (v: string | null): v is UiRange => v !== null && (UI_RANGES as string[]).includes(v);

/** The prior window the server compares with is the same length as the range: `prior 24h`, `prior 7d`. */
export const PRIOR_LABEL: Record<UiRange, string | null> = { "24h": "prior 24h", "7d": "prior 7d", "30d": "prior 30d", all: null };

export interface ReportResult {
  data: ReportCard | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

/** The server report card (refreshed by the SSE stream). Errors are reported only when there is nothing cached to show. */
export function useReportCard(strategyId: string | undefined, range: UiRange): ReportResult {
  const q = useReport(strategyId, range);
  return { data: q.data, isLoading: q.isLoading, isError: q.isError && !q.data, refetch: () => void q.refetch() };
}

// --- derived view numbers ---------------------------------------------------------------

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

/**
 * "38 ms faster than prior 7d" for a latency delta (current minus prior). null when there is nothing to compare with.
 * `tone` is positive when faster, negative when slower.
 */
export function latencyDeltaText(r: ReportCard, range: UiRange): { text: string; tone: "positive" | "negative" | "neutral" } | null {
  const label = PRIOR_LABEL[range];
  const d = r.prior?.medianLatencyDeltaMs;
  if (!label || d === null || d === undefined) return null;
  if (Math.abs(d) < 1) return { text: `Same as ${label}`, tone: "neutral" };
  return { text: `${formatMs(Math.abs(d))} ${d < 0 ? "faster" : "slower"} than ${label}`, tone: d < 0 ? "positive" : "negative" };
}
