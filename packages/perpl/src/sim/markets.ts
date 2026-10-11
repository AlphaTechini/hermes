/** Simulated testnet market table and `GET /v1/pub/context` payload (shape of docs/research/perpl.md section 2). */
import { PERPL_TESTNET } from "../chain";

export interface SimMarketDef {
  id: number;
  symbol: string;
  name: string;
  priceDecimals: number;
  sizeDecimals: number;
  /** `initial_margin` = max leverage x 100. */
  initialMargin: number;
  maintenanceMargin: number;
  ttlBlocks: number;
  maxSlippageBps: number;
  startPrice: number;
  /** Annualised volatility. */
  annualVol: number;
  takerFeeMicros: number;
  makerFeeMicros: number;
}

export const SIM_MARKETS: readonly SimMarketDef[] = [
  { id: 16, symbol: "BTC", name: "Bitcoin", priceDecimals: 1, sizeDecimals: 5, initialMargin: 1500, maintenanceMargin: 2000, ttlBlocks: 20, maxSlippageBps: 1000, startPrice: 112000, annualVol: 0.5, takerFeeMicros: 345, makerFeeMicros: 45 },
  { id: 32, symbol: "ETH", name: "Ethereum", priceDecimals: 2, sizeDecimals: 3, initialMargin: 1200, maintenanceMargin: 2000, ttlBlocks: 20, maxSlippageBps: 1000, startPrice: 4100, annualVol: 0.65, takerFeeMicros: 345, makerFeeMicros: 45 },
  { id: 48, symbol: "SOL", name: "Solana", priceDecimals: 2, sizeDecimals: 3, initialMargin: 1000, maintenanceMargin: 2000, ttlBlocks: 20, maxSlippageBps: 1000, startPrice: 210, annualVol: 0.8, takerFeeMicros: 345, makerFeeMicros: 45 },
  { id: 64, symbol: "MON", name: "Monad", priceDecimals: 5, sizeDecimals: 0, initialMargin: 300, maintenanceMargin: 2000, ttlBlocks: 20, maxSlippageBps: 100, startPrice: 0.04, annualVol: 1.2, takerFeeMicros: 345, makerFeeMicros: 45 },
  { id: 256, symbol: "ZEC", name: "Zcash", priceDecimals: 3, sizeDecimals: 3, initialMargin: 300, maintenanceMargin: 2000, ttlBlocks: 20, maxSlippageBps: 100, startPrice: 60, annualVol: 1.1, takerFeeMicros: 345, makerFeeMicros: 45 },
];

export const SIM_INSTANCE_ID = PERPL_TESTNET.instanceId;
export const SIM_COLLATERAL_TOKEN_ID = 1;

export function buildContext(p: { chainId: number; head: number; nowMs: number; geoBlock: string[]; prices: Map<number, number> }): Record<string, unknown> {
  const at = { b: p.head, t: p.nowMs };
  return {
    chain: {
      ver: 235,
      chain_id: p.chainId,
      name: "Monad Testnet (simulated)",
      block_explorer_urls: ["https://testnet.monadexplorer.com"],
      gas: { at, h: p.head, max: "200000000000", p95: "150000000000", p50: "100000000000", min: "100000000000", base: "100000000000" },
    },
    instances: [
      {
        ver: 1,
        id: SIM_INSTANCE_ID,
        address: PERPL_TESTNET.exchange,
        collateral_token_id: SIM_COLLATERAL_TOKEN_ID,
        min_account_open_amount: "100000000",
        min_deposit_amount: "10000000",
        min_withdraw_amount: "1000000",
        max_account_trigger_orders: 10,
      },
    ],
    tokens: [{ ver: 1, id: SIM_COLLATERAL_TOKEN_ID, address: PERPL_TESTNET.collateral, symbol: "AUSD", name: "Agora USD", decimals: 6, display_precision: 2 }],
    markets: SIM_MARKETS.map((m) => {
      const price = p.prices.get(m.id) ?? m.startPrice;
      const scaled = Math.round(price * 10 ** m.priceDecimals);
      return {
        ver: 1,
        id: m.id,
        instance_id: SIM_INSTANCE_ID,
        perpetual_id: m.id,
        symbol: m.symbol,
        name: m.name,
        size_units: m.symbol,
        icon: "",
        funding_interval_sec: 3600,
        funding_interval_blocks: 9000,
        order_ttl_blocks: m.ttlBlocks,
        order_retry_blocks: 4,
        order_max_market_slippage_bps: m.maxSlippageBps,
        order_max_neg_pnl_collat_bps: 1000,
        points_boost_bps: 10000,
        config: {
          at,
          is_open: true,
          price_decimals: m.priceDecimals,
          size_decimals: m.sizeDecimals,
          min_posting_amount: "0",
          min_settle_amount: "0",
          initial_margin: m.initialMargin,
          maintenance_margin: m.maintenanceMargin,
          maker_fee: m.makerFeeMicros,
          taker_fee: m.takerFeeMicros,
          maker_fees: [m.makerFeeMicros, Math.round(m.makerFeeMicros * 0.8)],
          taker_fees: [m.takerFeeMicros, Math.round(m.takerFeeMicros * 0.8)],
          recycle_fee: "100000",
          funding_sum_scaling_exp: 6,
        },
        state: { at, orl: scaled, mrk: scaled, lst: scaled, mid: scaled, bid: scaled, ask: scaled, prv: scaled, dv: 0, dva: "0", oi: 0, tvl: "0" },
        funding: { at, feb: p.head, rate: 0, idx: scaled, ppl: 0, sum: 0, div: 1 },
      };
    }),
    features: { apiKeysEnabled: "on", tpSlOrdersUseIoc: "on" },
    geo_block: p.geoBlock,
  };
}
