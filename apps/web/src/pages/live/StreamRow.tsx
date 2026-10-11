import { ChevronRight } from "lucide-react";
import { memo, type MouseEvent } from "react";
import { Link } from "react-router-dom";
import type { AlertRecord } from "@hermes/shared";
import { alertOutcome, alertPipeline, alertSide, formatTotal } from "../../lib/alert-view";
import { cn } from "../../lib/cn";
import { formatClock, formatPrice, formatSize, formatUsd, orNA } from "../../lib/format";
import { LifecyclePipeline, MarketChip, SideLabel, StatusPill } from "../../components/ui";

export interface RowSize {
  /** Base units, when known (fill size, or notional / alert price). */
  base: number | null;
  usd: number | null;
}

interface Props {
  alert: AlertRecord;
  size: RowSize;
  /** Relative time text (`12s ago`), computed by the parent so the row only re-renders when it changes. */
  relative: string;
  /** `1:42` while the alert waits for approval. */
  approvalLeft: string | null;
  /** True for rows that arrived after the page loaded: slides in with the accent wash. */
  fresh: boolean;
  onOpen: (id: string) => void;
}

/** One alert in the stream. The pipeline is driven by the alert's server events, so stages light up as `alert` events land. */
export const StreamRow = memo(function StreamRow({ alert, size, relative, approvalLeft, fresh, onOpen }: Props) {
  const { stages, totalMs } = alertPipeline(alert);
  const out = alertOutcome(alert);
  const t0 = alert.events[0]?.atMs ?? alert.receivedAt;
  const why = out.kind === "needs_approval" && approvalLeft ? `${approvalLeft} left to approve` : out.why;
  const mono = out.mono;

  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOpen(alert.id);
  };

  return (
    <Link to={`/alerts/${alert.id}`} onClick={click} className={cn("stream-row", fresh && "hm-row-in")} aria-label={`Alert ${alert.id}`} data-alert-id={alert.id}>
      <span className="time">
        <span className="a">{formatClock(t0)}</span>
        <span className="r">{relative}</span>
      </span>
      <span className="sig">
        <span className="a">
          {alert.kind === null && alert.side === null ? <span className="muted">Alert</span> : <SideLabel side={alertSide(alert)} />}
          {alert.market ? <MarketChip market={alert.market} /> : <span className="faint">n/a</span>}
        </span>
        <span className="b">
          {orNA(size.base, (v) => formatSize(v, alert.market))} <span className="faint">·</span> {orNA(size.usd, (v) => formatUsd(v, { decimals: 0 }))}
        </span>
      </span>
      <span className="strat">
        <span className="a">{alert.strategyName ?? "n/a"}</span>
        <span className="b">Alert {formatPrice(alert.alertPrice, alert.market)}</span>
      </span>
      <LifecyclePipeline stages={stages} />
      <span className={cn("total", totalMs === null && "dim")}>{formatTotal(totalMs)}</span>
      <span className="status">
        <StatusPill kind={out.kind} />
        <span className={cn("why", mono && "mono")}>{why}</span>
      </span>
      <ChevronRight className="chev" aria-hidden />
      <span className="mob">
        <span className="mono">{formatClock(t0, { ms: false })}</span>
        <span className="truncate">{alert.strategyName ?? "n/a"}</span>
        <span className="mono">{totalMs !== null ? formatTotal(totalMs) : ""}</span>
      </span>
    </Link>
  );
});
