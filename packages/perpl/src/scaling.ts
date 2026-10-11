/**
 * Price / size / leverage / amount conversions. Everything that reaches the wire is an integer; conversions go through
 * decimal STRINGS and bigint so there is no binary floating point drift (0.1 + 0.2 style) in what we send.
 *
 *  - price  : scaled by market `price_decimals`   (BTC testnet: 1 => $112,000.0 = 1120000)
 *  - size   : scaled by market `size_decimals`    (BTC testnet: 5 => 0.001 BTC = 100 lots)
 *  - amount : AUSD, 6 decimals ("CNS")            ($100 = 100000000)
 *  - leverage: hundredths (500 = 5x)
 *
 * The protocol has no separate tick / lot size: the tick is 10^-price_decimals and the lot is 10^-size_decimals, so
 * "rounding to tick/lot" is rounding to the scaled integer grid (optionally a multiple of it).
 */

export type RoundMode = "floor" | "ceil" | "round";

/** Collateral token (AUSD) decimals on testnet. Read the real value from the context token list when you can. */
export const COLLATERAL_DECIMALS = 6;

/** Everything the order path needs to know about a market, derived from `/v1/pub/context` (see `marketSpecFromContext`). */
export interface MarketSpec {
  id: number;
  symbol: string;
  name: string;
  /** Protocol instance this market belongs to; pick the account whose `in` equals this. */
  instanceId: number;
  perpetualId: number;
  priceDecimals: number;
  sizeDecimals: number;
  /** `config.initial_margin` = maximum leverage x 100 (1500 = 15x). */
  maxLeverageHdths: number;
  /** `config.maintenance_margin`. */
  maintenanceMarginHdths: number;
  /** `order_ttl_blocks`: ceiling of `lb - head`, and the window the server substitutes for `lb: 0`. */
  orderTtlBlocks: number;
  orderRetryBlocks: number;
  /** `order_max_market_slippage_bps`: upper bound of `ms`. */
  maxSlippageBps: number;
  /** `order_max_neg_pnl_collat_bps`: default `mnp`. */
  maxNegPnlCollatBps: number;
  isOpen: boolean;
  /** Fee micros per tier (index = Account.ft). Falls back to the base entry when the arrays are absent. */
  makerFeesMicros: number[];
  takerFeesMicros: number[];
  /** Base-tier fees in micros. */
  makerFeeMicros: number;
  takerFeeMicros: number;
  /** `config.recycle_fee`, AUSD x 10^6. */
  recycleFee: string;
  fundingIntervalBlocks: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// Decimal string plumbing
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Plain decimal string for a number / string / bigint (no exponent). Numbers are first normalised to 15 significant
 * digits, which removes binary noise such as 0.30000000000000004 and 0.0036899999999999997 without losing any real digit.
 */
export function toDecimalString(v: number | string | bigint): string {
  if (typeof v === "bigint") return v.toString();
  let s: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new RangeError(`not a finite number: ${v}`);
    s = String(Number(v.toPrecision(15)));
  } else {
    s = v.trim();
  }
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m || (!m[2] && !m[3])) throw new RangeError(`not a decimal number: "${s}"`);
  const sign = m[1] === "-" ? "-" : "";
  let int = m[2] ?? "";
  let frac = m[3] ?? "";
  const exp = m[4] ? parseInt(m[4], 10) : 0;
  if (exp > 0) {
    if (frac.length <= exp) {
      int += frac.padEnd(exp, "0");
      frac = "";
    } else {
      int += frac.slice(0, exp);
      frac = frac.slice(exp);
    }
  } else if (exp < 0) {
    const shift = -exp;
    const padded = int.padStart(shift + 1, "0");
    frac = padded.slice(padded.length - shift) + frac;
    int = padded.slice(0, padded.length - shift);
  }
  int = int.replace(/^0+(?=\d)/, "") || "0";
  frac = frac.replace(/0+$/, "");
  return sign + int + (frac ? "." + frac : "");
}

/** Scale a non-negative decimal by 10^decimals into a bigint, rounding per `mode`. */
export function toScaled(value: number | string | bigint, decimals: number, mode: RoundMode = "round"): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new RangeError(`bad decimals ${decimals}`);
  const s = toDecimalString(value);
  if (s.startsWith("-")) {
    if (/^-0(\.0*)?$/.test(s)) return 0n;
    throw new RangeError(`negative value not allowed: ${s}`);
  }
  const [int = "0", frac = ""] = s.split(".");
  const kept = frac.slice(0, decimals).padEnd(decimals, "0");
  const rest = frac.slice(decimals);
  let n = BigInt(int + kept);
  if (rest) {
    const nonZero = /[1-9]/.test(rest);
    if (mode === "ceil" && nonZero) n += 1n;
    else if (mode === "round" && rest.charCodeAt(0) >= 53 /* '5' */) n += 1n;
  }
  return n;
}

/** {@link toScaled} as a JS number for wire fields. Throws if it does not fit a safe integer. */
export function toScaledNumber(value: number | string | bigint, decimals: number, mode: RoundMode = "round"): number {
  const n = toScaled(value, decimals, mode);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`scaled value ${n} exceeds the safe integer range`);
  return Number(n);
}

/** Exact decimal string for a scaled integer: `formatScaled(1120005n, 1)` = "112000.5". */
export function formatScaled(scaled: bigint | number | string, decimals: number): string {
  const big = typeof scaled === "bigint" ? scaled : BigInt(typeof scaled === "number" ? Math.trunc(scaled) : scaled.trim() || "0");
  const neg = big < 0n;
  const digits = (neg ? -big : big).toString().padStart(decimals + 1, "0");
  const int = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return (neg ? "-" : "") + int + (frac ? "." + frac : "");
}

/** Scaled integer to a JS number (fine for display / PnL maths, not for wire values). */
export function fromScaled(scaled: bigint | number | string, decimals: number): number {
  if (typeof scaled === "number" && Number.isSafeInteger(scaled)) return scaled / 10 ** decimals;
  return Number(formatScaled(scaled, decimals));
}

// ---------------------------------------------------------------------------------------------------------------------
// Price / size
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Round a human price to the market grid. `tickMultiple` > 1 snaps to a coarser grid (multiples of the base tick);
 * the default 1 means "any scaled integer".
 */
export function priceToTicks(price: number | string, priceDecimals: number, mode: RoundMode = "round", tickMultiple = 1): number {
  return snap(toScaled(price, priceDecimals, mode), tickMultiple, mode);
}

/** Round a human size to whole lots (default: DOWN, never exceed what the caller asked for). */
export function sizeToLots(size: number | string, sizeDecimals: number, mode: RoundMode = "floor", lotMultiple = 1): number {
  return snap(toScaled(size, sizeDecimals, mode), lotMultiple, mode);
}

function snap(n: bigint, multiple: number, mode: RoundMode): number {
  if (!Number.isInteger(multiple) || multiple < 1) throw new RangeError("tick/lot multiple must be a positive integer");
  const m = BigInt(multiple);
  let r = n;
  if (m > 1n) {
    const rem = n % m;
    if (rem !== 0n) {
      if (mode === "floor") r = n - rem;
      else if (mode === "ceil") r = n + (m - rem);
      else r = rem * 2n >= m ? n + (m - rem) : n - rem;
    }
  }
  if (r > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("scaled value exceeds the safe integer range");
  return Number(r);
}

/**
 * Lots for a USD notional at a price: `floor(notional / price * 10^sizeDecimals)` in bigint arithmetic.
 * Returns 0 when the notional is too small for one lot (callers must reject 0).
 */
export function lotsForNotional(notionalUsd: number | string, priceHuman: number | string, sizeDecimals: number, mode: RoundMode = "floor"): number {
  const D = 12;
  const n = toScaled(notionalUsd, D, "round");
  const p = toScaled(priceHuman, D, "round");
  if (p === 0n) throw new RangeError("price must be > 0");
  const num = n * 10n ** BigInt(sizeDecimals);
  let q = num / p;
  const rem = num % p;
  if (mode === "ceil" && rem !== 0n) q += 1n;
  else if (mode === "round" && rem * 2n >= p) q += 1n;
  if (q > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("lot count exceeds the safe integer range");
  return Number(q);
}

/** USD notional of a scaled size at a scaled price (floating point, for display and risk maths). */
export function notionalUsd(sizeScaled: number | bigint | string, priceScaled: number | bigint | string, m: Pick<MarketSpec, "sizeDecimals" | "priceDecimals">): number {
  return fromScaled(sizeScaled, m.sizeDecimals) * fromScaled(priceScaled, m.priceDecimals);
}

/** Slippage in bps, positive = worse for the trader. A buy that fills above the reference, or a sell below it, is positive. */
export function slippageBps(reference: number, fill: number, direction: "buy" | "sell"): number {
  if (!(reference > 0)) return 0;
  const raw = ((fill - reference) / reference) * 10_000;
  return direction === "buy" ? raw : -raw;
}

// ---------------------------------------------------------------------------------------------------------------------
// Leverage
// ---------------------------------------------------------------------------------------------------------------------

/** 5 -> 500. Rounds to the nearest hundredth. */
export function leverageToHundredths(leverage: number | string): number {
  return toScaledNumber(leverage, 2, "round");
}

/** 500 -> 5. */
export function hundredthsToLeverage(hundredths: number): number {
  return hundredths / 100;
}

/** Checks `100 <= lv <= market.maxLeverageHdths`. Returns an error message or undefined. */
export function checkLeverage(lvHdths: number, m: Pick<MarketSpec, "maxLeverageHdths" | "symbol">): string | undefined {
  if (!Number.isInteger(lvHdths) || lvHdths < 100) return `leverage must be at least 1x (got ${lvHdths / 100}x)`;
  if (lvHdths > m.maxLeverageHdths) return `${m.symbol} allows at most ${m.maxLeverageHdths / 100}x leverage (got ${lvHdths / 100}x)`;
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Collateral amounts (AUSD, 6 dp)
// ---------------------------------------------------------------------------------------------------------------------

/** 100 -> 100000000n. */
export function ausdToCns(amount: number | string, decimals = COLLATERAL_DECIMALS, mode: RoundMode = "round"): bigint {
  return toScaled(amount, decimals, mode);
}

/** "100000000" -> 100. Accepts negative integers (PnL, rebates). */
export function cnsToAusd(cns: bigint | number | string, decimals = COLLATERAL_DECIMALS): number {
  return fromScaled(cns, decimals);
}

// ---------------------------------------------------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------------------------------------------------

/** Fee rate in micros for an account fee tier; falls back to the base entry when the tier arrays are missing / short. */
export function feeMicrosFor(m: Pick<MarketSpec, "makerFeesMicros" | "takerFeesMicros" | "makerFeeMicros" | "takerFeeMicros">, feeTier: number, isMaker: boolean): number {
  const tiers = isMaker ? m.makerFeesMicros : m.takerFeesMicros;
  const base = isMaker ? m.makerFeeMicros : m.takerFeeMicros;
  return Number.isInteger(feeTier) && feeTier >= 0 ? (tiers[feeTier] ?? base) : base;
}

/** `notional * micros / 1e6`, in the same unit as `notionalCns` (bigint-safe, rounds half up). */
export function feeFromNotional(notionalCns: bigint, micros: number): bigint {
  const prod = notionalCns * BigInt(micros);
  return (prod + 500_000n) / 1_000_000n;
}
