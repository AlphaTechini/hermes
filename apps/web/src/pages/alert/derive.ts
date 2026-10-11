/**
 * Everything the alert detail view derives from an `AlertDetail`: the risk check list, the headline numbers, the
 * best-effort fields of a message that never got parsed. Pure functions, no React.
 *
 * The server stores what happened: `riskChecks` (the result of every rule, `passed: null` for rules that did not run),
 * `orders[].frames` (the raw Perpl frames) and the alert events. Nothing here invents evidence: a check that did not run
 * is shown as not run, and an alert that never reached the risk gate has "Not checked", never a green tick.
 */
import { MARKETS, ALERT_ACTIONS, normalizeMarket, resolveIntent, type AlertAction, type AlertDetail, type AlertEventDTO, type NormalizedAlert, type Order, type RiskCheckResult, type RiskLimits } from "@hermes/shared";
import { Hand } from "lucide-react";
import type { CheckItem } from "../../components/ui";
import type { SideKind } from "../../lib/alert-view";
import { formatBps, formatLeverageX, formatPrice, formatUsd } from "../../lib/format";

export const PERPL_EXCHANGE = "0x1964c32f0be608e7d29302aff5e61268e72080cc";

export const parsedOf = (d: AlertDetail): Partial<NormalizedAlert> => (d.parsed ?? {}) as Partial<NormalizedAlert>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const first = (d: AlertDetail, status: string): AlertEventDTO | undefined => d.events.find((e) => e.status === status);

export const isFilled = (d: Pick<AlertDetail, "status">) => d.status === "filled" || d.status === "partially_filled";
/** Reached the order stage: an order exists and was written to the socket. */
export const wasSent = (d: AlertDetail) => d.events.some((e) => e.status === "sent");

/** `trade`: an order was (or will be) sent. `blocked`: a limit stopped it. `dropped`: never past Verified. `dry_run`: every check ran, nothing sent. */
export type Variant = "trade" | "blocked" | "dropped" | "dry_run";
export function variantOf(d: AlertDetail): Variant {
  if (d.status === "blocked") return "blocked";
  if (d.status === "dry_run") return "dry_run";
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

/**
 * The slippage cap the order was sent with. The sent frame's `ms` is the truth; before an order exists it is the alert's own
 * `max_slippage_bps`, else the account default.
 */
export function maxSlippageOf(d: AlertDetail, limits: RiskLimits | undefined, sentMs?: number | null): number | null {
  return sentMs ?? parsedOf(d).maxSlippageBps ?? limits?.defaultSlippageBps ?? null;
}

export function orderTypeText(o: Order | undefined, d: AlertDetail): string {
  const kind = o?.kind ?? d.kind;
  const side = o?.side ?? d.side;
  const dir = kind === "close" ? (side ? `Close ${side}` : "Close") : side === "short" ? "Open short" : "Open long";
  const how = (o?.type ?? parsedOf(d).orderType ?? "market") === "limit" ? "good till cancelled" : "immediate or cancel";
  return `${dir}, ${how}`;
}

// --- fields of a message that was never parsed ------------------------------------------------------

export interface PayloadView {
  side: SideKind | null;
  market: string | null;
  /** Requested notional, USD, or `size x price` when only base units were sent. */
  sizeUsd: number | null;
  /** Base units when the message sent `size`. */
  size: number | null;
  price: number | null;
  leverage: number | null;
}

const asNum = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v.trim().replace(/,/g, "")) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Best-effort reading of the raw message, for alerts that stopped before Hermes parsed them (invalid, duplicate, bad
 * secret). Shown labelled "From the message, not verified". Fields the message does not carry stay null.
 */
export function payloadView(d: Pick<AlertDetail, "rawBody">): PayloadView {
  const empty: PayloadView = { side: null, market: null, sizeUsd: null, size: null, price: null, leverage: null };
  let j: Record<string, unknown>;
  try {
    const parsed = JSON.parse(d.rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
    j = parsed as Record<string, unknown>;
  } catch {
    return empty;
  }
  const rawAction = typeof j.action === "string" ? j.action.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  const action = (ALERT_ACTIONS as readonly string[]).includes(rawAction) ? (rawAction as AlertAction) : null;
  const mp = typeof j.market_position === "string" ? j.market_position.trim().toLowerCase() : undefined;
  let side: SideKind | null = null;
  if (action) {
    const intent = resolveIntent({ action, ...(mp === "long" || mp === "short" || mp === "flat" ? { market_position: mp } : {}) });
    side = intent.kind === "close" ? (intent.side === "long" ? "close-long" : intent.side === "short" ? "close-short" : "close") : intent.side === "short" ? "short" : "long";
  }
  const tickerRaw = typeof j.market === "string" ? j.market : typeof j.ticker === "string" ? j.ticker : "";
  const market = tickerRaw ? normalizeMarket(tickerRaw) || null : null;
  const price = asNum(j.price);
  const size = asNum(j.size);
  const sizeUsd = asNum(j.size_usd) ?? (size !== null && price !== null ? size * price : null);
  return { side, market, sizeUsd, size, price, leverage: asNum(j.leverage) };
}

// --- risk checks -----------------------------------------------------------------------

export interface ChecksResult {
  items: CheckItem[];
  /** Rules that ran and passed. */
  passed: number;
  /** Rules that ran and failed (plus a rejected or expired approval). */
  failed: number;
  /** Rules that did not run: closes ignore the limits on new exposure, and the engine stops at the first failure. */
  skipped: number;
  /** Rules that ran: passed + failed. */
  evaluated: number;
  /** Every row in `items`. */
  total: number;
  /** Name of the failing check, for the timeline text. */
  failedName: string | null;
  /**
   * True when no check ran at all: the alert never reached the risk gate (invalid, duplicate, bad secret) or is still
   * before it. Then `items` is empty and the card says so, instead of listing checks as passed.
   */
  notChecked: boolean;
  /** Why nothing ran, for the empty state. */
  notCheckedWhy: string | null;
  /** The card meta: `11 passed`, `1 failed · 8 passed`, `Not checked`. */
  meta: { failed: number; passed: number; skipped: number } | "Not checked";
}

const usd0 = (v: number | null) => formatUsd(v, { decimals: 0 });
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** Server texts use an ASCII hyphen for negatives; the UI uses U+2212. */
const clean = (t: string) => t.replace(/-\$/g, "\u2212$");

/** `25x`, `2.5x`: whole numbers without a decimal, in the callout and in the check row alike. */
const lev = (v: unknown): string => (isNum(v) ? formatLeverageX(v) : "n/a");

function describeCheck(c: RiskCheckResult, d: AlertDetail): { detail: string; value: string } {
  const v = c.value;
  const l = c.limit;
  const state = c.skipped || c.passed === null ? "skip" : c.passed ? "pass" : "fail";
  if (state === "skip") return { detail: c.detail ? clean(c.detail) : "Not run", value: "n/a" };
  const money = (x: unknown) => (isNum(x) ? usd0(x) : "n/a");
  switch (c.key) {
    case "strategy_enabled":
      return { detail: state === "fail" ? "The strategy is off" : (d.strategyName ?? "Strategy"), value: String(v ?? "n/a") };
    case "alert_age":
      return {
        detail: state === "fail" ? `The alert was ${isNum(v) ? v : "n/a"} s old when Hermes checked it` : "Time since the alert was sent",
        value: `${isNum(v) ? `${v} s` : "n/a"} / ${isNum(l) ? `${l} s` : "n/a"}`,
      };
    case "rate_limit":
      return { detail: state === "fail" ? "Too many orders in the last minute" : "Orders in the last minute", value: `${isNum(v) ? v : "n/a"} / ${isNum(l) ? l : "n/a"}` };
    case "perpl_connected":
      return { detail: state === "fail" ? "Perpl was not connected" : "Trading socket", value: String(v ?? "n/a") };
    case "position_to_close":
      return { detail: state === "fail" ? (c.detail ? clean(c.detail) : "No open position to close") : "Open position found", value: typeof v === "string" ? v : "n/a" };
    case "pause":
      return { detail: state === "fail" ? "Trading is paused" : "Trading switch", value: String(v ?? "n/a") };
    case "markets": {
      const m = typeof v === "string" ? v : "n/a";
      return { detail: m === "n/a" ? "Market not known" : state === "fail" ? `${m} is not in your allowed markets` : `${m} is on your list`, value: m };
    }
    case "daily_loss":
      return { detail: state === "fail" ? "Loss today reached your stop" : "Loss so far today", value: `${money(v)} / ${isNum(l) ? usd0(l) : "off"}` };
    case "size_known":
      return { detail: state === "fail" ? "Hermes could not work out the order size" : "Order notional", value: money(v) };
    case "leverage":
      return {
        detail: state === "fail" ? "The alert asked for more than your limit" : v === null ? "Not set by the alert" : "Requested by the alert",
        value: `${v === null ? "n/a" : lev(v)} / ${lev(l)}`,
      };
    case "size":
      // The limit applies to the position after the order, not to the order itself.
      return { detail: "Position after this order", value: `${money(v)} / ${money(l)}` };
    case "approval": {
      const over = c.detail?.startsWith("Above") ?? (isNum(v) && isNum(l) && l > 0 && v >= l);
      return { detail: over ? "Above the threshold, waits for you" : "Order notional", value: `${money(v)} / ${isNum(l) && l > 0 ? usd0(l) : "off"}` };
    }
    default:
      return { detail: c.detail ? clean(c.detail) : "", value: v === null || v === undefined ? "n/a" : String(v) };
  }
}

/**
 * The risk check list, straight from the server's per rule results (`detail.riskChecks`). Failed checks first, then the
 * rest in engine order. A rule with `passed: null` is shown as not run, never as passed.
 */
export function riskChecks(d: AlertDetail): ChecksResult {
  const raw = Array.isArray(d.riskChecks) ? d.riskChecks : null;
  if (!raw || raw.length === 0) {
    const early = d.status === "duplicate" || d.status === "rejected_auth" || d.status === "invalid";
    const beforeGate = d.status === "received" || d.status === "verified";
    return {
      items: [],
      passed: 0,
      failed: 0,
      skipped: 0,
      evaluated: 0,
      total: 0,
      failedName: null,
      notChecked: true,
      notCheckedWhy: early
        ? "The alert did not pass verification, so no limit was checked."
        : beforeGate
          ? "The checks have not run yet."
          : "Hermes did not store the check results for this alert.",
      meta: "Not checked",
    };
  }

  const items: CheckItem[] = raw.map((c) => {
    const state: CheckItem["state"] = c.skipped || c.passed === null ? "skip" : c.passed ? "pass" : "fail";
    const { detail, value } = describeCheck(c, d);
    const aboveThreshold = c.key === "approval" && state === "pass" && Boolean(c.detail?.startsWith("Above"));
    return { name: c.label, detail, value, state, ...(aboveThreshold ? { icon: Hand } : {}) };
  });

  // A human decision after the gate is not a rule, but it is why an alert stopped. List it as the failing row.
  if (d.blockReason === "approval_rejected") items.unshift({ name: "Approval", detail: "You rejected the order", value: "Rejected", state: "fail" });
  else if (d.status === "expired" || d.blockReason === "approval_expired") items.unshift({ name: "Approval", detail: "Not approved in time", value: "Expired", state: "fail" });

  const failedItems = items.filter((i) => i.state === "fail");
  const ordered = [...failedItems, ...items.filter((i) => i.state !== "fail")];
  const passed = ordered.filter((i) => i.state === "pass").length;
  const skipped = ordered.filter((i) => i.state === "skip").length;
  return {
    items: ordered,
    passed,
    failed: failedItems.length,
    skipped,
    evaluated: passed + failedItems.length,
    total: ordered.length,
    failedName: failedItems.length ? String(failedItems[0]?.name) : null,
    notChecked: false,
    notCheckedWhy: null,
    meta: { failed: failedItems.length, passed, skipped },
  };
}

/** The `ms` of the order frame that was sent, bps. Null when no frame is recorded. */
export const sentMaxSlippage = (frame: { fields: Record<string, unknown> } | null): number | null => (frame && isNum(frame.fields.ms) ? frame.fields.ms : null);

/** `market` id to symbol, for frame comments. */
export const symbolOfMarketId = (id: unknown): string | null => (Object.values(MARKETS).find((m) => m.id === id)?.symbol ?? null);

export { formatBps, formatPrice };
export type { Order };
