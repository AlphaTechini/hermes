import { ChartColumn, CircleX } from "lucide-react";
import { useMemo } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { PageHeader } from "../../components/shell/PageHeader";
import { formatBps, formatFraction, formatMs, formatNumber, formatSignedUsd, formatUsd, orNA, pnlTone } from "../../lib/format";
import { PAGE } from "../../lib/routes";
import { useLimits, useStrategies } from "../../lib/queries";
import { ButtonLink, Button, Card, EmptyState, KpiRow, KpiTile, SegmentedControl, Select, useDelayedFlag } from "../../components/ui";
import { LatencyCard, SlippageCard } from "./Charts";
import { GradePanel } from "./GradePanel";
import { MissedCard } from "./MissedCard";
import { isUiRange, useReportCard, type UiRange } from "./report-data";

const RANGE_OPTIONS: { value: UiRange; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

/** `/report/:strategyId?`: grade, key numbers, latency, slippage and what did not fill. */
export function ReportPage() {
  const { strategyId } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const rangeParam = search.get("range");
  const range: UiRange = isUiRange(rangeParam) ? rangeParam : "7d";
  const strategies = useStrategies();
  const limits = useLimits();
  const list = strategies.data;
  const current = list?.find((s) => s.id === strategyId);
  const report = useReportCard(current?.id, range, current?.name);
  const slow = useDelayedFlag(report.isLoading || strategies.isLoading);
  const r = report.data;

  const options = useMemo(() => (list ?? []).map((s) => ({ value: s.id, label: s.name, market: s.defaultMarket ?? undefined })), [list]);

  if (list && list.length > 0 && !current) return <Navigate to={`/report/${list[0]!.id}${search.toString() ? `?${search.toString()}` : ""}`} replace />;

  const setRange = (v: UiRange) => {
    const next = new URLSearchParams(search);
    if (v === "7d") next.delete("range");
    else next.set("range", v);
    setSearch(next, { replace: true });
  };

  const header = (
    <PageHeader
      title={PAGE.report.title}
      subtitle={PAGE.report.subtitle}
      actions={
        list && list.length > 0 ? (
          <>
            <Select variant="button" aria-label="Strategy" value={current?.id} onChange={(id) => navigate(`/report/${id}${search.toString() ? `?${search.toString()}` : ""}`)} options={options} />
            <SegmentedControl<UiRange> aria-label="Range" value={range} onChange={setRange} options={RANGE_OPTIONS} />
          </>
        ) : undefined
      }
    />
  );

  if (strategies.isError) {
    return (
      <>
        {header}
        <Card>
          <EmptyState icon={CircleX} tone="negative" title="Could not load strategies" actions={<Button onClick={() => void strategies.refetch()}>Retry</Button>}>
            Hermes did not respond. Your strategies are safe on the server.
          </EmptyState>
        </Card>
      </>
    );
  }
  if (list && list.length === 0) {
    return (
      <>
        {header}
        <Card>
          <EmptyState icon={ChartColumn} title="No strategies yet" actions={<ButtonLink variant="primary" to="/strategies">New strategy</ButtonLink>}>
            A report card needs a strategy and some alerts. Create a strategy to get a webhook URL.
          </EmptyState>
        </Card>
      </>
    );
  }
  if (report.isError) {
    return (
      <>
        {header}
        <Card>
          <EmptyState icon={CircleX} tone="negative" title="Could not load the report card" actions={<Button onClick={report.refetch}>Retry</Button>}>
            Hermes did not respond. Alerts are still being processed on the server.
          </EmptyState>
        </Card>
      </>
    );
  }

  const loading = !r && (report.isLoading || strategies.isLoading);
  const showSkeleton = loading && slow;
  const cap = limits.data?.defaultSlippageBps;
  const stoppedBlocked = r?.counts.blocked ?? 0;
  const stoppedMissed = r ? r.counts.expired + r.counts.failed : 0;
  const stopped = stoppedBlocked + stoppedMissed;
  const pnlCls = r ? pnlTone(r.pnl.realizedUsd) : "neutral";

  const split = (v: string): [string, string | undefined] => {
    const m = /^(.*?) (ms|s|bps)$/.exec(v);
    return m ? [m[1]!, m[2]] : [v, undefined];
  };
  const [medVal, medUnit] = r?.latency.medianMs != null ? split(formatMs(r.latency.medianMs)) : ["n/a", undefined];
  const [p95Val, p95Unit] = r?.latency.p95Ms != null ? split(formatMs(r.latency.p95Ms)) : ["n/a", undefined];
  const [slipVal, slipUnit] = r?.slippage.medianBps != null ? split(formatBps(r.slippage.medianBps)) : ["n/a", undefined];

  return (
    <>
      {header}
      <div className="grid-12" style={{ alignItems: "stretch" }}>
        <GradePanel report={r} range={range} loading={loading} />
        <div className="span-8 col g4" style={{ minWidth: 0 }}>
          <KpiRow cols={3} aria-label="Key numbers">
            <KpiTile
              label="Fill rate"
              loading={showSkeleton}
              value={r?.fillRate != null ? formatFraction(r.fillRate).replace("%", "") : "n/a"}
              unit={r?.fillRate != null ? "%" : undefined}
              sub={r ? `${formatNumber(r.counts.filled + r.counts.partiallyFilled)} of ${formatNumber(r.counts.shouldHaveTraded)} eligible alerts` : undefined}
            />
            <KpiTile label="Median alert to fill" loading={showSkeleton} value={medVal} unit={medUnit} sub={r ? `Across ${formatNumber(r.latency.count)} ${r.latency.count === 1 ? "fill" : "fills"}` : undefined} />
            <KpiTile
              label="p95 alert to fill"
              loading={showSkeleton}
              value={p95Val}
              unit={p95Unit}
              sub={r ? <>Slowest <span className="d secondary">{formatMs(r.latency.maxMs)}</span></> : undefined}
            />
            <KpiTile
              label="Median slippage"
              loading={showSkeleton}
              value={slipVal}
              unit={slipUnit}
              sub={
                r ? (
                  <>
                    p95 <span className="d secondary">{formatBps(r.slippage.p95Bps)}</span>
                    {cap !== undefined && <> · cap {formatNumber(cap)} bps</>}
                  </>
                ) : undefined
              }
            />
            <KpiTile
              label="Realized PnL"
              loading={showSkeleton}
              value={r ? formatSignedUsd(r.pnl.realizedUsd) : "n/a"}
              tone={pnlCls === "neutral" ? undefined : pnlCls}
              sub={
                r ? (
                  <>
                    Fees <span className="d secondary">{orNA(-r.pnl.feesUsd, (v) => (v === 0 ? "$0.00" : formatUsd(v)))}</span> · net <span className="d secondary">{formatSignedUsd(r.pnl.netUsd)}</span>
                  </>
                ) : undefined
              }
            />
            <KpiTile
              label="Stopped"
              loading={showSkeleton}
              value={r ? formatNumber(stopped) : "n/a"}
              sub={
                r ? (
                  <>
                    <span className={stoppedBlocked ? "warn" : undefined}>{stoppedBlocked} blocked</span> by limits · <span className={stoppedMissed ? "neg" : undefined}>{stoppedMissed} missed</span>
                  </>
                ) : undefined
              }
            />
          </KpiRow>
          <LatencyCard report={r} range={range} loading={loading} />
        </div>
      </div>
      <div className="grid-12">
        <SlippageCard report={r} loading={loading} />
        <MissedCard report={r} loading={loading} />
      </div>
    </>
  );
}
