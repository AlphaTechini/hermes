import { CircleCheck } from "lucide-react";
import { useMemo } from "react";
import type { ReportCard } from "@hermes/shared";
import { formatNumber } from "../../lib/format";
import { Card, CardFooter, CardHeader, DataTable, EmptyState, Meter, StatusPill } from "../../components/ui";

interface Row {
  key: string;
  label: string;
  kind: "missed" | "blocked" | "ignored";
  count: number;
}

/** Blocked and missed alerts grouped by reason, biggest first. Blocked = a Hermes limit, missed = passed checks but did not fill, ignored = duplicate. */
export function MissedCard({ report, loading }: { report: ReportCard | undefined; loading: boolean }) {
  const rows = useMemo<Row[]>(() => {
    if (!report) return [];
    const out: Row[] = report.missed.map((g) => ({
      key: `${g.kind}:${g.reason}`,
      label: g.label,
      kind: g.kind === "blocked" ? "blocked" : "missed",
      count: g.count,
    }));
    if (report.counts.duplicate > 0) out.push({ key: "duplicate", label: "Duplicate alert id", kind: "ignored", count: report.counts.duplicate });
    return out.sort((a, b) => b.count - a.count);
  }, [report]);
  const total = rows.reduce((s, r) => s + r.count, 0);
  const stopped = rows.filter((r) => r.kind !== "ignored").reduce((s, r) => s + r.count, 0);

  return (
    <Card className="span-6">
      <CardHeader title="Blocked and missed" meta={report ? `${formatNumber(stopped)} ${stopped === 1 ? "alert" : "alerts"} that did not become fills` : undefined} />
      <DataTable<Row>
        aria-label="Blocked and missed alerts by reason"
        rows={rows}
        loading={loading || !report}
        skeletonRows={5}
        rowKey={(r) => r.key}
        empty={
          <EmptyState icon={CircleCheck} title="Nothing was blocked or missed">
            Every alert in this range either filled or is still in flight.
          </EmptyState>
        }
        columns={[
          { key: "reason", header: "Reason", wrap: true, cell: (r) => r.label },
          {
            key: "kind",
            header: "Kind",
            cell: (r) => (
              <StatusPill outline tone={r.kind === "missed" ? "negative" : r.kind === "blocked" ? "warning" : "neutral"}>
                {r.kind === "missed" ? "Missed" : r.kind === "blocked" ? "Blocked" : "Ignored"}
              </StatusPill>
            ),
          },
          { key: "n", header: "Alerts", numeric: true, cell: (r) => r.count },
          {
            key: "share",
            header: "Share",
            hideSm: true,
            cell: (r) => (
              <span className="share">
                <Meter value={r.count} max={total} tone="ok" aria-label={`${r.label} share of stopped alerts`} />
                <span className="mono xs muted">{Math.round((r.count / total) * 100)}%</span>
              </span>
            ),
          },
        ]}
      />
      <CardFooter>
        <span>Blocked, expired and failed alerts count against the fill rate. Ignored duplicates never do.</span>
      </CardFooter>
    </Card>
  );
}
