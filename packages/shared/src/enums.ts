import { z } from "zod";

export const SIDES = ["long", "short"] as const;
export type Side = (typeof SIDES)[number];

export const ALERT_ACTIONS = [
  "buy",
  "sell",
  "long",
  "short",
  "close_long",
  "close_short",
  "close",
  "flat",
] as const;
export type AlertAction = (typeof ALERT_ACTIONS)[number];

/**
 * Alert lifecycle (single source of truth: `alert_events`).
 *
 *   received -> verified -> risk_checked -> (pending_approval ->) sent -> accepted -> filled | partially_filled
 *
 * Terminal failures: rejected_auth, duplicate, invalid, blocked, expired, failed.
 */
export const ALERT_STATUSES = [
  "received",
  "verified",
  "risk_checked",
  "pending_approval",
  "sent",
  "accepted",
  "partially_filled",
  "filled",
  "rejected_auth",
  "duplicate",
  "invalid",
  "blocked",
  "expired",
  "failed",
] as const;
export const AlertStatus = z.enum(ALERT_STATUSES);
export type AlertStatus = z.infer<typeof AlertStatus>;

/** Statuses after which nothing else will happen to the alert. `partially_filled` is terminal-ish (more fills may arrive). */
export const TERMINAL_STATUSES: readonly AlertStatus[] = [
  "filled",
  "partially_filled",
  "rejected_auth",
  "duplicate",
  "invalid",
  "blocked",
  "expired",
  "failed",
];
export const IN_FLIGHT_STATUSES: readonly AlertStatus[] = [
  "received",
  "verified",
  "risk_checked",
  "pending_approval",
  "sent",
  "accepted",
];
/** Statuses for alerts that were authentic, well-formed and not repeats: they "should have traded". */
export const VERIFIED_TERMINAL_STATUSES: readonly AlertStatus[] = [
  "filled",
  "partially_filled",
  "blocked",
  "expired",
  "failed",
];

export const BLOCK_REASONS = [
  "market_not_allowed",
  "size_above_max",
  "leverage_above_max",
  "daily_loss_stop_hit",
  "strategy_disabled",
  "trading_paused",
  "stale_alert",
  "rate_limited",
  "no_position_to_close",
  "perpl_not_connected",
  "approval_rejected",
  "approval_expired",
  "invalid_size",
] as const;
export const BlockReason = z.enum(BLOCK_REASONS);
export type BlockReason = z.infer<typeof BlockReason>;

export const BLOCK_REASON_LABELS: Record<BlockReason, string> = {
  market_not_allowed: "Market not in your allowed list",
  size_above_max: "Position would exceed your max size",
  leverage_above_max: "Leverage above your max",
  daily_loss_stop_hit: "Daily loss stop reached",
  strategy_disabled: "Strategy is disabled",
  trading_paused: "Trading is paused",
  stale_alert: "Alert arrived too late",
  rate_limited: "Too many orders per minute",
  no_position_to_close: "No open position to close",
  perpl_not_connected: "Perpl is not connected",
  approval_rejected: "You rejected the approval",
  approval_expired: "Approval timed out",
  invalid_size: "Order size could not be determined",
};

export const ORDER_STATUSES = ["pending", "sent", "accepted", "partially_filled", "filled", "failed", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** Direction of the trade itself (what happens on the book), as opposed to the position side it affects. */
export type TradeDirection = "buy" | "sell";

/** open long = buy, open short = sell, close long = sell, close short = buy. */
export function tradeDirection(side: Side, kind: "open" | "close"): TradeDirection {
  if (kind === "open") return side === "long" ? "buy" : "sell";
  return side === "long" ? "sell" : "buy";
}
