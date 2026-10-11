import { CircleCheck } from "lucide-react";
import { useMemo } from "react";
import type { ReportCard } from "@hermes/shared";
import { formatNumber, formatTableTime } from "../../lib/format";
import { Card, CardFooter, CardHeader, DataTable, EmptyState, Meter, StatusPill } from "../../components/ui";

interface Row {
  key: string;
  label: string;
  kind: "missed" | "blocked" | "expired" | "ignored";
  count: number;
  /** Epoch ms of the newest alert in the group; null when the server does not say (duplicates). */
  lastAt: number | null;
}

const KIND_LABEL: Record<Row["kind"], string> = { missed: "Missed", blocked: "Blocked", expired: "Expired", ignored: "Ignored" };
const KIND_TONE = { missed: "negative", blocked: "warning", expired: "negative", ignored: "neutral" } as const;

/**
 * Blocked and missed alerts grouped by reason, biggest first. Blocked = a Hermes limit, missed = passed checks but did
 * not fill, expired = an approval that ran out, ignored = duplicate.
 */
export function MissedCard({ report, loading }: { report: ReportCard | undefined; loading: boolean }) {
  const rows = useMemo<Row[]>(() => {
    if (!report) return [];
    const out: Row[] = report.missed.map((g) => ({
      key: `${g.kind}:${g.reason}`,
      label: g.label,
      kind: g.kind === "blocked" ? "blocked" : g.kind === "expired" ? "expired" : "missed",
      count: g.count,
      lastAt: g.lastAt,
    }));
    if (report.counts.duplicate > 0) out.push({ key: "duplicate", label: "Duplicate alert id", kind: "ignored", count: report.counts.duplicate, lastAt: null });
    return out.sort((a, b) => b.count - a.count || (b.lastAt ?? 0) - (a.lastAt ?? 0));
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
              <StatusPill outline tone={KIND_TONE[r.kind]}>
                {KIND_LABEL[r.kind]}
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
                <span className="mono xs muted">{total > 0 ? Math.round((r.count / total) * 100) : 0}%</span>
              </span>
            ),
          },
          {
            key: "last",
            header: "Last",
            numeric: true,
            hideSm: true,
            mono: true,
            cell: (r) => (r.lastAt === null ? <span className="muted">n/a</span> : <span className="secondary">{formatTableTime(r.lastAt, report?.generatedAt)}</span>),
          },
        ]}
      />
      <CardFooter>
        <span>Blocked and ignored alerts do not count against the grade.</span>
      </CardFooter>
    </Card>
  );
}
