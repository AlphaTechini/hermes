/**
 * API DTOs. Conventions:
 *  - Every timestamp is epoch milliseconds (number). Event timestamps (`atMs`) carry sub-ms precision.
 *  - Money is USD (collateral token is treated as 1 USD), prices/sizes are plain numbers.
 *  - Errors always look like {@link ApiErrorBody}.
 */
import { z } from "zod";
import type { AlertIssue } from "./alert";
import type { WalletActionDTO } from "./wallet";
import {
  ALERT_ACTIONS,
  type AlertStatus,
  type ApprovalStatus,
  type BlockReason,
  type OrderStatus,
  type Side,
} from "./enums";
import type { RiskLimits } from "./risk";

export interface ApiErrorBody {
  error: { code: string; message: string; issues?: AlertIssue[] };
}

// --- session -----------------------------------------------------------------

export interface UserDTO {
  id: string;
  privyDid: string;
  email: string | null;
  walletAddress: string | null;
  createdAt: number;
  authMode: "privy" | "dev";
  perplMode: "sim" | "live";
}

export const RegisterWalletRequest = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address"),
  email: z.string().email().optional(),
});
export type RegisterWalletRequest = z.infer<typeof RegisterWalletRequest>;

// --- strategies --------------------------------------------------------------

export interface TradingViewTemplates {
  /** For indicator/plain alerts: edit `action` (buy|sell|close). Secret shown as a placeholder unless revealed. */
  indicator: string;
  /** For strategy() alerts using order placeholders. */
  strategy: string;
}

export interface StrategyDTO {
  id: string;
  name: string;
  enabled: boolean;
  defaultMarket: string | null;
  defaultSizeUsd: number | null;
  defaultLeverage: number | null;
  createdAt: number;
  webhookUrl: string;
  /** Templates contain the literal `YOUR_SECRET` placeholder; use the reveal endpoint for filled-in ones. */
  templates: TradingViewTemplates;
  alertCount: number;
  lastAlertAt: number | null;
}

/** Returned by create, rotate-secret and reveal. The only places the plaintext secret is exposed. */
export interface StrategySecretDTO extends StrategyDTO {
  secret: string;
  /** Templates with the real secret filled in. */
  templatesWithSecret: TradingViewTemplates;
}

export const CreateStrategyRequest = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().optional(),
  defaultMarket: z.string().trim().min(1).max(32).nullable().optional(),
  defaultSizeUsd: z.number().positive().nullable().optional(),
  defaultLeverage: z.number().positive().nullable().optional(),
});
export type CreateStrategyRequest = z.infer<typeof CreateStrategyRequest>;

export const UpdateStrategyRequest = CreateStrategyRequest.partial();
export type UpdateStrategyRequest = z.infer<typeof UpdateStrategyRequest>;

export const TestAlertRequest = z.object({
  action: z.enum(ALERT_ACTIONS).optional(),
  market: z.string().trim().min(1).max(32).optional(),
  sizeUsd: z.number().positive().optional(),
  price: z.number().positive().optional(),
  marketPosition: z.enum(["long", "short", "flat"]).optional(),
});
export type TestAlertRequest = z.infer<typeof TestAlertRequest>;

/** Response of `POST /hooks/:id` (202, or 200 with `duplicate: true`) and of test-alert. */
export interface IngestResponse {
  alertId: string;
  duplicate?: boolean;
  /** Present on test-alert: the exact text that was posted. */
  body?: string;
}

// --- alerts ------------------------------------------------------------------

export interface AlertEventDTO {
  id: number;
  alertId: string;
  status: AlertStatus;
  /** High-resolution epoch ms, 3 decimals (performance.timeOrigin + performance.now()). */
  atMs: number;
  detail: Record<string, unknown> | null;
}

export interface AlertRecord {
  id: string;
  strategyId: string;
  strategyName: string | null;
  idempotencyKey: string | null;
  status: AlertStatus;
  blockReason: BlockReason | null;
  /** Failure code for `failed` alerts (e.g. perpl_not_connected, order_rejected). */
  errorCode: string | null;
  market: string | null;
  /** Position side the alert acts on; null for a generic "close". */
  side: Side | null;
  kind: "open" | "close" | null;
  /** Requested notional. */
  sizeUsd: number | null;
  /** Chart price from the alert, for slippage. */
  alertPrice: number | null;
  receivedAt: number;
  createdAt: number;
  events: AlertEventDTO[];
  /** received -> first fill, ms. null until filled. */
  latencyMs: number | null;
  /** Volume-weighted average fill price. */
  avgFillPrice: number | null;
  /** Signed bps vs alert price; positive = worse for the trader. */
  slippageBps: number | null;
}

export interface AlertListResponse {
  items: AlertRecord[];
  nextCursor: string | null;
}

export interface AlertDetail extends AlertRecord {
  rawBody: string;
  parsed: Record<string, unknown> | null;
  orders: Order[];
  fills: Fill[];
  approval: Approval | null;
}

// --- orders / fills / positions / account -----------------------------------

export interface Order {
  id: string;
  alertId: string | null;
  market: string | null;
  marketId: number;
  side: Side;
  kind: "open" | "close";
  type: "market" | "limit";
  /** Base units. */
  size: number | null;
  price: number | null;
  leverage: number | null;
  rq: number | null;
  sn: number | null;
  lb: number | null;
  perplOrderId: string | null;
  status: OrderStatus;
  errorCode: string | null;
  txHash: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Fill {
  id: string;
  orderId: string;
  alertId: string | null;
  market: string | null;
  side: Side | null;
  kind: "open" | "close" | null;
  price: number;
  size: number;
  fee: number;
  realizedPnl: number | null;
  txHash: string | null;
  block: number | null;
  atMs: number;
}

export interface Position {
  market: string;
  side: Side;
  size: number;
  entryPrice: number;
  markPrice: number;
  /** Unrealised PnL, USD. */
  upnl: number;
  notionalUsd: number;
  updatedAt: number;
}

export interface AccountSummary {
  connected: boolean;
  accountId: string | null;
  collateralUsd: number;
  equityUsd: number;
  availableUsd: number;
  openNotionalUsd: number;
  unrealizedPnlUsd: number;
  realizedPnlTodayUsd: number;
  updatedAt: number;
  /** true when read live from Perpl just now, false when from the last stored snapshot. */
  live: boolean;
}

// --- approvals ---------------------------------------------------------------

export interface Approval {
  id: string;
  alertId: string;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  strategyName: string | null;
  market: string | null;
  side: Side | null;
  kind: "open" | "close" | null;
  notionalUsd: number | null;
}

// --- limits ------------------------------------------------------------------

export type LimitsResponse = RiskLimits;

// --- perpl connection --------------------------------------------------------

export type PerplLinkStatus = "not_configured" | "disconnected" | "reconnecting" | "connected";

export interface PerplConnectionDTO {
  configured: boolean;
  status: PerplLinkStatus;
  accountId: string | null;
  apiKeyPublic: string | null;
  /** Last known collateral balance (USD), if cached. */
  collateral: number | null;
  createdAt: number | null;
  lastRq: number | null;
  mode: "sim" | "live";
}

export const PutPerplConnectionRequest = z.object({
  accountId: z.union([z.string().trim().min(1), z.number().int().nonnegative()]).transform(String),
  apiKeyPublic: z.string().trim().min(1).max(256),
  apiKeyPrivate: z.string().trim().min(1).max(512),
});
export type PutPerplConnectionRequest = z.input<typeof PutPerplConnectionRequest>;

// --- report card -------------------------------------------------------------

export type ReportRange = "7d" | "30d" | "all";
export const ReportRangeSchema = z.enum(["7d", "30d", "all"]);
export type Grade = "A" | "B" | "C" | "D" | "F";

export interface HistogramBucket {
  label: string;
  /** Inclusive lower bound, null = -infinity. */
  minBps: number | null;
  /** Exclusive upper bound, null = +infinity. */
  maxBps: number | null;
  count: number;
}

export interface MissedGroup {
  kind: "blocked" | "expired" | "failed";
  /** BlockReason for blocked/expired, error code for failed. */
  reason: string;
  label: string;
  count: number;
}

export interface GradeComponent {
  points: number;
  max: number;
  /** The raw measurement behind the points (e.g. median slippage bps). */
  value: number | null;
}

export interface ReportCard {
  strategyId: string;
  strategyName: string;
  range: ReportRange;
  since: number | null;
  generatedAt: number;
  counts: {
    total: number;
    /** Authentic, well-formed, non-duplicate alerts. */
    verified: number;
    /** Verified alerts that reached a terminal status (excludes in-flight). */
    shouldHaveTraded: number;
    filled: number;
    partiallyFilled: number;
    blocked: number;
    expired: number;
    failed: number;
    rejectedAuth: number;
    duplicate: number;
    invalid: number;
    inFlight: number;
  };
  /** (filled + partially_filled) / shouldHaveTraded; null when nothing terminal yet. */
  fillRate: number | null;
  latency: {
    count: number;
    medianMs: number | null;
    p95Ms: number | null;
    avgMs: number | null;
    minMs: number | null;
    maxMs: number | null;
    series: { alertId: string; atMs: number; latencyMs: number }[];
  };
  slippage: {
    count: number;
    avgBps: number | null;
    medianBps: number | null;
    p95Bps: number | null;
    worstBps: number | null;
    buckets: HistogramBucket[];
    series: { alertId: string; atMs: number; market: string | null; bps: number }[];
  };
  missed: MissedGroup[];
  pnl: {
    realizedUsd: number;
    feesUsd: number;
    netUsd: number;
    closedTrades: number;
    winRate: number | null;
    bestUsd: number | null;
    worstUsd: number | null;
    daily: { day: string; pnlUsd: number; cumulativeUsd: number }[];
  };
  grade: Grade | null;
  /** 0..100, null when there is no data. */
  score: number | null;
  gradeBreakdown: {
    fillRate: GradeComponent;
    slippage: GradeComponent;
    latency: GradeComponent;
    reliability: GradeComponent;
  };
  gradeExplanation: string;
}

// --- streaming ---------------------------------------------------------------

export interface StreamTicket {
  ticket: string;
  expiresAt: number;
}

/**
 * Server-Sent Events. The SSE `event:` field equals `type`, `data:` is the JSON of the whole object.
 * Heartbeats are comment lines (`: ping`) every 15 s and are invisible to EventSource listeners.
 */
export type StreamEvent =
  | { type: "ready"; at: number }
  | { type: "alert"; alert: AlertRecord }
  | { type: "order"; order: Order }
  | { type: "fill"; fill: Fill }
  | { type: "positions"; positions: Position[] }
  | { type: "approval"; approval: Approval }
  | { type: "perpl"; status: PerplLinkStatus }
  | { type: "wallet_action"; action: WalletActionDTO };
