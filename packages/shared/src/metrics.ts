import type { Side, TradeDirection } from "./enums";
import { tradeDirection } from "./enums";

/**
 * Slippage in basis points, signed so that POSITIVE = WORSE for the trader.
 * Buys (open long / close short): (fill - alert) / alert * 1e4.
 * Sells (open short / close long): the inverse, (alert - fill) / alert * 1e4.
 */
export function slippageBps(alertPrice: number, fillPrice: number, direction: TradeDirection): number {
  if (!(alertPrice > 0) || !Number.isFinite(fillPrice)) return NaN;
  const raw = ((fillPrice - alertPrice) / alertPrice) * 1e4;
  return direction === "buy" ? raw : -raw;
}

export function slippageBpsFor(alertPrice: number, fillPrice: number, side: Side, kind: "open" | "close"): number {
  return slippageBps(alertPrice, fillPrice, tradeDirection(side, kind));
}
