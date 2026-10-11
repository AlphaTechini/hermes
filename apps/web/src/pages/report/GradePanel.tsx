import type { ReportCard } from "@hermes/shared";
import { formatNumber } from "../../lib/format";
import { Card, CardBody, CardHeader, GradeBadge, GradeScale, Meter, Skeleton } from "../../components/ui";
import type { UiRange } from "./report-data";

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
      <CardHeader title="Grade" meta={report ? `${rangeLabel(report, range)} · ${formatNumber(report.counts.eligible)} eligible ${report.counts.eligible === 1 ? "alert" : "alerts"}` : undefined} />
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

const Chevron = () => (
  <svg className="i-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m9 18 6-6-6-6" />
  </svg>
);

function GradeBody({ r }: { r: ReportCard }) {
  const graded = r.grade !== null && r.score !== null;
  const need = r.gradeMinEligible;
  const have = r.counts.eligible;
  return (
    <>
      {graded ? (
        <div className="grade">
          <GradeBadge grade={r.grade} />
          <div className="col g1" style={{ minWidth: 0 }}>
            <div className="row g2">
              <span style={{ fontSize: 20, lineHeight: "28px", fontWeight: 500, letterSpacing: "-0.01em" }}>{formatNumber(r.score ?? 0, 1)}</span>
              <span className="muted">/ 100</span>
            </div>
            {r.gradeSummary && <span className="xs secondary">{r.gradeSummary}</span>}
          </div>
        </div>
      ) : (
        <div className="grade" data-state="ungraded">
          <GradeBadge grade={null} />
          <div className="col g1" style={{ minWidth: 0 }}>
            <span style={{ fontSize: 16, lineHeight: "24px", fontWeight: 500 }}>Not enough alerts yet</span>
            <span className="xs secondary">{r.gradeReason ?? `Grades start after ${need} alerts that pass your limits. ${have} so far.`}</span>
          </div>
        </div>
      )}
      {!graded && (
        <div className="col g2">
          <Meter value={Math.min(have, need)} max={need} tone="accent" aria-label={`${have} of ${need} alerts needed for a grade`} />
          <span className="xs muted">
            <span className="mono secondary">{formatNumber(have)}</span> of <span className="mono secondary">{formatNumber(need)}</span> alerts that passed your limits
            {r.counts.dryRun > 0 && (
              <>
                {" "}
                · <span className="mono secondary">{formatNumber(r.counts.dryRun)}</span> dry run {r.counts.dryRun === 1 ? "alert" : "alerts"} not counted
              </>
            )}
          </span>
        </div>
      )}
      <GradeScale grade={r.grade} />
      {graded && r.gradeParts.length > 0 && (
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
            {r.gradeParts.map((p) => (
              <tr key={p.key}>
                <td>{p.label}</td>
                <td className="num muted">{Math.round(p.weight * 100)}%</td>
                <td className="num">{p.measured === null ? "n/a" : p.measuredLabel}</td>
                <td className="num">{formatNumber(p.score, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <details className="how" open={graded} key={graded ? "graded" : "ungraded"}>
        <summary>
          <Chevron />
          How the grade is computed
        </summary>
        <p>{r.gradeExplanation}</p>
      </details>
    </>
  );
}
