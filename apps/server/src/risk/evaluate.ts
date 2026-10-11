import { isMarketSymbol, type BlockReason, type RiskLimits, type Side } from "@hermes/shared";

export interface RiskIntent {
  /** Base symbol, e.g. "BTC". */
  market: string;
  kind: "open" | "close";
  /** Position side acted on; null = generic close. */
  side: Side | null;
  /** Requested notional in USD for opens; null if it could not be determined. Ignored for closes. */
  notionalUsd: number | null;
  /** Effective leverage the order will use, if known. */
  leverage?: number | undefined;
}

export interface PositionState {
  side: Side;
  size: number;
  notionalUsd: number;
}

export interface RiskState {
  /** Strategy still enabled when the check runs (it can be toggled after the alert was accepted). */
  strategyEnabled: boolean;
  /** Current position per market symbol (one net position per market). */
  positions: Record<string, PositionState | undefined>;
  /** Realised PnL since 00:00 UTC, USD (negative = loss). */
  realizedPnlTodayUsd: number;
  /** Total open notional across markets, USD. */
  openNotionalUsd: number;
  /** Orders submitted by this user in the last 60 s. */
  ordersLastMinute: number;
  perplConnected: boolean;
  /** Seconds between the alert's own timestamp (or receipt) and now. */
  alertAgeSec: number;
}

export type RiskResult =
  | { ok: true; needsApproval: boolean }
  | { ok: false; reason: BlockReason; detail: string };

const block = (reason: BlockReason, detail: string): RiskResult => ({ ok: false, reason, detail });

/**
 * Pure risk gate. Checks run in this order and the first failure wins:
 *
 *  1. strategy_disabled       (any)
 *  2. stale_alert             (any)
 *  3. rate_limited            (any)
 *  4. perpl_not_connected     (any)
 *  Closes (reduce-only) then stop at: no_position_to_close, otherwise ok. They ignore pause, market list,
 *  size, leverage and the daily loss stop on purpose: limits must never trap you inside a position.
 *  Opens continue:
 *  5. trading_paused
 *  6. market_not_allowed      (not in allowedMarkets or not a Perpl market)
 *  7. daily_loss_stop_hit     (realised PnL today <= -dailyLossStopUsd; 0 disables)
 *  8. invalid_size            (notional unknown / not > 0)
 *  9. leverage_above_max
 * 10. size_above_max          (existing same-side position + new notional > maxPositionUsd)
 *
 * `needsApproval` is true when the order notional >= approvalThresholdUsd (0 disables approvals).
 */
export function evaluate(intent: RiskIntent, limits: RiskLimits, state: RiskState): RiskResult {
  if (!state.strategyEnabled) return block("strategy_disabled", "The strategy is disabled.");

  if (state.alertAgeSec > limits.maxAlertAgeSec) {
    return block(
      "stale_alert",
      `Alert is ${state.alertAgeSec.toFixed(1)}s old; the maximum is ${limits.maxAlertAgeSec}s.`,
    );
  }

  if (state.ordersLastMinute >= limits.maxOrdersPerMinute) {
    return block(
      "rate_limited",
      `${state.ordersLastMinute} orders in the last minute; the maximum is ${limits.maxOrdersPerMinute}.`,
    );
  }

  if (!state.perplConnected) return block("perpl_not_connected", "Perpl is not connected.");

  const market = intent.market.toUpperCase();

  if (intent.kind === "close") {
    const pos = state.positions[market];
    if (!pos || !(pos.size > 0)) return block("no_position_to_close", `No open ${market} position.`);
    if (intent.side && pos.side !== intent.side) {
      return block("no_position_to_close", `Open ${market} position is ${pos.side}, not ${intent.side}.`);
    }
    return { ok: true, needsApproval: false };
  }

  if (limits.paused) return block("trading_paused", "Trading is paused.");

  const allowed = limits.allowedMarkets.map((m) => m.toUpperCase());
  if (!isMarketSymbol(market) || !allowed.includes(market)) {
    return block("market_not_allowed", `${market} is not in your allowed markets (${allowed.join(", ") || "none"}).`);
  }

  if (limits.dailyLossStopUsd > 0 && state.realizedPnlTodayUsd <= -limits.dailyLossStopUsd) {
    return block(
      "daily_loss_stop_hit",
      `Realised PnL today is ${state.realizedPnlTodayUsd.toFixed(2)} USD; the stop is -${limits.dailyLossStopUsd}.`,
    );
  }

  const notional = intent.notionalUsd;
  if (notional === null || !Number.isFinite(notional) || notional <= 0) {
    return block("invalid_size", "Order size could not be determined or is not positive.");
  }

  if (intent.leverage !== undefined && intent.leverage > limits.maxLeverage) {
    return block("leverage_above_max", `Leverage ${intent.leverage}x exceeds the maximum ${limits.maxLeverage}x.`);
  }

  const existing = state.positions[market];
  const sameSide = existing && intent.side !== null && existing.side === intent.side ? existing.notionalUsd : 0;
  const resulting = sameSide + notional;
  if (resulting > limits.maxPositionUsd) {
    return block(
      "size_above_max",
      `Resulting ${market} position ${resulting.toFixed(2)} USD exceeds the maximum ${limits.maxPositionUsd} USD.`,
    );
  }

  const needsApproval = limits.approvalThresholdUsd > 0 && notional >= limits.approvalThresholdUsd;
  return { ok: true, needsApproval };
}
