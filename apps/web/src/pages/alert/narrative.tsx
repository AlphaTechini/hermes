import type { ReactNode } from "react";
import type { AlertDetail, BlockReason, RiskLimits } from "@hermes/shared";
import { formatCountdown, formatLeverageX, formatUsd } from "../../lib/format";
import { parsedOf, notionalOf, type ChecksResult } from "./derive";

const M = ({ children }: { children: ReactNode }) => <span className="mono fg">{children}</span>;
const usd0 = (v: number | null | undefined) => formatUsd(v ?? null, { decimals: 0 });

export interface Narrative {
  tone: "warning" | "negative" | "neutral";
  body: ReactNode;
  /** The limit a blocked alert ran into, for the "Review limit" link. */
  limit: boolean;
}

/** The sentence at the top of a blocked, failed or ignored alert: what happened, what the limit was, what to do. */
export function narrativeFor(d: AlertDetail, limits: RiskLimits | undefined, checks: ChecksResult): Narrative | null {
  const market = d.market ?? "this market";
  const p = parsedOf(d);
  const reason: BlockReason | null = d.blockReason;
  const blockDetail = d.events.find((e) => e.status === "blocked")?.detail?.detail;
  const resulting = typeof blockDetail === "string" ? Number(/position ([\d.]+) USD/.exec(blockDetail)?.[1]) : NaN;
  const nothing = "Nothing was sent to Perpl.";

  if (d.status === "blocked" && reason) {
    switch (reason) {
      case "size_above_max":
        return {
          tone: "warning",
          limit: true,
          body: (
            <>
              <b>Blocked by your max position size.</b> This order would have taken your {market} position to <M>{usd0(Number.isFinite(resulting) ? resulting : notionalOf(d))}</M>. Your limit is <M>{usd0(limits?.maxPositionUsd)}</M> per market. {nothing} To allow orders like this, raise the limit or lower <span className="mono">size</span> in the TradingView message.
            </>
          ),
        };
      case "market_not_allowed":
        return {
          tone: "warning",
          limit: true,
          body: (
            <>
              <b>{market} is not an allowed market.</b> Your allowed markets are {(limits?.allowedMarkets ?? []).join(", ") || "none"}. {nothing} Add {market} in Risk limits to trade it from this strategy.
            </>
          ),
        };
      case "leverage_above_max":
        return {
          tone: "warning",
          limit: true,
          body: (
            <>
              <b>Blocked by your max leverage.</b> The alert asked for <M>{formatLeverageX(p.leverage ?? null)}</M>. Your limit is <M>{formatLeverageX(limits?.maxLeverage ?? null, { decimals: 0 })}</M>. {nothing} Alerts above the limit are blocked, not reduced. Lower <span className="mono">leverage</span> in the TradingView message or raise the limit.
            </>
          ),
        };
      case "daily_loss_stop_hit":
        return {
          tone: "warning",
          limit: true,
          body: (
            <>
              <b>Blocked by your daily loss stop.</b> Today's loss reached your stop of <M>{usd0(limits?.dailyLossStopUsd)}</M>. {nothing} New orders are blocked until 00:00 UTC. Orders that close a position still go through.
            </>
          ),
        };
      case "strategy_disabled":
        return { tone: "warning", limit: false, body: (<><b>The strategy was off.</b> {nothing} Turn it on in Strategies to trade its alerts.</>) };
      case "trading_paused":
        return { tone: "warning", limit: false, body: (<><b>Trading was paused.</b> Alerts are logged and blocked while paused. {nothing} Resume trading from the top bar.</>) };
      case "stale_alert":
        return { tone: "warning", limit: true, body: (<><b>The alert arrived too late.</b> It was older than <M>{limits?.maxAlertAgeSec ?? "n/a"} s</M> when Hermes checked it. {nothing}</>) };
      case "rate_limited":
        return { tone: "warning", limit: true, body: (<><b>Too many orders in a minute.</b> Your limit is <M>{limits?.maxOrdersPerMinute ?? "n/a"}</M> per minute. {nothing}</>) };
      case "no_position_to_close":
        return { tone: "warning", limit: false, body: (<><b>There was no open {market} position to close.</b> {nothing}</>) };
      case "perpl_not_connected":
        return { tone: "warning", limit: false, body: (<><b>Perpl was not connected.</b> {nothing} Check the connection in Wallet and keys.</>) };
      case "invalid_size":
        return { tone: "warning", limit: false, body: (<><b>Hermes could not work out the order size.</b> Send <span className="mono">size</span> or <span className="mono">size_usd</span> in the TradingView message. {nothing}</>) };
      case "approval_rejected":
        return { tone: "warning", limit: false, body: (<><b>You rejected this order.</b> {nothing}</>) };
      case "approval_expired":
        return { tone: "warning", limit: false, body: (<><b>The approval expired.</b> {nothing}</>) };
    }
  }
  if (d.status === "expired") {
    const waited = d.approval ? Math.round((d.approval.expiresAt - d.approval.createdAt) / 1000) : null;
    return { tone: "neutral", limit: false, body: (<><b>Not approved{waited ? ` in ${formatCountdown(waited)}` : " in time"}.</b> The order expired. {nothing} Raise the approval threshold if you do not want to confirm orders this size.</>) };
  }
  if (d.status === "duplicate") {
    const of = d.events.find((e) => e.status === "duplicate")?.detail?.duplicateOf;
    return { tone: "neutral", limit: false, body: (<><b>Ignored as a duplicate.</b> It has the same alert id as <span className="mono">{String(of ?? "an earlier alert")}</span>, so Hermes did not act on it twice. {nothing}</>) };
  }
  if (d.status === "rejected_auth") return { tone: "negative", limit: false, body: (<><b>Hermes ignored this alert.</b> The secret did not match this strategy. Copy the message from Strategies into your TradingView alert again.</>) };
  if (d.status === "invalid") return { tone: "negative", limit: false, body: (<><b>The message was not valid.</b> Fix the fields listed in the timeline and send it again. {nothing}</>) };
  if (d.status === "failed") {
    const msg = d.events.find((e) => e.status === "failed")?.detail?.message;
    return { tone: "negative", limit: false, body: (<><b>The order did not fill.</b> {typeof msg === "string" ? msg : "Perpl did not fill the order."} It passed all {checks.total} checks, so your limits were not the cause.</>) };
  }
  return null;
}
