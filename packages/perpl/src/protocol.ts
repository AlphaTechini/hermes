/**
 * Perpl wire protocol: enums, frame types and zod parsers.
 *
 * Source of truth: docs/research/perpl.md (which cites PerplFoundation/api-docs `websocket.md`, `types.md`,
 * `rest-endpoints.md`). Where perpl.md flags something as unverified it is parsed leniently here:
 *
 *  - numeric ids may arrive as JSON numbers OR decimal strings (`lfr` in particular), both are accepted;
 *  - amounts (`b`, `lb`, `f`, `c`, `dpnl`, ...) are collateral-token integers (AUSD, 6 dp) as decimal strings, a bare
 *    JSON number is accepted and stringified;
 *  - `mt: 3` carries `status: {code, error}`, but the legacy flat `{code, error, sr}` form is accepted too;
 *  - the wallet account list is `as` (compact), legacy `accounts` is accepted;
 *  - unknown extra keys are preserved (loose objects) so new protocol fields never break parsing.
 *
 * Integer scaling, in one place:
 *  - PRICE  (`p`, `fp`, `ep`, `xp`, `mrk`, `lst`, ...) = human price x 10^price_decimals   (per market, from /v1/pub/context)
 *  - SIZE   (`s`, `os`, `fs`)                      = base-asset size x 10^size_decimals    (per market)
 *  - AMOUNT (`b`, `lb`, `f`, `c`, `fee`, `dpnl`)   = collateral token units x 10^6 (AUSD), decimal STRING
 *  - LEVERAGE (`lv`)                              = multiple x 100 ("hundredths"; 500 = 5x)
 *  - MICROS (`taker_fee`, `rate`)                  = fraction x 10^6 (1000 = 0.1% = 10 bps)
 *  - BPS (`ms`, `mnp`)                             = fraction x 10^4
 */
import { z } from "zod";

// ---------------------------------------------------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------------------------------------------------

/** `mt` values. Direction in the comment: C = client to server, S = server to client. */
export const MsgType = {
  /** C: `{mt:1, t:<ms>}` keep-alive. Counts against the request budget. */
  Ping: 1,
  /** S */
  Pong: 2,
  /** S: one per mt:22. `code 0` = accepted for forwarding ONLY, not an order outcome. */
  StatusResponse: 3,
  /** C (market-data socket) */
  SubscriptionRequest: 5,
  /** S (market-data socket) */
  SubscriptionResponse: 6,
  GasPriceUpdate: 7,
  MarketConfigUpdate: 8,
  /** S: prices/volume/OI per market. */
  MarketStateUpdate: 9,
  MarketFundingUpdate: 10,
  CandlesSnapshot: 11,
  CandlesUpdate: 12,
  L2BookSnapshot: 15,
  L2BookUpdate: 16,
  TradesSnapshot: 17,
  TradesUpdate: 18,
  /** S: first frame after sign-in. Its `sn` seeds heartbeat sequence tracking. */
  WalletSnapshot: 19,
  WalletUpdate: 20,
  /** S: single account (balance, `fw`, `ft`, `lfr`). */
  AccountUpdate: 21,
  /** C */
  OrderRequest: 22,
  OrdersSnapshot: 23,
  /** S: authoritative order status. Correlate by `rq`. */
  OrdersUpdate: 24,
  /** S */
  FillsUpdate: 25,
  PositionsSnapshot: 26,
  PositionsUpdate: 27,
  AccountStatsUpdate: 28,
  /** C: must be the FIRST frame on the trading socket. */
  ApiKeySignIn: 29,
  /** HTTP only (batch order request) */
  BatchOrderRequest: 30,
  /** HTTP only (batch order response) */
  BatchStatusResponse: 31,
  /** S: `{mt:100, sn, h}`; `sn` must increase by exactly 1. */
  Heartbeat: 100,
} as const;
export type MsgTypeCode = (typeof MsgType)[keyof typeof MsgType];

// ---------------------------------------------------------------------------------------------------------------------
// Order enums
// ---------------------------------------------------------------------------------------------------------------------

/** `t` on mt:22 and on Order/Fill. */
export const OrderType = {
  Unspecified: 0,
  OpenLong: 1,
  OpenShort: 2,
  CloseLong: 3,
  CloseShort: 4,
  Cancel: 5,
  IncreasePositionCollateral: 6,
  Change: 7,
} as const;
export type OrderTypeCode = (typeof OrderType)[keyof typeof OrderType];

export const ORDER_TYPE_NAMES: Record<number, string> = {
  0: "Unspecified",
  1: "OpenLong",
  2: "OpenShort",
  3: "CloseLong",
  4: "CloseShort",
  5: "Cancel",
  6: "IncreasePositionCollateral",
  7: "Change",
};

/** `fl` bit flags. Combine with `|` only where the protocol allows (it documents single values: 0, 1, 2, 4). */
export const OrderFlag = {
  /** Default. Stays on the book until filled or cancelled. */
  GoodTillCancel: 0,
  /** Maker only; rejected if it would take. */
  PostOnly: 1,
  /** Fill the entire order or cancel. */
  FillOrKill: 2,
  /** Fill what is available, cancel the rest. This is what Hermes uses for market orders. */
  ImmediateOrCancel: 4,
} as const;
export type OrderFlagCode = (typeof OrderFlag)[keyof typeof OrderFlag];

/** `tpc` trigger price condition (stop-loss / take-profit trigger orders). */
export const TriggerCondition = {
  Unspecified: 0,
  GTELast: 1,
  LTELast: 2,
  GTEMark: 3,
  LTEMark: 4,
} as const;

/** `st` on mt:23/24 orders. */
export const OrderStatus = {
  Unspecified: 0,
  Pending: 1,
  Open: 2,
  PartiallyFilled: 3,
  Filled: 4,
  Canceled: 5,
  Expired: 6,
  Failed: 7,
  Untriggered: 8,
  Triggered: 9,
  Executed: 10,
} as const;
export type OrderStatusCode = (typeof OrderStatus)[keyof typeof OrderStatus];

export const ORDER_STATUS_NAMES: Record<number, string> = {
  0: "Unspecified",
  1: "Pending",
  2: "Open",
  3: "PartiallyFilled",
  4: "Filled",
  5: "Canceled",
  6: "Expired",
  7: "Failed",
  8: "Untriggered",
  9: "Triggered",
  10: "Executed",
};

/**
 * `st` values that are "definitive non-failures" for the per-rq dedupe rule (websocket.md "Retries"): the first one
 * received decides the fate of the rq. (perpl.md: Desk also counts 6 Expired, so 6 is included.)
 */
export const NON_FAILURE_STATUSES: ReadonlySet<number> = new Set([2, 3, 4, 5, 6, 8, 9, 10]);
/** `st` values after which the order will not change again. */
export const TERMINAL_ORDER_STATUSES: ReadonlySet<number> = new Set([4, 5, 6, 7, 10]);

/** `sr` on mt:24. Names verbatim from api-docs types.md `OrderStatusReason` (0..69). */
export const ORDER_STATUS_REASON_NAMES: Record<number, string> = {
  0: "Unspecified",
  1: "AmountExceedsAvailableBalance",
  2: "AccountFrozen",
  3: "CancelExistingInvalidCloseOrders",
  4: "CantChangeCloseOrder",
  5: "ChangeExpiredOrderNeedsNewExpiry",
  6: "ClearingExpiredOrder",
  7: "ClearingFrozenAccountOrder",
  8: "ClearingInvalidCloseOrder",
  9: "ClearingSelfMatchingOrder",
  10: "CloseOrderExceedsPosition",
  11: "CloseOrderPositionMismatch",
  12: "ContractNotOperational",
  13: "CrossesBook",
  14: "ExceedsLastExecutionBlock",
  15: "ForwardingReverted",
  16: "ImmediateOrCancelExecuted",
  17: "ImmediateOrderUnderMinimum",
  18: "InsuficientFundsForRecycleFee",
  19: "InvalidAccountFrozenOrder",
  20: "InvalidExpiryBlock",
  21: "InvalidOrderId",
  22: "MakerOrderFilled",
  23: "MakerOrderSettlementFailed",
  24: "MaximumAccountOrders",
  25: "MaxMatchesReached",
  26: "NoOp",
  27: "OrderBookFull",
  28: "OrderCancelled",
  29: "OrderCancelledByAdmin",
  30: "OrderCancelledByLiquidator",
  31: "OrderChanged",
  32: "OrderDescIdTooLow",
  33: "OrderDoesNotExist",
  34: "OrderForwardingNotAllowed",
  35: "OrderPlaced",
  36: "OrderPostFailed",
  37: "OrderSettlementImpliesInsolvent",
  38: "OrderSizeExceedsAvailableSize",
  39: "PostOrderUnderMinimum",
  40: "PriceOutOfRange",
  41: "RecycleBalanceInsufficientSevere",
  42: "SizeOutOfRange",
  43: "TakerOrderFilled",
  44: "TakerOrderSettlementFailed",
  45: "UnableToCancelOrder",
  46: "UnmatchedLotRemainsInFillOrKill",
  47: "UnspecifiedCollateral",
  48: "UnspecifiedPrice",
  49: "UnspecifiedSize",
  50: "WrongAccountForOrder",
  51: "WrongChainForOrder",
  52: "WrongMarketForOrder",
  53: "PerpetualInsolvent",
  54: "Triggered",
  55: "InvalidAmount",
  56: "InvalidFlags",
  57: "InvalidTriggerOrder",
  58: "WrongTriggerPosition",
  59: "TriggerDescIdTooLow",
  60: "TriggerOrderRequest",
  61: "ValueExceedsMaximum",
  62: "ClearingRemainingOrderLockBeyondBalance",
  63: "PriceSetDuringTriggerExec",
  64: "TriggeredExecutionAttemptsExhausted",
  65: "TriggeredOrderExecuted",
  66: "TriggeredOrderPartiallyFilled",
  67: "TriggeredOrderExpired",
  68: "TriggeredOrderRecoverableFailure",
  69: "OrderExtensionRejected",
};

/** Hand-written readable text for the `sr` codes a trader can act on. Others fall back to a humanised enum name. */
const SR_HUMAN: Record<number, string> = {
  1: "Not enough available balance for this order",
  2: "Account is frozen",
  10: "Close order is larger than the open position",
  11: "Close order does not match the open position",
  12: "Perpl contract is not operational",
  13: "Order would cross the book",
  14: "Order was not executed before its last execution block",
  15: "Forwarding the order to the exchange reverted",
  16: "Immediate-or-cancel order executed; unfilled remainder cancelled",
  17: "Order is below the minimum size for an immediate order",
  18: "Not enough funds for the order recycle fee",
  22: "Resting order filled",
  23: "Resting order failed to settle",
  24: "Maximum number of open orders reached",
  25: "Maximum number of matches reached",
  28: "Order cancelled",
  32: "Request id too low (a newer request id was already used on this account)",
  33: "Order does not exist",
  34: "Order forwarding is not enabled for this account; call allowOrderForwarding(true) from the wallet",
  35: "Order placed",
  36: "Order could not be posted",
  39: "Order is below the minimum posting size",
  40: "Price is out of the allowed range",
  42: "Size is out of the allowed range",
  43: "Order filled",
  44: "Order failed to settle",
  46: "Fill-or-kill order could not be filled in full",
  52: "Order was sent to the wrong market",
  53: "Perpetual is insolvent",
  61: "Value exceeds the maximum allowed",
};

/** `fr` on mt:24: why the exchange refused an order whose `sr` is 23, 36 or 44. */
export const ORDER_FAILURE_REASON_NAMES: Record<number, string> = {
  0: "Unspecified",
  1: "InsufficientBalance",
  2: "InsufficientCollateralIncrease",
  3: "InsufficientCollateralInvert",
  4: "NoPositionToClose",
  5: "PerpetualSolvency",
  6: "NegativePositionValue",
  7: "ReferencePriceStale",
  8: "ExceedsMaxNegPnlCollat",
  9: "Other",
};

const FR_HUMAN: Record<number, string> = {
  1: "account balance is below the collateral and fee the new position requires",
  2: "available collateral is below what increasing the position requires",
  3: "available collateral is below what inverting the position requires",
  4: "there is no position to close",
  5: "settling at this price would leave the perpetual insolvent",
  6: "closing would realise a negative position value",
  7: "no fresh reference price was available",
  8: "negative PnL to collateralise exceeds the order's limit (mnp)",
  9: "unspecified exchange failure",
};

/** Liquidity side on a Fill (`l`). */
export const LiquiditySide = { Unspecified: 0, Maker: 1, Taker: 2 } as const;
/** Position side `sd`. */
export const PositionType = { Unspecified: 0, Long: 1, Short: 2 } as const;
/** Position status `st`. */
export const PositionStatus = { Unspecified: 0, Open: 1, Closed: 2, Liquidated: 3, Deleveraged: 4, Unwound: 5, Failed: 6 } as const;
/** Position status reason `sr` (the documented "common values"). */
export const PositionStatusReason = {
  Closed: 13,
  Decreased: 14,
  Deleveraged: 15,
  Increased: 17,
  Inverted: 18,
  Liquidated: 19,
  Opened: 21,
  Unwound: 22,
} as const;
/** AccountEvent `et`. */
export const AccountEventType = {
  Unspecified: 0,
  Deposit: 1,
  Withdrawal: 2,
  IncreasePositionCollateral: 3,
  Settlement: 4,
  Liquidation: 5,
  TransferToProtocol: 6,
  TransferFromProtocol: 7,
  Funding: 8,
  Deleveraging: 9,
  Unwinding: 10,
  PositionCollateralDecreased: 11,
  LastForwardedDescIdReset: 12,
} as const;

/** WebSocket close codes (README "WebSocket Close Codes"). */
export const WsCloseCode = {
  /** Server going away: reconnect immediately, no back-off. */
  GoingAway: 1001,
  /** Rate limit / connection cap / ping timeout / idle timeout. */
  PolicyViolation: 1008,
  /** `failed to process`: unknown market, foreign account or unparseable frame. NO mt:3 is sent. */
  FailedToProcess: 1011,
  /** Send buffer overflow: client reads too slowly. */
  SendBufferOverflow: 1013,
  /** Abnormal closure, never sent by the server. */
  Abnormal: 1006,
  /** Authentication failure. */
  Unauthorized: 3401,
} as const;

/** Reconnect back-off schedule from the docs (ms). */
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 32000, 60000] as const;

// ---------------------------------------------------------------------------------------------------------------------
// Human readable helpers
// ---------------------------------------------------------------------------------------------------------------------

function humanizeEnumName(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** Readable text for an `sr` code. */
export function describeStatusReason(sr: number): string {
  const human = SR_HUMAN[sr];
  if (human) return human;
  const name = ORDER_STATUS_REASON_NAMES[sr];
  return name ? humanizeEnumName(name) : `Unknown reason ${sr}`;
}

/** Readable text for an `fr` code. */
export function describeFailureReason(fr: number): string {
  return FR_HUMAN[fr] ?? `unknown failure reason ${fr}`;
}

/** One readable line for a failed/terminal order message: `Order failed to settle: account balance is below ...`. */
export function describeOrderStatus(o: { st: number; sr?: number | undefined; fr?: number | undefined }): string {
  const stName = ORDER_STATUS_NAMES[o.st] ?? `status ${o.st}`;
  const sr = o.sr ?? 0;
  const base = sr ? describeStatusReason(sr) : stName;
  return o.fr ? `${base}: ${describeFailureReason(o.fr)}` : base;
}

/** Readable text for an `mt:3` status. */
export function describeStatusCode(code: number, error?: string): string {
  const base: Record<number, string> = {
    0: "accepted for forwarding",
    400: "bad request",
    403: "forbidden (the API key lacks trade scope, or the account is not owned by this wallet)",
    429: "rate limited",
    503: "service unavailable (retry)",
  };
  const head = base[code] ?? `status ${code}`;
  return error ? `${head}: ${error}` : head;
}

// ---------------------------------------------------------------------------------------------------------------------
// Primitive zod helpers (lenient)
// ---------------------------------------------------------------------------------------------------------------------

const intLike = z.union([z.number(), z.string().trim().regex(/^-?\d+$/).transform(Number)]);
const numLike = z.union([z.number(), z.string().trim().regex(/^-?\d+(\.\d+)?$/).transform(Number)]);
const amountLike = z.union([z.string(), z.number().transform((n) => String(n))]);
const bool = z.union([z.boolean(), z.number().transform((n) => n !== 0), z.string().transform((s) => s === "true" || s === "1")]);
const optInt = intLike.optional();

// ---------------------------------------------------------------------------------------------------------------------
// Shared sub-types
// ---------------------------------------------------------------------------------------------------------------------

/** Block number + unix ms timestamp. */
export interface BlockTimestamp {
  /** Block number. */
  b?: number | undefined;
  /** Unix milliseconds. */
  t?: number | undefined;
}
/** Block + tx index + tx hash + log index. `txid` is the Monad transaction hash (0x + 64 hex). */
export interface BlockTxLogTimestamp extends BlockTimestamp {
  tx?: number | undefined;
  txid?: string | undefined;
  l?: number | undefined;
}

const blockTimestampSchema = z.looseObject({ b: optInt, t: optInt });
const blockTxLogSchema = z.looseObject({ b: optInt, t: optInt, tx: optInt, txid: z.string().optional(), l: optInt });

// ---------------------------------------------------------------------------------------------------------------------
// Client -> server frames
// ---------------------------------------------------------------------------------------------------------------------

/** mt:29. First frame on the trading socket, within 10 s on testnet (5 s mainnet), else close 1008 `idle timeout`. */
export interface SignInFrame {
  mt: 29;
  chain_id: number;
  /** Opaque token (`X-API-Key`). */
  api_key: string;
  /** Unix epoch ms, decimal STRING. Must be within 30 s of server time. */
  timestamp: string;
  /** 16 random bytes, base64url without padding. Single use. */
  nonce: string;
  /** base64url(ed25519(canonical)) where canonical = `chain_id\ntrading-ws-signin\ntimestamp\nnonce`. */
  signature: string;
}

/**
 * Order description shared by the WebSocket `mt:22` frame and `POST /v1/trading/orders` (`OrderSpec`).
 *
 * Units: `p` price x 10^price_decimals (0 = market); `s` size x 10^size_decimals; `lv` leverage x 100;
 * `ms` and `mnp` bps; `lb` block number; `a` collateral integer string (AUSD x 10^6).
 */
export interface OrderSpec {
  /**
   * Request id, the idempotency key. Strictly increasing per account; new orders need `rq > account.lfr`.
   * Re-sending the SAME rq is the retry mechanism and executes at most once.
   */
  rq: number;
  /** Market id (BTC 16, ETH 32, SOL 48, MON 64, ZEC 256 on testnet). Unknown id => socket closed 1011. */
  mkt: number;
  /** Exchange account id: `wallet.as[].id` whose `in` equals the market's `instance_id`. Foreign id => 1011. */
  acc: number;
  /** Order id to cancel / change. */
  oid?: number | undefined;
  /** Order type, see {@link OrderType}. */
  t: number;
  /** Limit price, scaled by `price_decimals`. `0` (or omitted) = market. */
  p?: number | undefined;
  /** Size in lots, scaled by `size_decimals`. Must be > 0 except for cancels (0). */
  s: number;
  /** Amount for type 6 (IncreasePositionCollateral), AUSD x 10^6 as a decimal string. */
  a?: string | undefined;
  /**
   * Max market-order slippage in bps (`ms`). `0`/omitted = market default. Must be `<= market.order_max_market_slippage_bps`
   * (1000 for BTC/ETH/SOL, 100 for MON/ZEC on testnet). Hermes sends 50 by default.
   */
  ms?: number | undefined;
  /** Max negative-PnL collateralisation in bps (0..65535). OMIT for the market default; 0 is NOT the same as omitted. */
  mnp?: number | undefined;
  /** Good-till block (GTC when unset). */
  tif?: number | undefined;
  /** Flags, see {@link OrderFlag}. */
  fl: number;
  /** Trigger price (stop-loss / take-profit). Needs `tpc` when > 0. */
  tp?: number | undefined;
  /** Trigger condition, see {@link TriggerCondition}. */
  tpc?: number | undefined;
  /** Request whose outcome activates this trigger order. */
  tr?: number | undefined;
  /** Position id this trigger order is linked to. */
  lp?: number | undefined;
  /** Leverage in hundredths (500 = 5x). `100 <= lv <= market.config.initial_margin` for opens. 0 allowed for cancels. */
  lv: number;
  /**
   * Last execution block: `0`, or `head < lb <= head + market.order_ttl_blocks`. Hermes always sends 0 (perpl.md 0.5):
   * the server then substitutes the market's maximum window (`order_ttl_blocks`, 20 blocks ~ 8 s on testnet).
   */
  lb: number;
  /** Builder fee (per 100k). Builder-bound keys only. Omit. */
  bf?: number | undefined;
}

/** mt:22 = {@link OrderSpec} plus a header. */
export interface OrderRequestFrame extends OrderSpec {
  mt: 22;
  /**
   * Per-frame sequence, unique and NON-ZERO. Echoed as `cid` on the mt:3 reply (omitted from mt:3 when 0), which is the
   * only way to match an acknowledgement or rejection to this frame.
   */
  sn: number;
}

/** mt:1 keep-alive. Counts against the 60 requests/min budget. */
export interface PingFrame {
  mt: 1;
  t: number;
}

/** mt:5 market-data subscription request. */
export interface SubscriptionRequestFrame {
  mt: 5;
  subs: Array<{ stream: string; subscribe: boolean }>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Server -> client frames
// ---------------------------------------------------------------------------------------------------------------------

/** `{code, error}`; code 0 = ok. */
export interface Status {
  code: number;
  error?: string | undefined;
}

/**
 * mt:3, exactly one per mt:22.
 * `status.code 0` = accepted for forwarding (NOT posted, NOT filled). Non-zero = rejected at the gateway and NO mt:24 will
 * follow. Codes: 400 bad request, 403 read-scoped key / foreign account, 429, 503.
 */
export interface StatusResponseFrame {
  mt: 3;
  /** Always 100 (command-status stream). */
  sid?: number | undefined;
  /** Server assigned; not contiguous. Do not use for correlation. */
  sn?: number | undefined;
  /** The `sn` you sent. Omitted when you sent sn 0. */
  cid?: number | undefined;
  status: Status;
}

export interface PongFrame {
  mt: 2;
  t?: number | undefined;
}

export interface Account {
  mt?: number | undefined;
  /** Instance id (matches `market.instance_id`). */
  in: number;
  /** Account id, the `acc` of orders. */
  id: number;
  /** Frozen. */
  fr: boolean;
  /** Order forwarding enabled. Orders are rejected (sr 34) while false. Re-read on every mt:21. */
  fw: boolean;
  /** Fee tier, an index into market `maker_fees` / `taker_fees`. Re-read on every mt:21. */
  ft: number;
  /** Last forwarded request id. Seed `rq` from this. */
  lfr: number;
  /** Balance, AUSD x 10^6 decimal string. */
  b: string;
  /** Locked balance, AUSD x 10^6 decimal string. */
  lb: string;
  /** Recent events. */
  h?: AccountEvent[] | undefined;
}

export interface AccountEvent {
  at: BlockTxLogTimestamp;
  in: number;
  id: number;
  /** See {@link AccountEventType}. */
  et: number;
  m?: number | undefined;
  /** Request id. */
  r?: number | undefined;
  o?: number | undefined;
  p?: number | undefined;
  /** Amount change. */
  a: string;
  /** Updated balance. */
  b: string;
  /** Locked balance. */
  lb: string;
  /** Fee (gross). */
  f: string;
  bfa?: string | undefined;
}

export interface AccountStats {
  mt?: number | undefined;
  in: number;
  id: number;
  /** Total deposits. */
  td: string;
  /** Total withdrawals. */
  tw: string;
  /** Total volume. */
  tv: string;
  /** Total fees. */
  tf: string;
  tbf?: string | undefined;
  /** Total realised PnL (net of fees). */
  trp: string;
  /** Win rate, bps. */
  wr: number;
  /** Total trades. */
  tt: number;
}

/** mt:19 WalletSnapshot (also REST `GET /v1/trading/wallet`, and mt:20 WalletUpdate). */
export interface WalletFrame {
  mt: 19 | 20;
  /** For mt:19 this is the sequence number heartbeat tracking starts from (`lastSn = sn`). */
  sn?: number | undefined;
  at?: BlockTimestamp | undefined;
  /** Wallet address. */
  addr?: string | undefined;
  /** Nonce. */
  n?: number | undefined;
  /** Fee level. */
  fl?: number | undefined;
  /** Accounts. */
  as: Account[];
  sts?: AccountStats[] | undefined;
}

/** mt:21 AccountUpdate: an {@link Account} with `mt: 21`. */
export interface AccountUpdateFrame extends Account {
  mt: 21;
}

/** mt:28 AccountStatsUpdate. */
export interface AccountStatsFrame extends AccountStats {
  mt: 28;
}

/**
 * Order message (mt:23 snapshot entries, mt:24 updates, and REST order/order-history). Correlate by `rq` (+`acc`).
 * Snapshot entries carry no `sr`.
 */
export interface Order {
  /** Update timestamp, `at.txid` = Monad tx hash. */
  at: BlockTxLogTimestamp;
  /** Creation timestamp. */
  c?: BlockTxLogTimestamp | undefined;
  /** Request id (client order id). */
  rq: number;
  mkt: number;
  acc: number;
  /** Exchange order id (assigned once posted). */
  oid: number;
  /** Smart contract order id. */
  scid: number;
  /** Status, see {@link OrderStatus}. */
  st: number;
  /** Status reason, see {@link ORDER_STATUS_REASON_NAMES}. */
  sr: number;
  /** Failure detail for sr 23/36/44, see {@link ORDER_FAILURE_REASON_NAMES}. */
  fr?: number | undefined;
  /** Order type. */
  t: number;
  /** `true` = remove from open orders. */
  r?: boolean | undefined;
  /** Limit price (scaled), 0 = market. */
  p?: number | undefined;
  /** Original size (scaled). */
  os: number;
  /** Weighted average fill price (scaled). */
  fp: number;
  /** Filled size (scaled). */
  fs: number;
  /** Fee paid, gross (AUSD x 10^6). */
  f: string;
  bfa?: string | undefined;
  tif?: number | undefined;
  /** Flags. */
  fl: number;
  tp?: number | undefined;
  tpc?: number | undefined;
  lp?: number | undefined;
  /** Max matches. */
  mm: number;
  /** Leverage (hundredths). */
  lv: number;
}

/** mt:23 (snapshot) / mt:24 (update). */
export interface OrdersFrame {
  mt: 23 | 24;
  sn?: number | undefined;
  at?: BlockTimestamp | undefined;
  d: Order[];
}

/** One fill. No `rq` on fills: map `oid -> rq` from mt:24. `f` is negative for a rebate. */
export interface Fill {
  at: BlockTxLogTimestamp;
  mkt: number;
  acc: number;
  oid: number;
  /** Order type. */
  t: number;
  /** 1 maker, 2 taker. */
  l: number;
  /** Fill price (scaled). */
  p?: number | undefined;
  /** Filled size (scaled). */
  s: number;
  /** Fee, gross, AUSD x 10^6 (string, negative = rebate). */
  f: string;
  bfa?: string | undefined;
}

/** mt:25 FillsUpdate. */
export interface FillsFrame {
  mt: 25;
  at?: BlockTimestamp | undefined;
  d: Fill[];
}

/**
 * Position (mt:26 snapshot / mt:27 update; REST positions + position-history). In an update each settlement event is an
 * entry of `e`. Realised PnL of an exit event = `dpnl + fnd - fee` (`fee` already includes `cfee`).
 */
export interface Position {
  at: BlockTxLogTimestamp;
  mkt: number;
  acc: number;
  /** Position id. */
  pid: number;
  rq: number;
  oid: number;
  /** See {@link PositionStatus}. */
  st: number;
  /** See {@link PositionStatusReason}. */
  sr: number;
  /** 1 long, 2 short. */
  sd: number;
  /** Collateral, AUSD x 10^6. */
  c: string;
  /** Entry price (scaled). */
  ep: number;
  epr?: number | undefined;
  /** Size (scaled). */
  s: number;
  /** Fees against the position/event (AUSD x 10^6). */
  fee: string;
  /** Fee paid by the closing/decreasing fill itself (included in `fee`). */
  cfee?: string | undefined;
  efs: number;
  /** Leverage (hundredths). */
  lv: number;
  /** Realised delta PnL (AUSD x 10^6). */
  dpnl?: string | undefined;
  /** Realised funding PnL. */
  fnd?: string | undefined;
  /** Exit price (scaled). */
  xp?: number | undefined;
  xfs: number;
  ots?: BlockTxLogTimestamp | undefined;
  e?: Position[] | undefined;
}

/** mt:26 / mt:27. */
export interface PositionsFrame {
  mt: 26 | 27;
  sn?: number | undefined;
  at?: BlockTimestamp | undefined;
  d: Position[];
}

/** mt:100 heartbeat. */
export interface HeartbeatFrame {
  mt: 100;
  /** Sequence number; must be previous + 1, else force a reconnect. */
  sn: number;
  /** Latest head block. */
  h: number;
}

/** Per-market prices, scaled by `price_decimals`. */
export interface MarketState {
  at?: BlockTimestamp | undefined;
  /** Oracle price. */
  orl: number;
  /** Mark price. */
  mrk: number;
  /** Last trade price. */
  lst: number;
  mid: number;
  bid: number;
  ask: number;
  /** Price 24 h ago. */
  prv: number;
  /** Daily volume (size). */
  dv: number;
  /** Daily volume (amount). */
  dva: string;
  /** Open interest (size). */
  oi: number;
  /** Total value locked (amount). */
  tvl: string;
}

/** mt:9, and REST `GET /v1/market-data/ticker` (`sn` = newest block). */
export interface MarketStateFrame {
  mt: 9;
  sn?: number | undefined;
  d: Record<string, MarketState>;
}

export interface SubscriptionResponseFrame {
  mt: 6;
  subs: Array<{ stream: string; sid?: number | undefined; status?: Status | undefined }>;
}

export interface L2PriceLevel {
  p: number;
  s: number;
  /** Number of orders; 0 = remove the level. */
  o: number;
}
export interface L2BookFrame {
  mt: 15 | 16;
  sn?: number | undefined;
  sid?: number | undefined;
  at?: BlockTimestamp | undefined;
  bid: L2PriceLevel[];
  ask: L2PriceLevel[];
}

export interface Trade {
  at: BlockTxLogTimestamp;
  p: number;
  s: number;
  /** 1 buy, 2 sell. */
  sd: number;
}
export interface TradesFrame {
  mt: 17 | 18;
  sid?: number | undefined;
  d: Trade[];
}

export interface Candle {
  t: number;
  o: number;
  c: number;
  h: number;
  l: number;
  v: string;
  n: number;
}
export interface CandlesFrame {
  mt: 11 | 12;
  sid?: number | undefined;
  at?: BlockTimestamp | undefined;
  r?: number | undefined;
  d: Candle[];
}

/** A frame whose `mt` this client does not interpret (gas, funding, market-config, batch, future types). */
export interface OtherFrame {
  mt: number;
  [key: string]: unknown;
}

export type ServerFrame =
  | StatusResponseFrame
  | PongFrame
  | SubscriptionResponseFrame
  | MarketStateFrame
  | WalletFrame
  | AccountUpdateFrame
  | AccountStatsFrame
  | OrdersFrame
  | FillsFrame
  | PositionsFrame
  | HeartbeatFrame
  | L2BookFrame
  | TradesFrame
  | CandlesFrame
  | OtherFrame;

// ---------------------------------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------------------------------

const statusSchema = z.looseObject({ code: intLike, error: z.string().optional() });

export const accountSchema: z.ZodType<Account> = z.looseObject({
  mt: optInt,
  in: intLike,
  id: intLike,
  fr: bool.default(false),
  fw: bool.default(false),
  ft: intLike.default(0),
  lfr: intLike.default(0),
  b: amountLike.default("0"),
  lb: amountLike.default("0"),
  h: z.array(z.lazy(() => accountEventSchema)).optional(),
});

export const accountEventSchema: z.ZodType<AccountEvent> = z.looseObject({
  at: blockTxLogSchema.default({}),
  in: intLike.default(0),
  id: intLike.default(0),
  et: intLike.default(0),
  m: optInt,
  r: optInt,
  o: optInt,
  p: optInt,
  a: amountLike.default("0"),
  b: amountLike.default("0"),
  lb: amountLike.default("0"),
  f: amountLike.default("0"),
  bfa: amountLike.optional(),
});

export const accountStatsSchema: z.ZodType<AccountStats> = z.looseObject({
  mt: optInt,
  in: intLike.default(0),
  id: intLike.default(0),
  td: amountLike.default("0"),
  tw: amountLike.default("0"),
  tv: amountLike.default("0"),
  tf: amountLike.default("0"),
  tbf: amountLike.optional(),
  trp: amountLike.default("0"),
  wr: intLike.default(0),
  tt: intLike.default(0),
});

export const orderSchema: z.ZodType<Order> = z.looseObject({
  at: blockTxLogSchema.default({}),
  c: blockTxLogSchema.optional(),
  rq: intLike,
  mkt: intLike.default(0),
  acc: intLike.default(0),
  oid: intLike.default(0),
  scid: intLike.default(0),
  st: intLike,
  sr: intLike.default(0),
  fr: optInt,
  t: intLike.default(0),
  r: bool.optional(),
  p: optInt,
  os: intLike.default(0),
  fp: intLike.default(0),
  fs: intLike.default(0),
  f: amountLike.default("0"),
  bfa: amountLike.optional(),
  tif: optInt,
  fl: intLike.default(0),
  tp: optInt,
  tpc: optInt,
  lp: optInt,
  mm: intLike.default(0),
  lv: intLike.default(0),
});

export const fillSchema: z.ZodType<Fill> = z.looseObject({
  at: blockTxLogSchema.default({}),
  mkt: intLike.default(0),
  acc: intLike.default(0),
  oid: intLike.default(0),
  t: intLike.default(0),
  l: intLike.default(0),
  p: optInt,
  s: intLike,
  f: amountLike.default("0"),
  bfa: amountLike.optional(),
});

export const positionSchema: z.ZodType<Position> = z.looseObject({
  at: blockTxLogSchema.default({}),
  mkt: intLike,
  acc: intLike.default(0),
  pid: intLike.default(0),
  rq: intLike.default(0),
  oid: intLike.default(0),
  st: intLike.default(0),
  sr: intLike.default(0),
  sd: intLike.default(0),
  c: amountLike.default("0"),
  ep: intLike.default(0),
  epr: optInt,
  s: intLike.default(0),
  fee: amountLike.default("0"),
  cfee: amountLike.optional(),
  efs: intLike.default(0),
  lv: intLike.default(0),
  dpnl: amountLike.optional(),
  fnd: amountLike.optional(),
  xp: optInt,
  xfs: intLike.default(0),
  ots: blockTxLogSchema.optional(),
  e: z.array(z.lazy(() => positionSchema)).optional(),
});

const marketStateSchema: z.ZodType<MarketState> = z.looseObject({
  at: blockTimestampSchema.optional(),
  orl: numLike.default(0),
  mrk: numLike.default(0),
  lst: numLike.default(0),
  mid: numLike.default(0),
  bid: numLike.default(0),
  ask: numLike.default(0),
  prv: numLike.default(0),
  dv: numLike.default(0),
  dva: amountLike.default("0"),
  oi: numLike.default(0),
  tvl: amountLike.default("0"),
});

const walletSchema = z.looseObject({
  mt: intLike,
  sn: optInt,
  at: blockTimestampSchema.optional(),
  addr: z.string().optional(),
  n: optInt,
  fl: optInt,
  as: z.array(accountSchema).optional(),
  accounts: z.array(accountSchema).optional(),
  sts: z.array(accountStatsSchema).optional(),
});

const listFrame = <T extends z.ZodType>(item: T) =>
  z.looseObject({ mt: intLike, sn: optInt, at: blockTimestampSchema.optional(), d: z.array(item).default([]) });

const levelSchema = z.looseObject({ p: intLike, s: intLike, o: intLike });
const tradeSchema = z.looseObject({ at: blockTxLogSchema.default({}), p: intLike, s: intLike, sd: intLike.default(0) });
const candleSchema = z.looseObject({
  t: intLike,
  o: intLike,
  c: intLike,
  h: intLike,
  l: intLike,
  v: amountLike.default("0"),
  n: intLike.default(0),
});

export type ParseResult<T> = { ok: true; frame: T } | { ok: false; error: string; raw: unknown };

function fail(error: string, raw: unknown): { ok: false; error: string; raw: unknown } {
  return { ok: false, error, raw };
}

function zodMessage(e: z.ZodError): string {
  return e.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

/** Normalise an mt:3 payload (nested `status` or legacy flat `{code, error}`). */
function parseStatus(o: Record<string, unknown>): ParseResult<StatusResponseFrame> {
  const nested = o.status !== undefined ? statusSchema.safeParse(o.status) : undefined;
  let status: Status | undefined;
  if (nested) {
    if (!nested.success) return fail(`status: ${zodMessage(nested.error)}`, o);
    status = { code: nested.data.code, ...(nested.data.error !== undefined ? { error: nested.data.error } : {}) };
  } else {
    const flat = statusSchema.safeParse(o);
    if (!flat.success) return fail(`status: ${zodMessage(flat.error)}`, o);
    status = { code: flat.data.code, ...(flat.data.error !== undefined ? { error: flat.data.error } : {}) };
  }
  const num = (v: unknown): number | undefined => {
    const r = intLike.safeParse(v);
    return r.success ? r.data : undefined;
  };
  const frame: StatusResponseFrame = { mt: 3, status };
  const sid = num(o.sid);
  const sn = num(o.sn);
  const cid = num(o.cid);
  if (sid !== undefined) frame.sid = sid;
  if (sn !== undefined) frame.sn = sn;
  if (cid !== undefined) frame.cid = cid;
  return { ok: true, frame };
}

/**
 * Parse one server frame (a JSON string or an already-parsed value). Never throws. Unknown `mt` values come back as
 * {@link OtherFrame}; a known `mt` with a malformed body is `{ok:false}`.
 */
export function parseServerFrame(input: unknown): ParseResult<ServerFrame> {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      return fail("invalid JSON", input);
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("frame is not an object", value);
  const o = value as Record<string, unknown>;
  const mtParsed = intLike.safeParse(o.mt);
  if (!mtParsed.success) return fail("missing or invalid mt", value);
  const mt = mtParsed.data;

  const run = <T>(schema: z.ZodType<T>, map?: (v: T) => ServerFrame): ParseResult<ServerFrame> => {
    const r = schema.safeParse(o);
    if (!r.success) return fail(`mt:${mt} ${zodMessage(r.error)}`, value);
    return { ok: true, frame: map ? map(r.data) : (r.data as unknown as ServerFrame) };
  };

  switch (mt) {
    case MsgType.StatusResponse:
      return parseStatus(o);
    case MsgType.Pong:
      return { ok: true, frame: { mt: 2, ...(typeof o.t === "number" ? { t: o.t } : {}) } };
    case MsgType.SubscriptionResponse:
      return run(
        z.looseObject({
          mt: intLike,
          subs: z
            .array(z.looseObject({ stream: z.string(), sid: optInt, status: statusSchema.optional() }))
            .default([]),
        }),
        (v) => ({ mt: 6, subs: v.subs }) as SubscriptionResponseFrame,
      );
    case MsgType.MarketStateUpdate:
      return run(
        z.looseObject({ mt: intLike, sn: optInt, d: z.record(z.string(), marketStateSchema.optional()).default({}) }),
        (v) => {
          const d: Record<string, MarketState> = {};
          for (const [k, s] of Object.entries(v.d)) if (s) d[k] = s;
          return { mt: 9, ...(v.sn !== undefined ? { sn: v.sn } : {}), d };
        },
      );
    case MsgType.WalletSnapshot:
    case MsgType.WalletUpdate:
      return run(walletSchema, (v) => ({
        mt: mt as 19 | 20,
        ...(v.sn !== undefined ? { sn: v.sn } : {}),
        ...(v.at ? { at: v.at } : {}),
        ...(v.addr !== undefined ? { addr: v.addr } : {}),
        ...(v.n !== undefined ? { n: v.n } : {}),
        ...(v.fl !== undefined ? { fl: v.fl } : {}),
        as: v.as ?? v.accounts ?? [],
        ...(v.sts ? { sts: v.sts } : {}),
      }));
    case MsgType.AccountUpdate:
      return run(accountSchema, (v) => ({ ...v, mt: 21 }) as AccountUpdateFrame);
    case MsgType.AccountStatsUpdate:
      return run(accountStatsSchema, (v) => ({ ...v, mt: 28 }) as AccountStatsFrame);
    case MsgType.OrdersSnapshot:
    case MsgType.OrdersUpdate:
      return run(listFrame(orderSchema), (v) => ({ ...v, mt: mt as 23 | 24 }) as OrdersFrame);
    case MsgType.FillsUpdate:
      return run(listFrame(fillSchema), (v) => ({ ...v, mt: 25 }) as FillsFrame);
    case MsgType.PositionsSnapshot:
    case MsgType.PositionsUpdate:
      return run(listFrame(positionSchema), (v) => ({ ...v, mt: mt as 26 | 27 }) as PositionsFrame);
    case MsgType.Heartbeat:
      return run(z.looseObject({ mt: intLike, sn: intLike, h: intLike.default(0) }), (v) => ({ mt: 100, sn: v.sn, h: v.h }));
    case MsgType.L2BookSnapshot:
    case MsgType.L2BookUpdate:
      return run(
        z.looseObject({
          mt: intLike,
          sn: optInt,
          sid: optInt,
          at: blockTimestampSchema.optional(),
          bid: z.array(levelSchema).default([]),
          ask: z.array(levelSchema).default([]),
        }),
        (v) => ({ ...v, mt: mt as 15 | 16 }) as L2BookFrame,
      );
    case MsgType.TradesSnapshot:
    case MsgType.TradesUpdate:
      return run(
        z.looseObject({ mt: intLike, sid: optInt, d: z.array(tradeSchema).default([]) }),
        (v) => ({ ...v, mt: mt as 17 | 18 }) as TradesFrame,
      );
    case MsgType.CandlesSnapshot:
    case MsgType.CandlesUpdate:
      return run(
        z.looseObject({
          mt: intLike,
          sid: optInt,
          at: blockTimestampSchema.optional(),
          r: optInt,
          d: z.array(candleSchema).default([]),
        }),
        (v) => ({ ...v, mt: mt as 11 | 12 }) as CandlesFrame,
      );
    default:
      return { ok: true, frame: { ...o, mt } as OtherFrame };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------------------------------------------------

export const isStatusResponse = (f: ServerFrame): f is StatusResponseFrame => f.mt === 3;
export const isWalletFrame = (f: ServerFrame): f is WalletFrame => f.mt === 19 || f.mt === 20;
export const isAccountUpdate = (f: ServerFrame): f is AccountUpdateFrame => f.mt === 21;
export const isOrdersFrame = (f: ServerFrame): f is OrdersFrame => f.mt === 23 || f.mt === 24;
export const isFillsFrame = (f: ServerFrame): f is FillsFrame => f.mt === 25;
export const isPositionsFrame = (f: ServerFrame): f is PositionsFrame => f.mt === 26 || f.mt === 27;
export const isHeartbeat = (f: ServerFrame): f is HeartbeatFrame => f.mt === 100;
export const isMarketState = (f: ServerFrame): f is MarketStateFrame => f.mt === 9;
export const isSubscriptionResponse = (f: ServerFrame): f is SubscriptionResponseFrame => f.mt === 6;

/** st 7. */
export const isFailureOrder = (o: Pick<Order, "st">): boolean => o.st === OrderStatus.Failed;
/** st in {2,3,4,5,6,8,9,10}: the first of these for an rq is "definitive". */
export const isNonFailureOrder = (o: Pick<Order, "st">): boolean => NON_FAILURE_STATUSES.has(o.st);
/** Terminal: the order will not change any more. */
export const isTerminalOrder = (o: Pick<Order, "st" | "r">): boolean => TERMINAL_ORDER_STATUSES.has(o.st) || o.r === true;

// ---------------------------------------------------------------------------------------------------------------------
// Client frame builders and validation
// ---------------------------------------------------------------------------------------------------------------------

const ORDER_KEYS = ["rq", "mkt", "acc", "oid", "t", "p", "s", "a", "ms", "mnp", "tif", "fl", "tp", "tpc", "tr", "lp", "lv", "lb", "bf"] as const;

/** Strip undefined and unknown keys so only protocol fields reach the wire. */
export function toOrderSpec(spec: OrderSpec): OrderSpec {
  const out: Record<string, unknown> = {};
  for (const k of ORDER_KEYS) {
    const v = spec[k];
    if (v !== undefined) out[k] = v;
  }
  return out as unknown as OrderSpec;
}

/** Build the mt:22 frame. `sn` must be unique and non-zero. */
export function buildOrderRequest(spec: OrderSpec, sn: number): OrderRequestFrame {
  if (!Number.isInteger(sn) || sn <= 0) throw new RangeError("sn must be a positive integer (0 would make mt:3 uncorrelatable)");
  return { mt: 22, sn, ...toOrderSpec(spec) };
}

export interface OrderValidationLimits {
  /** `market.config.initial_margin` = max leverage x 100. */
  maxLeverageHdths?: number | undefined;
  /** `market.order_max_market_slippage_bps`. */
  maxSlippageBps?: number | undefined;
  /** `market.config.is_open`. */
  isOpen?: boolean | undefined;
}

/** Client-side checks from websocket.md "Input Validation". Returns problems (empty = ok). */
export function validateOrderSpec(spec: OrderSpec, limits: OrderValidationLimits = {}): string[] {
  const problems: string[] = [];
  const isCancel = spec.t === OrderType.Cancel;
  const isOpenType = spec.t === OrderType.OpenLong || spec.t === OrderType.OpenShort;
  const uint = (name: string, v: number | undefined, max = Number.MAX_SAFE_INTEGER): void => {
    if (v === undefined) return;
    if (!Number.isInteger(v) || v < 0 || v > max) problems.push(`${name} must be an unsigned integer`);
  };
  uint("rq", spec.rq);
  uint("mkt", spec.mkt);
  uint("acc", spec.acc);
  uint("p", spec.p);
  uint("s", spec.s);
  uint("lv", spec.lv);
  uint("lb", spec.lb);
  if (!(spec.rq > 0)) problems.push("rq must be > 0");
  if (spec.t < 1 || spec.t > 7) problems.push(`invalid order type ${spec.t}`);
  if (!isCancel && spec.t !== OrderType.IncreasePositionCollateral && !(spec.s > 0)) problems.push("size must be > 0");
  if (spec.t === OrderType.IncreasePositionCollateral && !(spec.a && /^\d+$/.test(spec.a) && spec.a !== "0")) {
    problems.push("amount `a` is required for IncreasePositionCollateral");
  }
  if ((isCancel || spec.t === OrderType.Change) && !spec.oid) problems.push("oid is required for cancel/change");
  if (![0, 1, 2, 4].includes(spec.fl)) problems.push(`invalid flags ${spec.fl}`);
  if (spec.mnp !== undefined && (!Number.isInteger(spec.mnp) || spec.mnp < 0 || spec.mnp > 65535)) {
    problems.push("mnp must be an integer in 0..65535 (omit for the market default)");
  }
  if (spec.tp !== undefined && spec.tp > 0 && !spec.tpc) problems.push("tpc is required when tp > 0");
  if (isOpenType) {
    if (spec.lv < 100) problems.push("leverage below 1x");
    if (limits.maxLeverageHdths !== undefined && spec.lv > limits.maxLeverageHdths) {
      problems.push(`leverage ${spec.lv / 100}x exceeds the market maximum ${limits.maxLeverageHdths / 100}x`);
    }
  }
  if (spec.ms !== undefined) {
    uint("ms", spec.ms);
    if (limits.maxSlippageBps !== undefined && spec.ms > limits.maxSlippageBps) {
      problems.push(`max slippage ${spec.ms} bps exceeds the market maximum ${limits.maxSlippageBps} bps`);
    }
  }
  if (limits.isOpen === false && !isCancel) problems.push("market is closed");
  return problems;
}

/** mt:1 ping. */
export function buildPing(nowMs: number = Date.now()): PingFrame {
  return { mt: 1, t: nowMs };
}

/** mt:5 subscription request. */
export function buildSubscribe(streams: string[], subscribe = true): SubscriptionRequestFrame {
  return { mt: 5, subs: streams.map((stream) => ({ stream, subscribe })) };
}

/** `heartbeat@10143`, `market-state@10143`, `order-book@16`, `trades@16`, `candles@16*3600`. */
export const streams = {
  heartbeat: (chainId: number) => `heartbeat@${chainId}`,
  gasStats: (chainId: number) => `gas-stats@${chainId}`,
  marketConfig: (chainId: number) => `market-config@${chainId}`,
  marketState: (chainId: number) => `market-state@${chainId}`,
  funding: (chainId: number) => `funding@${chainId}`,
  candles: (marketId: number, resolutionSec: number) => `candles@${marketId}*${resolutionSec}`,
  orderBook: (marketId: number) => `order-book@${marketId}`,
  trades: (marketId: number) => `trades@${marketId}`,
} as const;

// ---------------------------------------------------------------------------------------------------------------------
// REST payloads
// ---------------------------------------------------------------------------------------------------------------------

/** History endpoints: `{d, np}` newest first, `np` = opaque next-page cursor (empty/absent = last page). */
export interface HistoryPage<T> {
  d: T[];
  np?: string | undefined;
}

/** Response of `POST /v1/trading/orders`. Statuses are positional (i-th answers i-th order). HTTP 200 does NOT mean accepted. */
export interface BatchStatusResponse {
  mt: 31;
  cid?: number | undefined;
  status: Status;
  statuses?: Status[] | undefined;
}

export function parseHistoryPage<T>(raw: unknown, item: z.ZodType<T>): HistoryPage<T> {
  const r = z
    .looseObject({ d: z.array(item).default([]), np: z.union([z.string(), z.number().transform(String)]).optional() })
    .safeParse(raw);
  if (!r.success) throw new Error(`invalid history page: ${zodMessage(r.error)}`);
  return { d: r.data.d, ...(r.data.np ? { np: r.data.np } : {}) };
}

export function parseBatchStatus(raw: unknown): BatchStatusResponse {
  const r = z
    .looseObject({ mt: intLike.optional(), cid: optInt, status: statusSchema, statuses: z.array(statusSchema).optional() })
    .safeParse(raw);
  if (!r.success) throw new Error(`invalid batch status response: ${zodMessage(r.error)}`);
  return { mt: 31, ...(r.data.cid !== undefined ? { cid: r.data.cid } : {}), status: r.data.status, ...(r.data.statuses ? { statuses: r.data.statuses } : {}) };
}

/** Parse a REST snapshot (`mt` 19/23/26/9) with the same logic as the WS frames. */
export function parseSnapshot<T extends ServerFrame>(raw: unknown, mt: T["mt"]): T {
  const parsed = parseServerFrame(typeof raw === "object" && raw !== null ? { mt, ...(raw as object) } : raw);
  if (!parsed.ok) throw new Error(`invalid mt:${mt} snapshot: ${parsed.error}`);
  return parsed.frame as T;
}
