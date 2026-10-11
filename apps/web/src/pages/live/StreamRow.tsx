import { ChevronRight } from "lucide-react";
import { memo, type MouseEvent } from "react";
import { Link } from "react-router-dom";
import type { AlertRecord } from "@hermes/shared";
import { alertOutcome, alertPipeline, alertSide, formatTotal } from "../../lib/alert-view";
import { cn } from "../../lib/cn";
import { SLIPPAGE_BETTER_TITLE, formatBps, formatClock, formatPrice, formatSize, formatUsd, slippageTone } from "../../lib/format";
import { LifecyclePipeline, MarketChip, SideLabel, StatusPill } from "../../components/ui";

export interface RowSize {
  /** Base units, when known (fill size, or notional / alert price). */
  base: number | null;
  usd: number | null;
}

interface Props {
  alert: AlertRecord;
  size: RowSize;
  /**
   * For an ignored duplicate: the alert it repeated (when it is in the loaded list). The row then shows that alert's side,
   * market, size and price instead of empty fields.
   */
  original?: AlertRecord | undefined;
  /** Size of `original`. */
  originalSize?: RowSize | undefined;
  /** Relative time text (`12s ago`), computed by the parent so the row only re-renders when it changes. */
  relative: string;
  /** `1:42` while the alert waits for approval. */
  approvalLeft: string | null;
  /** True for rows that arrived after the page loaded: slides in with the accent wash. */
  fresh: boolean;
  onOpen: (id: string) => void;
}

/** One alert in the stream. The pipeline is driven by the alert's server events, so stages light up as `alert` events land. */
export const StreamRow = memo(function StreamRow({ alert, size, original, originalSize, relative, approvalLeft, fresh, onOpen }: Props) {
  const { stages, totalMs } = alertPipeline(alert);
  const out = alertOutcome(alert);
  const t0 = alert.events[0]?.atMs ?? alert.receivedAt;
  const why = out.kind === "needs_approval" && approvalLeft ? `${approvalLeft} left to approve` : out.why;
  const mono = out.mono;
  // Alerts that stopped before the risk gate carry no parsed fields. Say so once, in words, instead of stacking n/a.
  const shown = alert.status === "duplicate" && original ? original : alert;
  const shownSize = shown === original && originalSize ? originalSize : size;
  const unparsed = shown.market === null && shown.side === null && shown.kind === null;
  const unparsedLabel = alert.status === "duplicate" ? "Duplicate delivery" : alert.status === "invalid" ? "Invalid message" : alert.status === "rejected_auth" ? "Unverified message" : "Alert";
  const wholePosition = shown.kind === "close" && shownSize.base === null && shownSize.usd === null;
  const improved = (out.kind === "filled" || out.kind === "partly_filled") && alert.avgFillPrice !== null && alert.slippageBps !== null && slippageTone(alert.slippageBps) === "better";

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
          {unparsed ? <span className="muted">{unparsedLabel}</span> : <SideLabel side={alertSide(shown)} />}
          {shown.market && <MarketChip market={shown.market} />}
        </span>
        <span className="b">
          {wholePosition ? (
            <span className="muted" style={{ fontFamily: "var(--font-ui)" }}>Whole position</span>
          ) : shownSize.base !== null && shownSize.usd !== null ? (
            <>
              {formatSize(shownSize.base, shown.market)} <span className="faint">·</span> {formatUsd(shownSize.usd, { decimals: 0 })}
            </>
          ) : shownSize.usd !== null ? (
            formatUsd(shownSize.usd, { decimals: 0 })
          ) : shownSize.base !== null ? (
            formatSize(shownSize.base, shown.market)
          ) : null}
        </span>
      </span>
      <span className="strat">
        <span className="a">{alert.strategyName ?? "n/a"}</span>
        <span className="b">{shown.alertPrice !== null ? `Alert ${formatPrice(shown.alertPrice, shown.market)}` : ""}</span>
      </span>
      <LifecyclePipeline stages={stages} />
      <span className={cn("total", totalMs === null && "dim")}>{formatTotal(totalMs)}</span>
      <span className="status">
        <StatusPill kind={out.kind} />
        <span className={cn("why", mono && "mono")}>
          {improved ? (
            <>
              {formatPrice(alert.avgFillPrice, alert.market)} · <span className="pos" title={SLIPPAGE_BETTER_TITLE(alert.slippageBps!)}>{formatBps(alert.slippageBps)}</span>
            </>
          ) : (
            why
          )}
        </span>
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
