/**
 * Everything the alert detail view derives from an `AlertDetail` plus the current limits and account:
 * the timeline, the risk check list, the order frame, the Perpl status rows and the blocked narrative.
 * Pure functions, no React. The server stores events, orders and fills (not raw Perpl frames or per check results),
 * so checks are re-derived from the `risk_checked` / `blocked` event detail and the limits (DESIGN.md 10.4).
 */
import type { AccountSummary, AlertDetail, AlertEventDTO, BlockReason, NormalizedAlert, Order, RiskLimits } from "@hermes/shared";
import { Hand } from "lucide-react";
import type { CheckItem } from "../../components/ui";
import { formatLeverageX, formatUsd } from "../../lib/format";

export const PERPL_EXCHANGE = "0x1964c32f0be608e7d29302aff5e61268e72080cc";

export const parsedOf = (d: AlertDetail): Partial<NormalizedAlert> => (d.parsed ?? {}) as Partial<NormalizedAlert>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const first = (d: AlertDetail, status: string): AlertEventDTO | undefined => d.events.find((e) => e.status === status);

export const isFilled = (d: Pick<AlertDetail, "status">) => d.status === "filled" || d.status === "partially_filled";
/** Reached the order stage: an order exists and was written to the socket. */
export const wasSent = (d: AlertDetail) => d.events.some((e) => e.status === "sent");

/** Risk gate decided before any approval or order: blocked by a limit, or never past Verified. */
export type Variant = "trade" | "blocked" | "dropped";
export function variantOf(d: AlertDetail): Variant {
  if (d.status === "blocked") return "blocked";
  if (d.status === "duplicate" || d.status === "rejected_auth" || d.status === "invalid") return "dropped";
  return "trade";
}

// --- headline numbers ------------------------------------------------------------------

export function baseSize(d: AlertDetail): number | null {
  const filled = d.fills.reduce((a, f) => a + f.size, 0);
  if (filled > 0) return filled;
  const o = d.orders[0];
  if (o?.size) return o.size;
  const p = parsedOf(d);
  if (p.size) return p.size;
  if (d.sizeUsd && d.alertPrice) return d.sizeUsd / d.alertPrice;
  return null;
}

/** Requested or executed notional in USD. */
export function notionalOf(d: AlertDetail): number | null {
  const rc = first(d, "risk_checked");
  const fromEvent = num(rc?.detail?.notionalUsd);
  if (d.sizeUsd) return d.sizeUsd;
  if (fromEvent) return fromEvent;
  if (d.fills.length) return d.fills.reduce((a, f) => a + f.size * f.price, 0);
  return null;
}

/** USD difference between fill and alert price, positive when worse for the trader. */
export function slippageUsd(d: AlertDetail): number | null {
  if (d.alertPrice === null || d.avgFillPrice === null) return null;
  const size = d.fills.reduce((a, f) => a + f.size, 0);
  if (!(size > 0)) return null;
  const buy = (d.kind === "open" && d.side === "long") || (d.kind === "close" && d.side === "short");
  const diff = (d.avgFillPrice - d.alertPrice) * size;
  return buy ? diff : -diff;
}

/** TradingView ticker as it arrived (`BINANCE:BTCUSDT.P`), from the raw body. */
export function rawTicker(d: AlertDetail): string | null {
  try {
    const j = JSON.parse(d.rawBody) as Record<string, unknown>;
    return str(j.market) ?? str(j.ticker);
  } catch {
    return null;
  }
}

/** Raw payload with the secret masked, pretty printed. Falls back to the raw text. */
export function redactedPayload(raw: string): string {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if ("secret" in j) j.secret = "••••••••";
    return JSON.stringify(j, null, 2);
  } catch {
    return raw.replace(/("secret"\s*:\s*")[^"]*(")/gi, "$1••••••••$2");
  }
}

export function maxSlippageOf(d: AlertDetail, limits: RiskLimits | undefined): number | null {
  return parsedOf(d).maxSlippageBps ?? limits?.defaultSlippageBps ?? null;
}

export function orderTypeText(o: Order | undefined, d: AlertDetail): string {
  const kind = o?.kind ?? d.kind;
  const side = o?.side ?? d.side;
  const dir = kind === "close" ? (side ? `Close ${side}` : "Close") : side === "short" ? "Open short" : "Open long";
  const how = (o?.type ?? parsedOf(d).orderType ?? "market") === "limit" ? "good till cancelled" : "immediate or cancel";
  return `${dir}, ${how}`;
}

// --- risk checks -----------------------------------------------------------------------

export interface ChecksResult {
  items: CheckItem[];
  passed: number;
  failed: number;
  /** Name of the failing check, for the timeline text. */
  failedName: string | null;
  total: number;
}

const usd0 = (v: number | null) => formatUsd(v, { decimals: 0 });

/** Parses `Resulting SOL position 29458.00 USD exceeds the maximum 25000 USD.` */
function resultingPosition(detailText: string | null): number | null {
  const m = detailText ? /position ([\d.]+) USD/.exec(detailText) : null;
  return m ? Number(m[1]) : null;
}

const ORDER: BlockReason[] = ["strategy_disabled", "stale_alert", "rate_limited", "perpl_not_connected", "trading_paused", "market_not_allowed", "daily_loss_stop_hit", "invalid_size", "leverage_above_max", "size_above_max"];

export function riskChecks(d: AlertDetail, limits: RiskLimits | undefined, account: AccountSummary | undefined): ChecksResult {
  const reason = d.blockReason;
  const p = parsedOf(d);
  const market = d.market ?? "n/a";
  const isClose = d.kind === "close";
  const rc = first(d, "risk_checked");
  const needsApproval = rc?.detail?.needsApproval === true;
  const notional = notionalOf(d);
  const blockDetail = str(d.events.find((e) => e.status === "blocked")?.detail?.detail);
  const reachedRisk = d.events.some((e) => e.status === "risk_checked");
  const failIdx = reason && ORDER.includes(reason) ? ORDER.indexOf(reason) : -1;
  // A check after the failing one was never evaluated (the engine stops at the first failure).
  const notReached = (own: BlockReason): boolean => failIdx >= 0 && ORDER.indexOf(own) > failIdx;

  const items: CheckItem[] = [];
  const mk = (it: CheckItem) => items.push(it);

  const stateFor = (own: BlockReason): "pass" | "fail" | "skip" => (reason === own ? "fail" : notReached(own) ? "skip" : "pass");
  const skipText = "Not reached, an earlier check failed";
  const closeSkip = "Not applied to closing orders";

  // Failures that are not one of the six standard rows go first.
  if (reason === "stale_alert") mk({ name: "Alert age", detail: blockDetail ?? "The alert arrived too late", value: "Too old", state: "fail" });
  if (reason === "rate_limited") mk({ name: "Orders per minute", detail: blockDetail ?? "Too many orders", value: `${limits?.maxOrdersPerMinute ?? "n/a"} / min`, state: "fail" });
  if (reason === "perpl_not_connected") mk({ name: "Perpl connection", detail: "Perpl was not connected", value: "Offline", state: "fail" });
  if (reason === "trading_paused") mk({ name: "Trading", detail: "Trading is paused", value: "Paused", state: "fail" });
  if (reason === "no_position_to_close") mk({ name: "Open position to close", detail: blockDetail ?? `No open ${market} position`, value: "None", state: "fail" });
  if (reason === "invalid_size") mk({ name: "Order size", detail: "Size could not be worked out", value: "n/a", state: "fail" });

  // 1. Strategy enabled
  const sName = d.strategyName ?? "Strategy";
  mk({ name: "Strategy enabled", detail: sName, value: reason === "strategy_disabled" ? "Off" : "On", state: stateFor("strategy_disabled") === "skip" ? "pass" : stateFor("strategy_disabled") });

  // 2. Market allowed
  if (isClose) mk({ name: "Market allowed", detail: closeSkip, value: "n/a", state: "skip" });
  else {
    const st = stateFor("market_not_allowed");
    mk({
      name: "Market allowed",
      detail: st === "fail" ? `${market} is not in your allowed markets` : st === "skip" ? skipText : `${market} is on your list`,
      value: st === "skip" ? "n/a" : market,
      state: st,
    });
  }

  // 3. Max position size
  if (isClose) mk({ name: "Max position size", detail: closeSkip, value: "n/a", state: "skip" });
  else {
    const st = stateFor("size_above_max");
    const resulting = resultingPosition(blockDetail);
    mk({
      name: "Max position size",
      detail: st === "skip" ? skipText : st === "fail" ? "Position after this order" : "Order notional",
      value: st === "skip" ? "n/a" : `${usd0(st === "fail" ? (resulting ?? notional) : notional)} / ${usd0(limits?.maxPositionUsd ?? null)}`,
      state: st,
    });
  }

  // 4. Max leverage
  if (isClose) mk({ name: "Max leverage", detail: closeSkip, value: "n/a", state: "skip" });
  else {
    const st = stateFor("leverage_above_max");
    const lev = p.leverage ?? d.orders[0]?.leverage ?? null;
    mk({
      name: "Max leverage",
      detail: st === "skip" ? skipText : lev === null ? "Not set by the alert" : "Requested by the alert",
      value: st === "skip" ? "n/a" : `${lev === null ? "n/a" : formatLeverageX(lev, { decimals: 1 })} / ${limits ? formatLeverageX(limits.maxLeverage, { decimals: 0 }) : "n/a"}`,
      state: st,
    });
  }

  // 5. Daily loss stop
  if (isClose) mk({ name: "Daily loss stop", detail: closeSkip, value: "n/a", state: "skip" });
  else {
    const st = stateFor("daily_loss_stop_hit");
    const today = new Date(d.receivedAt).toDateString() === new Date().toDateString();
    const loss = account ? Math.max(0, -(account.realizedPnlTodayUsd + account.unrealizedPnlUsd)) : null;
    mk({
      name: "Daily loss stop",
      detail: st === "skip" ? skipText : "Loss so far today",
      value: st === "skip" ? "n/a" : `${today && loss !== null ? usd0(loss) : "n/a"} / ${usd0(limits?.dailyLossStopUsd ?? null)}`,
      state: st,
    });
  }

  // 6. Approval threshold
  const approvalRejected = reason === "approval_rejected";
  const approvalExpired = d.status === "expired" || reason === "approval_expired";
  if (isClose) mk({ name: "Approval threshold", detail: closeSkip, value: "n/a", state: "skip" });
  else if (approvalRejected || approvalExpired) {
    mk({ name: "Approval threshold", detail: approvalRejected ? "You rejected the order" : "Not approved in time", value: approvalRejected ? "Rejected" : "Expired", state: "fail" });
  } else if (!reachedRisk) {
    mk({ name: "Approval threshold", detail: "Not reached, order already blocked", value: "n/a", state: "skip" });
  } else {
    mk({
      name: "Approval threshold",
      detail: needsApproval ? "Above the threshold, waited for you" : "Order notional",
      value: `${usd0(notional)} / ${usd0(limits?.approvalThresholdUsd ?? null)}`,
      state: "pass",
      ...(needsApproval ? { icon: Hand } : {}),
    });
  }

  // Failed first, then the rest in engine order.
  const ordered = [...items.filter((i) => i.state === "fail"), ...items.filter((i) => i.state !== "fail")];
  const failed = ordered.filter((i) => i.state === "fail");
  return {
    items: ordered,
    passed: ordered.filter((i) => i.state === "pass").length,
    failed: failed.length,
    failedName: failed.length ? String(failed[0]?.name) : null,
    total: ordered.length,
  };
}
