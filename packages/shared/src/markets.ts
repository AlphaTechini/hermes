/** Perpl testnet market registry. `decimals` are filled from `GET /v1/pub/context` at runtime. */
export const MARKET_SYMBOLS = ["BTC", "ETH", "SOL", "MON", "ZEC"] as const;
export type MarketSymbol = (typeof MARKET_SYMBOLS)[number];

export interface MarketInfo {
  symbol: MarketSymbol;
  /** Perpl market id (testnet). */
  id: number;
  /** Price / size decimals; null until read from Perpl context. */
  decimals: { price: number; size: number } | null;
}

export const MARKETS: Record<MarketSymbol, MarketInfo> = {
  BTC: { symbol: "BTC", id: 16, decimals: null },
  ETH: { symbol: "ETH", id: 32, decimals: null },
  SOL: { symbol: "SOL", id: 48, decimals: null },
  MON: { symbol: "MON", id: 64, decimals: null },
  ZEC: { symbol: "ZEC", id: 256, decimals: null },
};

export function isMarketSymbol(value: string): value is MarketSymbol {
  return (MARKET_SYMBOLS as readonly string[]).includes(value);
}

export function marketIdOf(symbol: string): number | undefined {
  return isMarketSymbol(symbol) ? MARKETS[symbol].id : undefined;
}

export function marketSymbolById(id: number): MarketSymbol | undefined {
  return MARKET_SYMBOLS.find((s) => MARKETS[s].id === id);
}

const ALIASES: Record<string, string> = { XBT: "BTC", WBTC: "BTC", WETH: "ETH", WSOL: "SOL", WMON: "MON" };
const QUOTES = ["USDT", "USDC", "USD", "PERP"];

/**
 * Normalise any TradingView / exchange style ticker to a bare base symbol.
 *
 *   "BTC", "BTCUSD", "BTCUSDT", "BTCUSDT.P", "BINANCE:BTCUSDT.P", "BTC-PERP",
 *   "BTC/USDT:USDT", "BTC_USDT", "btc-usd-perp"  ->  "BTC"
 *
 * Unknown bases are returned upper-cased (e.g. "DOGE") so the risk engine can block them with
 * `market_not_allowed` instead of the alert being silently misrouted. Returns "" for junk input.
 */
export function normalizeMarket(input: string): string {
  let s = input.trim().toUpperCase();
  if (!s) return "";
  // "BTC/USDT:USDT" (ccxt linear swap) -> keep the pair, drop the settle currency.
  // "BINANCE:BTCUSDT.P" -> drop the exchange prefix.
  if (s.includes(":")) {
    const [head, ...rest] = s.split(":");
    const tail = rest[rest.length - 1] ?? "";
    s = (head ?? "").includes("/") && QUOTES.includes(tail) ? (head ?? "") : tail;
  }
  s = s.replace(/\.(P|PERP|PS)$/, "").replace(/[-_/ ]?(PERPETUAL|PERP|SWAP)$/, "");
  const parts = s.split(/[-_/ ]+/).filter(Boolean);
  let base = parts[0] ?? "";
  if (parts.length === 1) {
    for (const q of QUOTES) {
      if (base.length > q.length && base.endsWith(q)) {
        base = base.slice(0, -q.length);
        break;
      }
    }
  }
  base = base.replace(/[^A-Z0-9]/g, "");
  return ALIASES[base] ?? base;
}
