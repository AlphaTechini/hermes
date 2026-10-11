import { z } from "zod";
import { MARKET_SYMBOLS } from "./markets";

/**
 * Per-user hard limits enforced before any order leaves Hermes.
 * `approvalThresholdUsd`: orders with notional >= this wait for human approval; 0 disables approvals.
 * `paused` blocks new positions; reduce-only closes are still allowed (a kill switch must never trap you in a trade).
 */
export const RiskLimits = z.object({
  allowedMarkets: z.array(z.string().min(1)).default([...MARKET_SYMBOLS]),
  maxPositionUsd: z.number().positive().default(5000),
  maxLeverage: z.number().positive().default(10),
  dailyLossStopUsd: z.number().nonnegative().default(500),
  approvalThresholdUsd: z.number().nonnegative().default(2500),
  maxAlertAgeSec: z.number().positive().default(60),
  maxOrdersPerMinute: z.number().int().positive().default(30),
  defaultSlippageBps: z.number().int().nonnegative().default(50),
  paused: z.boolean().default(false),
  /** Seconds an order above the approval threshold waits in the approvals queue before it expires. */
  approvalExpirySec: z.number().int().min(10).max(86_400).default(120),
  /** Epoch ms of the last save, set by the server (ignored on PUT). null/absent before the first save. */
  updatedAt: z.number().nullable().optional(),
});
export type RiskLimits = z.infer<typeof RiskLimits>;

export const DEFAULT_RISK_LIMITS: RiskLimits = RiskLimits.parse({});
