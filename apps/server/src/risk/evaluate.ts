import { isMarketSymbol, type BlockReason, type RiskCheckResult, type RiskLimits, type Side } from "@hermes/shared";

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
  /**
   * Current unrealised PnL of the open positions, USD (negative = loss). The daily loss stop is evaluated against
   * realised + unrealised, which is the "Today PnL" the top bar shows. Defaults to 0.
   */
  unrealizedPnlUsd?: number | undefined;
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

/** A {@link RiskResult} plus the outcome of every rule, in evaluation order. */
export type DetailedRiskResult = RiskResult & { checks: RiskCheckResult[] };

const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;

interface Outcome {
  passed: boolean;
  value: number | string | boolean | null;
  limit: number | string | boolean | null;
  unit: string | null;
  detail: string;
  reason?: BlockReason;
}
interface Rule {
  key: string;
  label: string;
  /** Rules marked open-only are skipped for closing (reduce-only) orders. */
  openOnly: boolean;
  /** Rules marked close-only are left out of the list for opening orders. */
  closeOnly?: boolean;
  run(): Outcome;
}

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
 *  7. daily_loss_stop_hit     (realised + unrealised PnL today <= -dailyLossStopUsd; 0 disables)
 *  8. invalid_size            (notional unknown / not > 0)
 *  9. leverage_above_max
 * 10. size_above_max          (existing same-side position + new notional > maxPositionUsd)
 *
 * `needsApproval` is true when the order notional >= approvalThresholdUsd (0 disables approvals).
 *
 * `evaluateDetailed` also returns the outcome of every rule (`checks`): the failing one, everything evaluated before
 * it, and the rest marked `skipped`. `evaluate` is the same gate without the list.
 */
export function evaluateDetailed(intent: RiskIntent, limits: RiskLimits, state: RiskState): DetailedRiskResult {
  const market = intent.market.toUpperCase();
  const isClose = intent.kind === "close";
  const notional = intent.notionalUsd;
  const allowed = limits.allowedMarkets.map((m) => m.toUpperCase());
  const unrealized = state.unrealizedPnlUsd ?? 0;
  const todayPnl = state.realizedPnlTodayUsd + unrealized;
  const existing = state.positions[market];

  const rules: Rule[] = [
    {
      key: "strategy_enabled",
      label: "Strategy enabled",
      openOnly: false,
      run: () => ({
        passed: state.strategyEnabled,
        value: state.strategyEnabled ? "On" : "Off",
        limit: "On",
        unit: null,
        detail: "The strategy is disabled.",
        reason: "strategy_disabled",
      }),
    },
    {
      key: "alert_age",
      label: "Alert age",
      openOnly: false,
      run: () => ({
        passed: !(state.alertAgeSec > limits.maxAlertAgeSec),
        value: Math.round(state.alertAgeSec * 10) / 10,
        limit: limits.maxAlertAgeSec,
        unit: "s",
        detail: `Alert is ${state.alertAgeSec.toFixed(1)}s old; the maximum is ${limits.maxAlertAgeSec}s.`,
        reason: "stale_alert",
      }),
    },
    {
      key: "rate_limit",
      label: "Orders per minute",
      openOnly: false,
      run: () => ({
        passed: !(state.ordersLastMinute >= limits.maxOrdersPerMinute),
        value: state.ordersLastMinute,
        limit: limits.maxOrdersPerMinute,
        unit: "orders/min",
        detail: `${state.ordersLastMinute} orders in the last minute; the maximum is ${limits.maxOrdersPerMinute}.`,
        reason: "rate_limited",
      }),
    },
    {
      key: "perpl_connected",
      label: "Perpl connected",
      openOnly: false,
      run: () => ({
        passed: state.perplConnected,
        value: state.perplConnected ? "Connected" : "Not connected",
        limit: "Connected",
        unit: null,
        detail: "Perpl is not connected.",
        reason: "perpl_not_connected",
      }),
    },
    {
      key: "position_to_close",
      label: "Open position to close",
      openOnly: false,
      closeOnly: true,
      run: () => {
        if (!existing || !(existing.size > 0)) {
          return { passed: false, value: "None", limit: intent.side ?? "any side", unit: null, detail: `No open ${market} position.`, reason: "no_position_to_close" };
        }
        const wrongSide = intent.side !== null && existing.side !== intent.side;
        return {
          passed: !wrongSide,
          value: `${existing.side} ${existing.size}`,
          limit: intent.side ?? "any side",
          unit: null,
          detail: `Open ${market} position is ${existing.side}, not ${intent.side}.`,
          reason: "no_position_to_close",
        };
      },
    },
    {
      key: "pause",
      label: "Trading not paused",
      openOnly: true,
      run: () => ({
        passed: !limits.paused,
        value: limits.paused ? "Paused" : "Running",
        limit: "Running",
        unit: null,
        detail: "Trading is paused.",
        reason: "trading_paused",
      }),
    },
    {
      key: "markets",
      label: "Market allowed",
      openOnly: true,
      run: () => ({
        passed: isMarketSymbol(market) && allowed.includes(market),
        value: market,
        limit: allowed.join(", ") || "none",
        unit: null,
        detail: `${market} is not in your allowed markets (${allowed.join(", ") || "none"}).`,
        reason: "market_not_allowed",
      }),
    },
    {
      key: "daily_loss",
      label: "Daily loss stop",
      openOnly: true,
      run: () => ({
        passed: !(limits.dailyLossStopUsd > 0 && todayPnl <= -limits.dailyLossStopUsd),
        // loss used so far today (realised + unrealised), against the stop
        value: Math.round(Math.max(0, -todayPnl) * 100) / 100,
        limit: limits.dailyLossStopUsd > 0 ? limits.dailyLossStopUsd : null,
        unit: "USD",
        detail: `PnL today is ${usd(todayPnl)} (realised ${usd(state.realizedPnlTodayUsd)}, unrealised ${usd(unrealized)}); the stop is -$${limits.dailyLossStopUsd}.`,
        reason: "daily_loss_stop_hit",
      }),
    },
    {
      key: "size_known",
      label: "Order size known",
      openOnly: true,
      run: () => ({
        passed: !(notional === null || !Number.isFinite(notional) || notional <= 0),
        value: notional !== null && Number.isFinite(notional) ? Math.round(notional * 100) / 100 : null,
        limit: null,
        unit: "USD",
        detail: "Order size could not be determined or is not positive.",
        reason: "invalid_size",
      }),
    },
    {
      key: "leverage",
      label: "Max leverage",
      openOnly: true,
      run: () => ({
        passed: !(intent.leverage !== undefined && intent.leverage > limits.maxLeverage),
        value: intent.leverage ?? null,
        limit: limits.maxLeverage,
        unit: "x",
        detail: `Leverage ${intent.leverage}x exceeds the maximum ${limits.maxLeverage}x.`,
        reason: "leverage_above_max",
      }),
    },
    {
      key: "size",
      label: "Max position size",
      openOnly: true,
      run: () => {
        const sameSide = existing && intent.side !== null && existing.side === intent.side ? existing.notionalUsd : 0;
        const resulting = sameSide + (notional ?? 0);
        return {
          passed: !(resulting > limits.maxPositionUsd),
          value: Math.round(resulting * 100) / 100,
          limit: limits.maxPositionUsd,
          unit: "USD",
          detail: `Resulting ${market} position ${resulting.toFixed(2)} USD exceeds the maximum ${limits.maxPositionUsd} USD.`,
          reason: "size_above_max",
        };
      },
    },
    {
      key: "approval",
      label: "Approval threshold",
      openOnly: true,
      run: () => {
        const needs = limits.approvalThresholdUsd > 0 && (notional ?? 0) >= limits.approvalThresholdUsd;
        return {
          passed: true, // informational: crossing it sends the order to the approvals queue, it never blocks
          value: notional !== null && Number.isFinite(notional) ? Math.round(notional * 100) / 100 : null,
          limit: limits.approvalThresholdUsd > 0 ? limits.approvalThresholdUsd : null,
          unit: "USD",
          detail: needs ? "Above the approval threshold: waits for your approval." : "Under the approval threshold: sent without waiting.",
        };
      },
    },
  ];

  const checks: RiskCheckResult[] = [];
  let failure: Extract<RiskResult, { ok: false }> | undefined;
  let needsApproval = false;
  for (const rule of rules) {
    if (rule.closeOnly && !isClose) continue;
    const base = { key: rule.key, label: rule.label };
    if (failure) {
      checks.push({ ...base, passed: null, skipped: true, value: null, limit: null, unit: null, detail: "Not evaluated because an earlier check failed." });
      continue;
    }
    if (isClose && rule.openOnly) {
      checks.push({ ...base, passed: null, skipped: true, value: null, limit: null, unit: null, detail: "Closing orders ignore this limit." });
      continue;
    }
    const o = rule.run();
    if (rule.key === "approval") needsApproval = o.detail.startsWith("Above");
    checks.push({
      ...base,
      passed: o.passed,
      skipped: false,
      value: o.value,
      limit: o.limit,
      unit: o.unit,
      detail: o.passed ? (rule.key === "approval" ? o.detail : "Passed.") : o.detail,
    });
    if (!o.passed && o.reason) failure = { ok: false, reason: o.reason, detail: o.detail };
  }
  return failure ? { ...failure, checks } : { ok: true, needsApproval, checks };
}

export function evaluate(intent: RiskIntent, limits: RiskLimits, state: RiskState): RiskResult {
  const { checks: _checks, ...result } = evaluateDetailed(intent, limits, state);
  return result;
}
