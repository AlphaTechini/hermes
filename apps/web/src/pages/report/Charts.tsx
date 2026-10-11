import { Activity, ChartColumn } from "lucide-react";
import { useMemo } from "react";
import type { ReportCard } from "@hermes/shared";
import { formatNumber } from "../../lib/format";
import { Card, CardFooter, CardHeader, ChartLegend, EmptyState, Histogram, Skeleton } from "../../components/ui";
import { LatencyChart } from "./LatencyChart";
import { medianAt, slippageBins } from "./report-data";

const BUCKET_META: Record<number, string> = { 3_600_000: "Every hour", 21_600_000: "Every 6 hours", 86_400_000: "Every day" };

export function LatencyCard({ report, loading }: { report: ReportCard | undefined; loading: boolean }) {
  const lat = report?.latency;
  const unit = lat && lat.bucketMs >= 86_400_000 ? "days" : "hours";
  return (
    <Card style={{ flex: 1 }}>
      <CardHeader
        title="Alert to fill latency"
        meta={lat ? (BUCKET_META[lat.bucketMs] ?? `Every ${formatNumber(lat.bucketMs / 3_600_000)} hours`) : undefined}
        actions={<ChartLegend items={[{ label: "Median" }, { label: "p95", tone: "secondary" }]} />}
      />
      <div style={{ padding: "12px 16px 8px" }}>
        {loading || !report || !lat ? (
          <Skeleton h={220} />
        ) : lat.buckets.length >= 2 ? (
          <LatencyChart buckets={lat.buckets} bucketMs={lat.bucketMs} maxPoint={lat.maxPoint} since={report.since} until={report.generatedAt} />
        ) : (
          <EmptyState compact icon={Activity} title="Not enough fills to chart">
            Latency appears here once fills land in at least two different {unit}.
          </EmptyState>
        )}
      </div>
      {report && report.approvalGated > 0 && (
        <CardFooter>
          <span>
            <span className="mono secondary">{formatNumber(report.approvalGated)}</span> {report.approvalGated === 1 ? "alert" : "alerts"} waited for your approval. That wait is not counted in alert to fill.
          </span>
        </CardFooter>
      )}
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
