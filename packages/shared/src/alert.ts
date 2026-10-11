import { z } from "zod";
import { ALERT_ACTIONS, type AlertAction, type Side } from "./enums";
import { normalizeMarket } from "./markets";

// ---------------------------------------------------------------------------
// Coercion helpers. TradingView substitutes placeholders as text, so numbers
// frequently arrive as strings ("112034.5") and absent values as "".
// ---------------------------------------------------------------------------

const emptyToUndefined = (v: unknown): unknown =>
  v === null || (typeof v === "string" && v.trim() === "") ? undefined : v;

const toNumber = (v: unknown): unknown => {
  const x = emptyToUndefined(v);
  if (typeof x === "string") {
    const n = Number(x.trim().replace(/,/g, ""));
    return Number.isNaN(n) ? x : n;
  }
  return x;
};

function optionalNumber(inner: z.ZodNumber) {
  return z.preprocess(toNumber, inner.optional()).optional();
}

const toLowerToken = (v: unknown): unknown => {
  const x = emptyToUndefined(v);
  return typeof x === "string" ? x.trim().toLowerCase().replace(/[\s-]+/g, "_") : x;
};

/** ISO string, epoch ms or epoch seconds (number or numeric string) -> epoch ms. */
const toEpochMs = (v: unknown): unknown => {
  const x = emptyToUndefined(v);
  if (x === undefined) return undefined;
  if (typeof x === "number") return x < 1e11 ? Math.round(x * 1000) : Math.round(x);
  if (typeof x === "string") {
    const t = x.trim();
    if (/^\d+(\.\d+)?$/.test(t)) {
      const n = Number(t);
      return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
    }
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? x : ms;
  }
  return x;
};

const optionalString = (max: number) =>
  z
    .preprocess((v) => {
      const x = emptyToUndefined(v);
      return typeof x === "number" ? String(x) : x;
    }, z.string().max(max).optional())
    .optional();

// ---------------------------------------------------------------------------
// Payload schema
// ---------------------------------------------------------------------------

/**
 * The JSON message a TradingView alert sends to `POST /hooks/:strategyId`.
 *
 * - `action`/`market_position` are case-insensitive.
 * - `market` is normalised to a Perpl base symbol ("BINANCE:BTCUSDT.P" -> "BTC"); optional when the
 *   strategy has a default market.
 * - Numbers may be strings. Empty strings count as absent.
 * - `size_usd` (notional) and `size` (base units / contracts) are mutually exclusive. Whether one of
 *   them is required depends on the resolved intent (opens need a size, closes do not) and on the
 *   strategy defaults, so that rule lives in {@link parseAlert}.
 * - `time` is normalised to epoch milliseconds.
 */
export const AlertPayload = z
  .object({
    secret: z.preprocess(
      (v) => (typeof v === "number" ? String(v) : v),
      z.string().min(1, "secret is required").max(512),
    ),
    id: optionalString(200),
    action: z.preprocess(toLowerToken, z.enum(ALERT_ACTIONS)),
    market: z
      .preprocess(
        (v) => (typeof v === "string" ? normalizeMarket(v) || undefined : emptyToUndefined(v)),
        z.string().min(1).max(32).optional(),
      )
      .optional(),
    size_usd: optionalNumber(z.number().positive().finite()),
    size: optionalNumber(z.number().positive().finite()),
    leverage: optionalNumber(z.number().positive().finite()),
    price: optionalNumber(z.number().positive().finite()),
    order_type: z.preprocess(toLowerToken, z.enum(["market", "limit"]).optional()).optional(),
    limit_price: optionalNumber(z.number().positive().finite()),
    max_slippage_bps: optionalNumber(z.number().int().nonnegative().max(10_000)),
    time: z.preprocess(toEpochMs, z.number().int().positive().optional()).optional(),
    market_position: z.preprocess(toLowerToken, z.enum(["long", "short", "flat"]).optional()).optional(),
    comment: optionalString(500),
  })
  .superRefine((p, ctx) => {
    if (p.size_usd !== undefined && p.size !== undefined) {
      ctx.addIssue({ code: "custom", path: ["size"], message: "provide only one of size_usd and size" });
    }
    if (p.order_type === "limit" && p.limit_price === undefined) {
      ctx.addIssue({ code: "custom", path: ["limit_price"], message: "limit_price is required for limit orders" });
    }
  });
export type AlertPayload = z.output<typeof AlertPayload>;

// ---------------------------------------------------------------------------
// Intent resolution
// ---------------------------------------------------------------------------

export type MarketPosition = "long" | "short" | "flat";

export interface Intent {
  /**
   * Position side the alert acts on. `null` only for a generic close ("close" / "flat"):
   * close whichever side is open on that market.
   */
  side: Side | null;
  kind: "open" | "close";
}

/**
 * Resolve what an alert wants to do.
 *
 * Explicit actions (unambiguous, `market_position` is ignored):
 *
 * | action        | side  | kind  |
 * |---------------|-------|-------|
 * | long          | long  | open  |
 * | short         | short | open  |
 * | close_long    | long  | close |
 * | close_short   | short | close |
 * | close / flat  | null  | close |  (closes whatever is open on the market)
 *
 * Strategy placeholder style, `action` = `{{strategy.order.action}}` ("buy" | "sell") and
 * `market_position` = `{{strategy.market_position}}` which TradingView reports as the position
 * AFTER the order filled:
 *
 * | action | market_position   | meaning                                   | side  | kind  |
 * |--------|-------------------|-------------------------------------------|-------|-------|
 * | buy    | (absent) / long   | buy opened or added to a long             | long  | open  |
 * | buy    | flat              | buy brought a short to flat               | short | close |
 * | buy    | short             | buy reduced a short (still short)         | short | close |
 * | sell   | (absent) / short  | sell opened or added to a short           | short | open  |
 * | sell   | flat              | sell brought a long to flat               | long  | close |
 * | sell   | long              | sell reduced a long (still long)          | long  | close |
 *
 * Without `market_position`, plain indicator alerts: buy = open long, sell = open short.
 *
 * Known limitation: a strategy reversal (long -> short in one order) arrives as sell + short and is
 * treated as "open short"; configure the strategy to emit separate close and open alerts.
 */
export function resolveIntent(p: { action: AlertAction; market_position?: MarketPosition | undefined }): Intent {
  switch (p.action) {
    case "long":
      return { side: "long", kind: "open" };
    case "short":
      return { side: "short", kind: "open" };
    case "close_long":
      return { side: "long", kind: "close" };
    case "close_short":
      return { side: "short", kind: "close" };
    case "close":
    case "flat":
      return { side: null, kind: "close" };
    case "buy":
      return p.market_position === "flat" || p.market_position === "short"
        ? { side: "short", kind: "close" }
        : { side: "long", kind: "open" };
    case "sell":
      return p.market_position === "flat" || p.market_position === "long"
        ? { side: "long", kind: "close" }
        : { side: "short", kind: "open" };
  }
}

// ---------------------------------------------------------------------------
// Full parse (schema + intent + strategy defaults + sizing rule)
// ---------------------------------------------------------------------------

export interface StrategyDefaults {
  market?: string | null;
  sizeUsd?: number | null;
  leverage?: number | null;
}

/** A validated, normalised alert. Never carries the secret. */
export interface NormalizedAlert {
  /** Client idempotency key, if the alert supplied one. */
  clientId?: string;
  action: AlertAction;
  intent: Intent;
  /** Base symbol, e.g. "BTC". May be outside the Perpl registry (the risk engine then blocks it). */
  market: string;
  sizeUsd?: number;
  /** Base units / contracts. */
  size?: number;
  leverage?: number;
  /** Chart/alert price, used for slippage reporting. */
  price?: number;
  orderType: "market" | "limit";
  limitPrice?: number;
  maxSlippageBps?: number;
  /** Alert time (epoch ms), if the alert carried one. */
  timeMs?: number;
  marketPosition?: MarketPosition;
  comment?: string;
}

export interface AlertIssue {
  path: string;
  message: string;
}

export type ParseAlertResult =
  | { ok: true; value: NormalizedAlert }
  | { ok: false; issues: AlertIssue[] };

export function parseAlert(raw: unknown, defaults: StrategyDefaults = {}): ParseAlertResult {
  const parsed = AlertPayload.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  }
  const p = parsed.data;
  const intent = resolveIntent(p);
  const issues: AlertIssue[] = [];

  const market = p.market ?? (defaults.market ? normalizeMarket(defaults.market) : undefined);
  if (!market) issues.push({ path: "market", message: "market is required (no strategy default set)" });

  let sizeUsd = p.size_usd;
  const size = p.size;
  if (intent.kind === "open" && sizeUsd === undefined && size === undefined) {
    if (defaults.sizeUsd && defaults.sizeUsd > 0) sizeUsd = defaults.sizeUsd;
    else issues.push({ path: "size_usd", message: "exactly one of size_usd or size is required for an opening order" });
  }
  if (issues.length > 0 || market === undefined) return { ok: false, issues };

  const leverage = p.leverage ?? (defaults.leverage && defaults.leverage > 0 ? defaults.leverage : undefined);

  const value: NormalizedAlert = {
    action: p.action,
    intent,
    market,
    orderType: p.order_type ?? "market",
  };
  if (p.id !== undefined) value.clientId = p.id;
  if (sizeUsd !== undefined) value.sizeUsd = sizeUsd;
  if (size !== undefined) value.size = size;
  if (leverage !== undefined) value.leverage = leverage;
  if (p.price !== undefined) value.price = p.price;
  if (p.limit_price !== undefined) value.limitPrice = p.limit_price;
  if (p.max_slippage_bps !== undefined) value.maxSlippageBps = p.max_slippage_bps;
  if (p.time !== undefined) value.timeMs = p.time;
  if (p.market_position !== undefined) value.marketPosition = p.market_position;
  if (p.comment !== undefined) value.comment = p.comment;
  return { ok: true, value };
}
