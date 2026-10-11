/**
 * The one formatting module (DESIGN.md section 8). Never format numbers, times or hashes inline.
 *
 * Rules that apply everywhere:
 *  - en-US grouping regardless of the browser locale, so columns stay consistent.
 *  - Minus is U+2212 (`−`), never a hyphen. Truncation is U+2026 (`…`).
 *  - Unknown values render as `n/a` (use {@link orNA}); never `-`, `—` or `0`.
 */

export const MINUS = "−";
export const ELLIPSIS = "…";
export const NA = "n/a";
export const EXPLORER_BASE = "https://testnet.monadexplorer.com";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Returns `n/a` when the value is null, undefined or not finite; otherwise runs the formatter. */
export function orNA<T>(value: T | null | undefined, fmt: (v: T) => string): string {
  if (value === null || value === undefined) return NA;
  if (typeof value === "number" && !Number.isFinite(value)) return NA;
  return fmt(value);
}

// --- number plumbing -----------------------------------------------------------------

const nfCache = new Map<string, Intl.NumberFormat>();
function nf(min: number, max = min, extra: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = `${min}:${max}:${JSON.stringify(extra)}`;
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max, ...extra });
    nfCache.set(key, f);
  }
  return f;
}

/** Groups and fixes decimals. Negative numbers use U+2212. */
export function formatNumber(value: number, decimals = 0): string {
  if (!isNum(value)) return NA;
  const s = nf(decimals).format(Math.abs(value));
  const isZero = Number(s.replace(/,/g, "")) === 0;
  return value < 0 && !isZero ? MINUS + s : s;
}

// --- markets -------------------------------------------------------------------------

/** Fallback decimals when Perpl `pub/context` has not been read (DESIGN.md section 8). */
const PRICE_DECIMALS: Record<string, number> = { BTC: 1, ETH: 2, SOL: 3, MON: 6, ZEC: 2 };
const SIZE_DECIMALS: Record<string, number> = { BTC: 3, ETH: 2, SOL: 1, MON: 0, ZEC: 1 };

/** Override the fallbacks with decimals derived from Perpl `pub/context` (tick and lot size). */
export function registerMarketDecimals(market: string, decimals: { price?: number; size?: number }): void {
  const m = market.toUpperCase();
  if (decimals.price !== undefined) PRICE_DECIMALS[m] = decimals.price;
  if (decimals.size !== undefined) SIZE_DECIMALS[m] = decimals.size;
}

export const priceDecimals = (market?: string | null): number => PRICE_DECIMALS[(market ?? "").toUpperCase()] ?? 2;
export const sizeDecimals = (market?: string | null): number => SIZE_DECIMALS[(market ?? "").toUpperCase()] ?? 2;

/** `112,048.5` `4,098.62` `210.412` `0.040118`. No currency sign. */
export function formatPrice(value: number | null | undefined, market?: string | null): string {
  return orNA(value, (v) => formatNumber(v, priceDecimals(market)));
}

/** Base units with the market's lot decimals: `0.050` `1.20` `140.0` `150,000`. */
export function formatSize(value: number | null | undefined, market?: string | null): string {
  return orNA(value, (v) => formatNumber(v, sizeDecimals(market)));
}

// --- money ---------------------------------------------------------------------------

export interface UsdOptions {
  /** Tiles and summaries: drop cents at >= $10,000 and compact at >= $1M (`$1.28M`). */
  summary?: boolean;
  /** Force a number of decimals (overrides `summary`). */
  decimals?: number;
}

/** `$5,602.43`. With `summary`: `$29,458`, `$1.28M`. */
export function formatUsd(value: number | null | undefined, opts: UsdOptions = {}): string {
  return orNA(value, (v) => {
    const sign = v < 0 && Math.round(Math.abs(v) * 100) > 0 ? MINUS : "";
    const abs = Math.abs(v);
    if (opts.decimals !== undefined) return `${sign}$${nf(opts.decimals).format(abs)}`;
    if (opts.summary) {
      if (abs >= 1_000_000) return `${sign}$${nf(2).format(abs / 1_000_000)}M`;
      if (abs >= 10_000) return `${sign}$${nf(0).format(abs)}`;
    }
    return `${sign}$${nf(2).format(abs)}`;
  });
}

/** Always signed, U+2212 for negatives, sign before the `$`: `+$22.05` `−$137.20`. Zero is `$0.00`. */
export function formatSignedUsd(value: number | null | undefined, opts: UsdOptions = {}): string {
  return orNA(value, (v) => {
    const body = formatUsd(Math.abs(v), opts);
    if (Math.round(Math.abs(v) * 100) === 0) return body;
    return (v < 0 ? MINUS : "+") + body;
  });
}

/** Tone for a PnL value: positive, negative or neutral at zero. */
export function pnlTone(value: number | null | undefined): "positive" | "negative" | "neutral" {
  if (!isNum(value) || Math.round(Math.abs(value) * 100) === 0) return "neutral";
  return value > 0 ? "positive" : "negative";
}

/** `91.2%`; with `signed`: `+0.37%` `−0.13%`. Input is already a percent (91.2), not a fraction. */
export function formatPercent(value: number | null | undefined, opts: { signed?: boolean; decimals?: number } = {}): string {
  return orNA(value, (v) => {
    const d = opts.decimals ?? 1;
    const s = nf(d).format(Math.abs(v));
    const zero = Number(s.replace(/,/g, "")) === 0;
    const sign = zero ? "" : v < 0 ? MINUS : opts.signed ? "+" : "";
    return `${sign}${s}%`;
  });
}

/** Same as {@link formatPercent} for a 0..1 fraction (server `fillRate`). */
export const formatFraction = (value: number | null | undefined, opts: { signed?: boolean; decimals?: number } = {}): string =>
  formatPercent(isNum(value) ? value * 100 : value, opts);

// --- slippage and latency ------------------------------------------------------------

/**
 * Basis points, 1 decimal: `1.6 bps`, `−0.4 bps`. Positive means WORSE than the alert price (see
 * `slippageBps` in @hermes/shared). `{ signed: true }` forces a `+` on positive values.
 */
export function formatBps(value: number | null | undefined, opts: { signed?: boolean; decimals?: number } = {}): string {
  return orNA(value, (v) => {
    const s = nf(opts.decimals ?? 1).format(Math.abs(v));
    const zero = Number(s) === 0;
    const sign = zero ? "" : v < 0 ? MINUS : opts.signed ? "+" : "";
    return `${sign}${s} bps`;
  });
}

export type SlippageTone = "better" | "neutral" | "warning";
/** Better than the alert price: positive color. Over the strategy cap: warning. Otherwise neutral (a cost). */
export function slippageTone(bps: number | null | undefined, maxBps?: number | null): SlippageTone {
  if (!isNum(bps)) return "neutral";
  if (bps < 0) return "better";
  if (isNum(maxBps) && bps > maxBps) return "warning";
  return "neutral";
}
export const SLIPPAGE_BETTER_TITLE = (bps: number): string => `Filled ${nf(1).format(Math.abs(bps))} bps better than the alert price`;

/** `<1 ms`, `612 ms`, `1.24 s` (2 decimals at or above 1 s). */
export function formatMs(ms: number | null | undefined): string {
  return orNA(ms, (v) => {
    const a = Math.abs(v);
    if (a < 1) return "<1 ms";
    if (Math.round(a) < 1000) return `${Math.round(a)} ms`;
    return `${nf(2).format(a / 1000)} s`;
  });
}

/** Pipeline stage delta: `0 ms` for the first stage, `+184 ms`, `+1.24 s`, `<1 ms`. */
export function formatDeltaMs(ms: number | null | undefined, opts: { first?: boolean } = {}): string {
  return orNA(ms, (v) => {
    if (opts.first) return "0 ms";
    if (v < 1) return "<1 ms";
    if (Math.round(v) < 1000) return `+${Math.round(v)} ms`;
    return `+${nf(2).format(v / 1000)} s`;
  });
}

/** Leverage from Perpl `lv` (hundredths): `500` -> `5.0x`. */
export function formatLeverage(lv: number | null | undefined): string {
  return orNA(lv, (v) => `${nf(1).format(v / 100)}x`);
}
/** Leverage as a plain multiplier, used by limits: `10x`, `5.0x` when fractional. */
export function formatLeverageX(x: number | null | undefined, opts: { decimals?: number } = {}): string {
  return orNA(x, (v) => `${nf(opts.decimals ?? (Number.isInteger(v) ? 0 : 1)).format(v)}x`);
}

/** `1:42`, `0:38`. Input in seconds. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** `41,822,907` */
export const formatBlock = (n: number | null | undefined): string => orNA(n, (v) => nf(0).format(v));
/** `rq 1,904,233` */
export const formatPerplId = (prefix: string, n: number | null | undefined): string => orNA(n, (v) => `${prefix} ${nf(0).format(v)}`);

// --- time ----------------------------------------------------------------------------

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Local 24h `14:32:18.904` (stream and timeline). */
export function formatClock(ts: number | null | undefined, opts: { ms?: boolean } = {}): string {
  const ms = opts.ms ?? true;
  return orNA(ts, (t) => {
    const d = new Date(t);
    const base = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return ms ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
  });
}

/** `11 Oct 22:31` */
export function formatDateTime(ts: number | null | undefined): string {
  return orNA(ts, (t) => {
    const d = new Date(t);
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
}

/** `11 Oct 2026` */
export function formatDate(ts: number | null | undefined): string {
  return orNA(ts, (t) => {
    const d = new Date(t);
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  });
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Tables: `HH:mm:ss` today, `11 Oct 22:31` for older days. */
export function formatTableTime(ts: number | null | undefined, now: number = Date.now()): string {
  return orNA(ts, (t) => (sameDay(new Date(t), new Date(now)) ? formatClock(t, { ms: false }) : formatDateTime(t)));
}

/** `now` (< 2 s), `12s ago`, `4m ago`, `3h ago`, then the date (`11 Oct 22:31`). */
export function formatRelativeTime(ts: number | null | undefined, now: number = Date.now()): string {
  return orNA(ts, (t) => {
    const s = Math.floor((now - t) / 1000);
    if (s < 2) return "now";
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return formatDateTime(t);
  });
}

/** `2026-10-11 13:32:07.412 UTC`, for `title` attributes. */
export function formatUtc(ts: number | null | undefined): string {
  return orNA(ts, (t) => {
    const d = new Date(t);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)} UTC`;
  });
}

/** `WAT (UTC+1)`, shown once per view: "times in WAT (UTC+1)". Falls back to just `UTC+1`. */
export function formatTimeZone(date: Date = new Date()): string {
  const off = -date.getTimezoneOffset();
  const sign = off < 0 ? MINUS : "+";
  const h = Math.floor(Math.abs(off) / 60);
  const m = Math.abs(off) % 60;
  const utc = `UTC${off === 0 ? "" : `${sign}${h}${m ? `:${pad(m)}` : ""}`}`;
  let abbr = "";
  try {
    abbr = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    /* ignore */
  }
  if (!abbr || /^(GMT|UTC)[+\-−]?\d*/.test(abbr)) return utc;
  return `${abbr} (${utc})`;
}

// --- addresses, hashes, links ---------------------------------------------------------

/** `0x7a3F…91c2`: `0x` + 4 + `…` + 4. Short values are returned whole. */
export function shortHex(value: string | null | undefined, head = 4, tail = 4): string {
  return orNA(value, (v) => {
    if (v.length <= 2 + head + tail + 1) return v;
    return `${v.slice(0, 2 + head)}${ELLIPSIS}${v.slice(-tail)}`;
  });
}
export const shortAddress = shortHex;

/** Hermes record ids, shortened so they read as an id and not as a cut-off sentence: `alr_fXS7eJLw7FJxyz` -> `alr_fXS7…xyz`. */
export function shortId(value: string | null | undefined, head = 8, tail = 3): string {
  return orNA(value, (v) => (v.length <= head + tail + 1 ? v : `${v.slice(0, head)}${ELLIPSIS}${v.slice(-tail)}`));
}
export const shortHash = shortHex;

export const explorerTxUrl = (hash: string): string => `${EXPLORER_BASE}/tx/${hash}`;
export const explorerAddressUrl = (address: string): string => `${EXPLORER_BASE}/address/${address}`;

/** `••••••••••••••••••••hx2K`: mask everything except the last 4 characters. */
export function maskSecret(secret: string, visible = 4, bullets = 20): string {
  return "•".repeat(bullets) + secret.slice(-visible);
}
