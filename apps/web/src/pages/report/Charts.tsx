import { Activity, ChartColumn } from "lucide-react";
import { useMemo } from "react";
import type { ReportCard } from "@hermes/shared";
import { formatDateTime, formatMs, formatNumber } from "../../lib/format";
import { Card, CardHeader, ChartLegend, EmptyState, Histogram, LineChart, Skeleton } from "../../components/ui";
import { latencyBuckets, medianAt, pickGranularity, slippageBins, type Granularity, type UiRange } from "./report-data";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const GRAN_META: Record<Granularity, string> = { hour: "Every hour", "6h": "Every 6 hours", day: "Every day" };
const pad = (n: number) => String(n).padStart(2, "0");
const dayLabel = (t: number) => `${new Date(t).getDate()} ${MONTHS[new Date(t).getMonth()]}`;
const hourLabel = (t: number) => `${pad(new Date(t).getHours())}:00`;

const msAxis = (v: number) => (v >= 1000 ? `${v / 1000} s` : String(v));
function msTicks(max: number): number[] {
  const steps = [100, 200, 250, 500, 1000, 2000, 5000, 10000];
  const step = steps.find((s) => Math.ceil(max / s) <= 4) ?? 10000;
  const top = Math.max(step, Math.ceil(max / step) * step);
  const out: number[] = [];
  for (let v = 0; v <= top; v += step) out.push(v);
  return out;
}

export function LatencyCard({ report, range, loading }: { report: ReportCard | undefined; range: UiRange; loading: boolean }) {
  const g = report ? pickGranularity(range, report.latency.series) : "6h";
  const buckets = useMemo(() => (report ? latencyBuckets(report.latency.series, g) : []), [report, g]);

  const view = useMemo(() => {
    if (buckets.length < 2) return null;
    const p95 = buckets.map((b) => b.p95);
    const worst = p95.indexOf(Math.max(...p95));
    // Day labels at local midnight buckets; hour labels every few hours; fall back to even spacing.
    let ticks: { index: number; label: string }[] = [];
    if (g === "day") ticks = buckets.map((b, i) => ({ index: i, label: dayLabel(b.start) })).filter((_, i, a) => i % Math.max(1, Math.ceil(a.length / 8)) === 0);
    else if (g === "6h") ticks = buckets.map((b, i) => ({ index: i, label: dayLabel(b.start), hour: new Date(b.start).getHours() })).filter((t) => t.hour === 0).map(({ index, label }) => ({ index, label }));
    else ticks = buckets.map((b, i) => ({ index: i, label: hourLabel(b.start), hour: new Date(b.start).getHours() })).filter((t) => t.hour % 6 === 0).map(({ index, label }) => ({ index, label }));
    if (ticks.length < 2 || ticks.length > 9) {
      const n = Math.min(5, buckets.length);
      ticks = Array.from({ length: n }, (_, k) => {
        const index = Math.round((k / (n - 1)) * (buckets.length - 1));
        const b = buckets[index]!;
        return { index, label: g === "day" ? dayLabel(b.start) : `${dayLabel(b.start)} ${hourLabel(b.start)}` };
      });
    }
    return { p95, worst, ticks, yTicks: msTicks(Math.max(...p95)) };
  }, [buckets, g]);

  return (
    <Card style={{ flex: 1 }}>
      <CardHeader title="Alert to fill latency" meta={GRAN_META[g]} actions={<ChartLegend items={[{ label: "Median" }, { label: "p95", tone: "secondary" }]} />} />
      <div style={{ padding: "12px 16px 8px" }}>
        {loading || !report ? (
          <Skeleton h={220} />
        ) : view ? (
          <LineChart
            aria-label="Median and p95 alert to fill latency over time"
            height={220}
            series={[
              { key: "median", label: "Median", values: buckets.map((b) => b.median) },
              { key: "p95", label: "p95", values: view.p95, tone: "secondary" },
            ]}
            yTicks={view.yTicks}
            formatY={msAxis}
            xTicks={view.ticks}
            annotation={{ index: view.worst, seriesKey: "p95", text: formatMs(view.p95[view.worst]) }}
            tooltip={(i) => {
              const b = buckets[i]!;
              return (
                <>
                  <b>{g === "day" ? dayLabel(b.start) : formatDateTime(b.start).replace(/ (\d\d:\d\d)$/, ", $1")}</b>
                  <span>
                    Median {formatMs(b.median)} · p95 {formatMs(b.p95)}
                  </span>
                </>
              );
            }}
          />
        ) : (
          <EmptyState compact icon={Activity} title="Not enough fills to chart">
            Latency appears here once this strategy has fills on at least two different {g === "day" ? "days" : "hours"}.
          </EmptyState>
        )}
      </div>
    </Card>
  );
}

export function SlippageCard({ report, loading }: { report: ReportCard | undefined; loading: boolean }) {
  const bins = useMemo(() => (report ? slippageBins(report.slippage.series) : []), [report]);
  const total = report?.slippage.series.length ?? 0;
  const better = bins[0]?.count ?? 0;
  const within5 = bins.slice(0, 6).reduce((s, b) => s + b.count, 0);
  const over10 = bins.slice(11).reduce((s, b) => s + b.count, 0);
  const pct = (n: number) => (total ? `${formatNumber((n / total) * 100, 1)}%` : "n/a");
  const med = report?.slippage.medianBps ?? null;

  return (
    <Card className="span-6">
      <CardHeader title="Slippage distribution" meta={`${formatNumber(total)} fills · bps worse than the alert price`} />
      <div className="chart-wrap" style={{ flex: 1, display: "flex", alignItems: "center", padding: "12px 16px 8px" }}>
        <div style={{ width: "100%" }}>
          {loading || !report ? (
            <Skeleton h={220} />
          ) : total === 0 ? (
            <EmptyState compact icon={ChartColumn} title="No fills with an alert price yet">
              The distribution appears once fills have a price to compare with.
            </EmptyState>
          ) : (
            <Histogram
              aria-label="Slippage distribution in bps"
              height={220}
              bins={bins.map((b) => ({
                label: b.label,
                count: b.count,
                tip: {
                  title: `${b.count} ${b.count === 1 ? "fill" : "fills"}`,
                  detail: b.from === null ? "better than alert" : b.from === 12 ? "12 bps or more" : `${b.from} to ${b.from + 1} bps worse`,
                },
              }))}
              median={med === null ? undefined : { at: medianAt(med), label: `median ${formatNumber(med, 1)}` }}
            />
          )}
        </div>
      </div>
      <div className="appr-stats k3s" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        <div>
          <span className="l">Better than alert</span>
          <span className="v">
            {better} <span className="muted xs">{pct(better)}</span>
          </span>
        </div>
        <div>
          <span className="l">Within 5 bps</span>
          <span className="v">
            {within5} <span className="muted xs">{pct(within5)}</span>
          </span>
        </div>
        <div>
          <span className="l">Over 10 bps</span>
          <span className="v">
            {over10} <span className="muted xs">{pct(over10)}</span>
          </span>
        </div>
      </div>
    </Card>
  );
}
