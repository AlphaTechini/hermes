import { MARKETS, isMarketSymbol, type AlertDetail, type Fill, type Order, type RiskLimits } from "@hermes/shared";
import { formatPrice, formatSize, formatUsd } from "../../lib/format";
import { maxSlippageOf } from "./derive";

/** Perpl `t` codes (packages/perpl protocol.ts). */
const T_NAMES: Record<number, string> = { 1: "OpenLong", 2: "OpenShort", 3: "CloseLong", 4: "CloseShort" };

const orderCode = (o: Order): number => (o.kind === "open" ? (o.side === "long" ? 1 : 2) : o.side === "long" ? 3 : 4);

export interface OrderFrame {
  /** Highlighted display text with `// comments`. */
  display: string;
  /** Plain JSON, what the Copy button copies. */
  copy: string;
  order: Order;
}

/**
 * The `mt 22` frame the executor wrote to the trading socket, rebuilt from the stored order (market, side, size,
 * price, leverage, rq, sn, lb). Null when no frame was written (blocked, or failed before Sent).
 */
export function orderFrame(d: AlertDetail, limits: RiskLimits | undefined): OrderFrame | null {
  const order = d.orders.find((o) => o.rq !== null || o.sn !== null) ?? null;
  if (!order || !d.events.some((e) => e.status === "sent")) return null;
  const t = orderCode(order);
  const market = order.market ?? d.market ?? "";
  const mkt = isMarketSymbol(market) ? MARKETS[market].id : order.marketId;
  const isMarket = order.type === "market";
  const ms = maxSlippageOf(d, limits);
  const buy = t === 1 || t === 4;

  const fields: [string, number | undefined, string | null][] = [
    ["mt", 22, null],
    ["sn", order.sn ?? undefined, null],
    ["rq", order.rq ?? undefined, null],
    ["mkt", mkt, market || null],
    ["t", t, T_NAMES[t] ?? null],
    ["fl", isMarket ? 4 : 0, isMarket ? "ImmediateOrCancel" : "GoodTillCancel"],
    ["p", order.price ?? undefined, ms !== null && order.price ? `${buy ? "alert + " : "alert - "}${ms} bps cap` : null],
    ["s", order.size ?? undefined, null],
    ["lv", order.leverage ? Math.round(order.leverage * 100) : undefined, order.leverage ? `${order.leverage.toFixed(2)}x` : null],
    ["ms", ms ?? undefined, "max slippage, bps"],
    ["lb", order.lb ? order.lb : undefined, "last execution block"],
  ];
  const present = fields.filter((f): f is [string, number, string | null] => f[1] !== undefined);
  const width = Math.max(...present.map(([k, v]) => `"${k}": ${v},`.length));
  const lines = present.map(([k, v, c], i) => {
    const body = `  "${k}": ${v}${i < present.length - 1 ? "," : ""}`;
    return c ? `${body.padEnd(width + 4)} // ${c}` : body;
  });
  const copy = JSON.stringify(Object.fromEntries(present.map(([k, v]) => [k, v])), null, 2);
  return { display: `{\n${lines.join("\n")}\n}`, copy, order };
}

export interface PerplMessage {
  key: string;
  at: number;
  mt: number;
  text: string;
  muted: string;
  block: number | null;
  raw: unknown;
}

/** One row per distinct Perpl status (a repeat after a reconnect is dropped). mt 24 placed, mt 25 fill. */
export function perplMessages(d: AlertDetail): PerplMessage[] {
  const out: PerplMessage[] = [];
  const seen = new Set<string>();
  const fills = new Map<string, Fill>(d.fills.map((f) => [f.id, f]));
  for (const e of d.events) {
    const det = (e.detail ?? {}) as Record<string, unknown>;
    let key = "";
    let msg: Omit<PerplMessage, "key" | "at" | "raw"> | null = null;
    if (e.status === "accepted") {
      const oid = typeof det.perplOrderId === "string" ? det.perplOrderId : null;
      key = `24:${oid ?? ""}`;
      msg = { mt: 24, text: "Order placed", muted: [oid ? `oid ${Number.isFinite(Number(oid)) ? Number(oid).toLocaleString("en-US") : oid}` : null, d.orders[0]?.type === "market" ? "IOC" : null].filter(Boolean).join(" · "), block: null };
    } else if (e.status === "filled" || e.status === "partially_filled") {
      const fid = typeof det.fillId === "string" ? det.fillId : "";
      const f = fills.get(fid);
      key = `25:${fid || e.id}`;
      const size = f?.size ?? (typeof det.size === "number" ? det.size : null);
      const price = f?.price ?? (typeof det.price === "number" ? det.price : null);
      msg = { mt: 25, text: `Fill ${formatSize(size, d.market)} @ ${formatPrice(price, d.market)}`, muted: f ? `fee ${formatUsd(f.fee)}` : "", block: f?.block ?? null };
    } else if (e.status === "failed") {
      key = `3:${e.id}`;
      const m = typeof det.message === "string" ? det.message : null;
      msg = { mt: 3, text: m ?? "Order refused", muted: typeof det.code === "string" ? det.code : "", block: null };
    }
    if (!msg || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, at: e.atMs, raw: { status: e.status, ...det }, ...msg });
  }
  return out;
}
