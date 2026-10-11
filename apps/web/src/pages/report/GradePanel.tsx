import type { ReportCard } from "@hermes/shared";
import { formatBps, formatFraction, formatMs, formatNumber, orNA } from "../../lib/format";
import { Card, CardBody, CardHeader, GradeBadge, GradeScale, Skeleton } from "../../components/ui";
import { biggestDrag, eligibleAlerts, gradeReady, MIN_GRADE_ALERTS, type UiRange } from "./report-data";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `4 to 11 Oct`, `28 Sep to 11 Oct`, `Last 24 hours`, `All time`. */
export function rangeLabel(r: ReportCard, range: UiRange): string {
  if (range === "24h") return "Last 24 hours";
  if (r.since === null) return "All time";
  const a = new Date(r.since);
  const b = new Date(r.generatedAt);
  return a.getMonth() === b.getMonth() ? `${a.getDate()} to ${b.getDate()} ${MONTHS[b.getMonth()]}` : `${a.getDate()} ${MONTHS[a.getMonth()]} to ${b.getDate()} ${MONTHS[b.getMonth()]}`;
}

export function GradePanel({ report, range, loading }: { report: ReportCard | undefined; range: UiRange; loading: boolean }) {
  return (
    <Card className="span-4">
      <CardHeader title="Grade" meta={report ? `${rangeLabel(report, range)} · ${formatNumber(eligibleAlerts(report))} eligible alerts` : undefined} />
      <CardBody className="col g4">{loading || !report ? <GradeSkeleton /> : <GradeBody r={report} />}</CardBody>
    </Card>
  );
}

function GradeSkeleton() {
  return (
    <>
      <div className="grade" aria-busy="true" aria-label="Loading grade">
        <Skeleton w={64} h={64} r={12} />
        <div className="col g2" style={{ flex: 1 }}>
          <Skeleton w={96} h={24} />
          <Skeleton h={12} />
          <Skeleton w="70%" h={12} />
        </div>
      </div>
      <Skeleton h={20} />
      <Skeleton h={108} />
    </>
  );
}

function GradeBody({ r }: { r: ReportCard }) {
  const ready = gradeReady(r);
  const b = r.gradeBreakdown;
  const drag = biggestDrag(r);
  const rows: { name: string; weight: number; measured: string; score: number | null }[] = [
    { name: "Fill rate", weight: b.fillRate.max, measured: orNA(b.fillRate.value, formatFraction), score: b.fillRate.points },
    { name: "Slippage", weight: b.slippage.max, measured: orNA(b.slippage.value, (v) => formatBps(v)), score: b.slippage.points },
    { name: "Latency", weight: b.latency.max, measured: orNA(b.latency.value, (v) => `p95 ${formatMs(v)}`), score: b.latency.points },
    { name: "Reliability", weight: b.reliability.max, measured: b.reliability.value === null ? "n/a" : `${formatFraction(b.reliability.value)} failed`, score: b.reliability.points },
  ];
  return (
    <>
      <div className="grade">
        <GradeBadge grade={ready ? r.grade : null} />
        <div className="col g1">
          {ready ? (
            <>
              <div className="row g2">
                <span style={{ fontSize: 20, lineHeight: "28px", fontWeight: 500, letterSpacing: "-0.01em" }}>{formatNumber(r.score ?? 0, 1)}</span>
                <span className="muted">/ 100</span>
              </div>
              <span className="xs secondary">
                {r.grade !== "A" && "An A starts at 90. "}
                {drag ?? "Nothing is holding this grade back."}
              </span>
            </>
          ) : (
            <>
              <span style={{ fontSize: 16, lineHeight: "24px", fontWeight: 500 }}>Not enough data</span>
              <span className="xs secondary">
                Grades start after {MIN_GRADE_ALERTS} alerts that pass your limits. {formatNumber(eligibleAlerts(r))} so far.
              </span>
            </>
          )}
        </div>
      </div>
      <GradeScale grade={ready ? r.grade : null} />
      {ready && (
        <table className="t compact" style={{ margin: "0 -16px", width: "calc(100% + 32px)" }} aria-label="How each part scored">
          <thead>
            <tr>
              <th>Part</th>
              <th className="num">Weight</th>
              <th className="num">Measured</th>
              <th className="num">Score</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.name}>
                <td>{x.name}</td>
                <td className="num muted">{x.weight}%</td>
                <td className="num">{x.measured}</td>
                <td className="num">{x.score === null ? "n/a" : formatNumber((x.score / x.weight) * 100, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <details className="how" open>
        <summary>
          <svg className="i-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m9 18 6-6-6-6" />
          </svg>
          How the grade is computed
        </summary>
        <p>{r.gradeExplanation}</p>
      </details>
    </>
  );
}
