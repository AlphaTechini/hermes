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
  /** Dry run: every alert runs all risk checks and is recorded as `dry_run`; nothing is sent to Perpl. */
  dryRun: boolean;
  /** Max slippage in bps for this strategy's orders. null = use the account default (`limits.defaultSlippageBps`). An `max_slippage_bps` inside the alert message still wins. */
  maxSlippageBps: number | null;
  /** Reserved. Only "market" (IOC with a slippage bound) is executed today. */
  orderType: StrategyOrderType;
}

export const STRATEGY_ORDER_TYPES = ["market"] as const;
export type StrategyOrderType = (typeof STRATEGY_ORDER_TYPES)[number];

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
  dryRun: z.boolean().optional(),
  maxSlippageBps: z.number().int().min(0).max(10_000).nullable().optional(),
  orderType: z.enum(STRATEGY_ORDER_TYPES).optional(),
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

/** One rule evaluated by the risk gate. Stored in the `risk_checked` (or `blocked`) alert event `detail.checks`. */
export interface RiskCheckResult {
  /** strategy_enabled, alert_age, rate_limit, perpl_connected, position_to_close, pause, markets, daily_loss, size, leverage, approval. */
  key: string;
  label: string;
  /** true = passed, false = failed (this one blocked the alert), null = skipped (not evaluated). */
  passed: boolean | null;
  skipped: boolean;
  /** What was measured (for example the order notional, the leverage, the market). null when not applicable. */
  value: number | string | boolean | null;
  /** The configured limit it was compared with. null when not applicable. */
  limit: number | string | boolean | null;
  /** "USD", "x", "s", "orders/min" or null. */
  unit: string | null;
  /** Readable one-liner (failure reason, or why it was skipped). */
  detail?: string;
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
  /**
   * received -> first fill, ms, EXCLUDING the time the alert waited for human approval (for approval-gated alerts it is
   * approval decision -> first fill). null until filled.
   */
  latencyMs: number | null;
  /** Time spent waiting for the human approval decision (ms), null when the alert was not approval-gated or is undecided. */
  approvalWaitMs?: number | null;
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
  /** Result of every risk rule evaluated for this alert (also on blocked alerts, the rest `skipped`). null for alerts that never reached the risk gate. */
  riskChecks?: RiskCheckResult[] | null;
}

// --- orders / fills / positions / account -----------------------------------

/** A raw Perpl frame recorded for an order. Only present on `GET /api/alerts/:id` orders. */
export interface OrderFrame {
  id: number;
  /** out = sent by Hermes (mt:22), in = received (mt:3, mt:24, mt:25). */
  direction: "out" | "in";
  mt: number;
  /** Epoch ms with sub-ms precision (send time / receive time on the Hermes clock). */
  atMs: number;
  /** The frame as JSON text. For `out` this is the exact string-able object that was sent (rq, sn, lb, ...). */
  json: string;
}

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
  /** Raw Perpl frames of this order (sent mt:22, received mt:3 / mt:24 / mt:25), oldest first. */
  frames?: OrderFrame[];
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
  /** Collateral locked in open positions (margin used), USD. Present on live reads. */
  marginUsedUsd?: number;
  /** Realised PnL today (UTC) + current unrealised PnL: the number the daily loss stop is evaluated against. */
  todayPnlUsd?: number;
  todayRealizedUsd?: number;
  todayUnrealizedUsd?: number;
  /** Configured daily loss stop (`limits.dailyLossStopUsd`), 0 = disabled. */
  lossStopUsd?: number;
  /** max(0, -todayPnlUsd): how much of the stop is used. */
  lossStopUsedUsd?: number;
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

/**
 * Health of the Perpl link of one user. Also pushed over SSE as `perpl_status` whenever the status, account or error
 * changes and as a snapshot every few seconds while connected (so `headBlock` keeps moving).
 */
export interface PerplHealthDTO {
  status: PerplLinkStatus;
  connected: boolean;
  mode: "sim" | "live";
  accountId: string | null;
  /** Epoch ms of the last trading-socket heartbeat (mt:100), null before the first one. */
  lastHeartbeatAt: number | null;
  /** `now - lastHeartbeatAt` at the moment this DTO was built, ms. */
  heartbeatAgeMs: number | null;
  /**
   * Round trip to Perpl, ms: moving average of mt:22 send -> mt:3 receive when orders were placed recently,
   * otherwise a timed public REST call (smoothed). Never the Hermes API round trip.
   */
  latencyMs: number | null;
  /** Where `latencyMs` comes from. */
  latencySource?: "order" | "probe" | null;
  /** Newest chain block seen on the heartbeat (sim and live). */
  headBlock: number | null;
  /** Block time estimated from heartbeat head deltas, ms (400 until measured). */
  blockTimeMs: number | null;
  /** Reconnects since the registry created this client. */
  reconnects: number;
  /** Last connection error, readable. Cleared when connected. */
  lastError: string | null;
  /** Machine code of `lastError` (perpl_geo_blocked, perpl_key_rejected, ...). */
  lastErrorCode: string | null;
  /** Epoch ms when this DTO was built. */
  at: number;
}

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
  /** Live link health; null when nothing is configured. */
  health?: PerplHealthDTO | null;
}

export const PutPerplConnectionRequest = z.object({
  /** Optional: when omitted Hermes looks the account up from the API key / the user's wallet address. */
  accountId: z.union([z.string().trim().min(1), z.number().int().nonnegative()]).transform(String).optional(),
  apiKeyPublic: z.string().trim().min(1).max(256),
  apiKeyPrivate: z.string().trim().min(1).max(512),
});
export type PutPerplConnectionRequest = z.input<typeof PutPerplConnectionRequest>;

/** `GET /api/perpl/context`: what onboarding needs from Perpl's `pub/context`. */
export interface PerplContextDTO {
  mode: "sim" | "live";
  /** Collateral token symbol, for example "AUSD". */
  collateralToken: string;
  collateralAddress?: string;
  collateralDecimals: number;
  /** Minimum to open an exchange account, in collateral units (AUSD). */
  minAccountOpenAusd: number;
  /** Minimum single deposit, in collateral units (AUSD). */
  minDepositAusd: number;
  markets: { symbol: string; id: number; priceDecimals: number; sizeDecimals: number }[];
  /** ISO-3166 country codes Perpl blocks. */
  geoBlock: string[];
}

/** One row of `GET /api/markets`: a Perpl market and its current mark price. Does not depend on holding a position. */
export interface MarketDTO {
  symbol: string;
  /** Perpl market id. */
  id: number;
  /** Current mark price in USD; null when Perpl (or the simulator) has no price for it right now. */
  markPrice: number | null;
  /** Change over the last 24 hours, percent (1.2 = +1.2%). Absent when the feed does not provide it. */
  change24hPct?: number | null;
}

// --- report card -------------------------------------------------------------

export type ReportRange = "24h" | "7d" | "30d" | "all";
export const ReportRangeSchema = z.enum(["24h", "7d", "30d", "all"]);
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
  /** Epoch ms when the most recent alert of this group was received. */
  lastAt: number;
}

/** One part of the report-card grade (DESIGN.md 10.8). */
export interface GradePart {
  key: "fillRate" | "slippage" | "speed";
  label: string;
  /** Share of the score: 0.4, 0.35, 0.25. */
  weight: number;
  /** The raw measurement: fill rate as a fraction 0..1, median slippage in bps, p95 alert-to-fill in ms. null when unmeasured. */
  measured: number | null;
  /** Ready to render, for example "91.2%", "4.1 bps", "p95 871 ms". */
  measuredLabel: string;
  /** 0..100, one decimal. */
  score: number;
}

export interface LatencyBucket {
  /** Bucket start, epoch ms (aligned to the bucket size in UTC). */
  atMs: number;
  count: number;
  medianMs: number;
  p95Ms: number;
}

export interface ReportPrior {
  since: number;
  until: number;
  eligible: number;
  fillRate: number | null;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  medianSlippageBps: number | null;
  /** current - prior, ms. Negative = faster than before. null when either side has no data. */
  medianLatencyDeltaMs: number | null;
  /** current - prior as a fraction (0.012 = 1.2 percentage points). */
  fillRateDelta: number | null;
  /** current - prior, bps. Negative = cheaper. */
  medianSlippageDeltaBps: number | null;
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
    /** Alerts recorded as `dry_run` (strategy in dry-run mode). Not counted anywhere else. */
    dryRun: number;
    /**
     * Alerts that passed every limit and were meant to trade: filled + partially filled + failed + expired approvals.
     * Blocks, duplicates, dry runs and in-flight alerts are excluded. This is the grade's fill-rate denominator.
     */
    eligible: number;
  };
  /** (filled + partially_filled) / eligible; null when nothing is eligible yet. */
  fillRate: number | null;
  latency: {
    count: number;
    medianMs: number | null;
    p95Ms: number | null;
    avgMs: number | null;
    minMs: number | null;
    maxMs: number | null;
    series: { alertId: string; atMs: number; latencyMs: number }[];
    /** Size of one `buckets` entry: 24h -> 1 h, 7d -> 6 h, 30d and all -> 1 day. */
    bucketMs: number;
    /** Median and p95 per bucket; empty buckets are omitted. */
    buckets: LatencyBucket[];
    /** The slowest alert in the range, for the chart annotation. */
    maxPoint: { at: number; ms: number; alertId: string; note?: string } | null;
  };
  slippage: {
    count: number;
    avgBps: number | null;
    medianBps: number | null;
    p95Bps: number | null;
    worstBps: number | null;
    /** sum over fills of slippage x size in USD; POSITIVE = cost to the trader, negative = price improvement. */
    costUsd: number;
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
  /** null when fewer than `gradeMinEligible` eligible alerts exist (see `gradeReason`). */
  grade: Grade | null;
  /** 0..100 (1 decimal), null when there is no grade. */
  score: number | null;
  /** Why there is no grade ("Grades start after 20 alerts that pass your limits. 12 so far."), null when graded. */
  gradeReason: string | null;
  gradeMinEligible: number;
  /** The three weighted parts of the score. Empty when there is no grade. */
  gradeParts: GradePart[];
  /** One line naming the weakest part, for example "An A starts at 90. The biggest drag is 13 alerts that passed your limits but did not fill." null when there is no grade. */
  gradeSummary: string | null;
  gradeBreakdown: {
    fillRate: GradeComponent;
    slippage: GradeComponent;
    latency: GradeComponent;
    reliability: GradeComponent;
  };
  /** The formula in plain English, exactly as the report shows it under "How the grade is computed". */
  gradeExplanation: string;
  /** Alerts that went through Perpl's pipeline because a human had to approve them (any approval outcome). */
  approvalGated: number;
  /** Max slippage the strategy allows, bps (strategy override, else `limits.defaultSlippageBps`). */
  slippageCapBps: number;
  /** Same-length window right before this one. null for range "all". */
  prior: ReportPrior | null;
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
  /** Link health (connected, heartbeat age, latency, head block). Pushed on change and every ~5 s while connected. */
  | { type: "perpl_status"; health: PerplHealthDTO }
  /** Live account summary (equity, free collateral, margin used, uPnL). Pushed after account/position/fill events. */
  | { type: "account"; account: AccountSummary }
  | { type: "wallet_action"; action: WalletActionDTO };
