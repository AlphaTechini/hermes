import type { AlertDetail, Fill, Order, OrderFrame as RawFrame } from "@hermes/shared";
import { formatPrice, formatSize, formatUsd, priceDecimals } from "../../lib/format";
import { symbolOfMarketId } from "./derive";

/**
 * Raw Perpl frames of an alert's orders (`orders[].frames`), as the server recorded them: the `mt 22` Hermes sent, and
 * what came back (`mt 3` forwarded, `mt 24` order status, `mt 25` fill). Nothing is rebuilt from other fields: when no
 * frame was recorded there is nothing to show, and the view says so by leaving the card out.
 */

// Names verbatim from the Perpl protocol (packages/perpl/src/protocol.ts).
const ORDER_TYPE: Record<number, string> = { 1: "OpenLong", 2: "OpenShort", 3: "CloseLong", 4: "CloseShort", 5: "Cancel", 6: "IncreasePositionCollateral", 7: "Change" };
const ORDER_FLAG: Record<number, string> = { 0: "GoodTillCancel", 1: "PostOnly", 2: "FillOrKill", 4: "ImmediateOrCancel" };
const ORDER_STATUS: Record<number, string> = { 1: "Pending", 2: "Open", 3: "PartiallyFilled", 4: "Filled", 5: "Canceled", 6: "Expired", 7: "Failed" };
/** The `sr` reasons a trader can act on. Others fall back to the code. */
const STATUS_REASON: Record<number, string> = {
  1: "Not enough available balance for this order",
  2: "Account is frozen",
  10: "Close order is larger than the open position",
  11: "Close order does not match the open position",
  12: "Perpl contract is not operational",
  13: "Order would cross the book",
  14: "Order was not executed before its last execution block",
  17: "Order is below the minimum size for an immediate order",
  24: "Maximum number of open orders reached",
  32: "Request id too low",
  33: "Order does not exist",
  34: "Order forwarding is not enabled for this account",
  40: "Price out of range",
  42: "Size out of range",
};

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

function parse(json: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(json) as unknown;
    return isRec(v) ? v : null;
  } catch {
    return null;
  }
}

/** Every recorded frame of every order of the alert, oldest first. */
export function framesOf(d: Pick<AlertDetail, "orders">): { frame: RawFrame; order: Order }[] {
  const all: { frame: RawFrame; order: Order }[] = [];
  for (const order of d.orders) for (const frame of order.frames ?? []) all.push({ frame, order });
  return all.sort((a, b) => a.frame.atMs - b.frame.atMs || a.frame.id - b.frame.id);
}

/** Decimals `k` such that `floor(base * 10^k) === lots`. The lot size is not on the order, but the frame and the order size pin it. */
function lotDecimals(base: number | null, lots: number | null): number | null {
  if (base === null || lots === null || !(base > 0)) return null;
  for (let k = 0; k <= 10; k++) if (Math.floor(base * 10 ** k + 1e-9) === lots) return k;
  return null;
}

export interface OrderFrameView {
  /** Pretty text with `// comments` derived from the actual values. */
  display: string;
  /** The exact JSON text Hermes sent. */
  copy: string;
  /** Epoch ms (sub-ms) the frame was written. */
  atMs: number;
  /** Parsed fields, for the Order card. */
  fields: Record<string, unknown>;
  order: Order;
}

/** One comment per field, computed from the field's own value (and the order it belongs to). */
function commentFor(key: string, value: unknown, f: Record<string, unknown>, order: Order): string | null {
  const n = num(value);
  switch (key) {
    case "mt":
      return n === 22 ? "place order" : null;
    case "sn":
      return "sequence";
    case "rq":
      return "request id";
    case "acc":
      return "account";
    case "mkt":
      return symbolOfMarketId(n);
    case "t":
      return n !== null ? (ORDER_TYPE[n] ?? null) : null;
    case "fl":
      return n !== null ? (ORDER_FLAG[n] ?? null) : null;
    case "p": {
      // Scaled by the market's price decimals. 0 means no limit price: a market order, bounded by `ms`.
      if (n === 0) return num(f.ms) !== null ? "market, bounded by ms" : "no limit price";
      const sym = symbolOfMarketId(f.mkt) ?? order.market;
      return n !== null ? `limit ${formatPrice(n / 10 ** priceDecimals(sym), sym)}` : null;
    }
    case "s": {
      const k = lotDecimals(order.size, n);
      const sym = symbolOfMarketId(f.mkt) ?? order.market;
      return n !== null && k !== null ? `${formatSize(n / 10 ** k, sym)} ${sym ?? ""}`.trim() : "lots";
    }
    case "lv":
      return n !== null ? `${(n / 100).toFixed(2)}x` : null;
    case "ms":
      return n !== null ? `max slippage, ${n} bps` : null;
    case "lb":
      return "last execution block";
    default:
      return null;
  }
}

/**
 * The first `mt 22` Hermes sent for this alert. Null when none was recorded (blocked, dry run, or an order from before
 * frames were stored).
 */
export function orderFrame(d: AlertDetail): OrderFrameView | null {
  const hit = framesOf(d).find((x) => x.frame.direction === "out" && x.frame.mt === 22);
  if (!hit) return null;
  const { frame, order } = hit;
  const fields = parse(frame.json);
  if (!fields) return { display: frame.json, copy: frame.json, atMs: frame.atMs, fields: {}, order };
  const entries = Object.entries(fields);
  const pad = Math.max(...entries.map(([k, v]) => `  "${k}": ${JSON.stringify(v)},`.length));
  const lines = entries.map(([k, v], i) => {
    const body = `  "${k}": ${JSON.stringify(v)}${i < entries.length - 1 ? "," : ""}`;
    const c = commentFor(k, v, fields, order);
    return c ? `${body.padEnd(pad + 2)} // ${c}` : body;
  });
  return { display: `{\n${lines.join("\n")}\n}`, copy: frame.json, atMs: frame.atMs, fields, order };
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

const commas = (v: unknown) => (num(v) !== null ? num(v)!.toLocaleString("en-US") : String(v));

/** Text for one `mt 24` entry (`d[i]`): what state the order is in. */
function orderStatusText(e: Record<string, unknown>): { text: string; muted: string[] } {
  const st = num(e.st);
  const oid = num(e.oid);
  const muted: string[] = [];
  if (oid !== null) muted.push(`oid ${commas(oid)}`);
  if (num(e.fl) === 4) muted.push("IOC");
  switch (st) {
    case 2:
      return { text: "Order placed", muted };
    case 3:
      return { text: "Order partly filled", muted };
    case 4:
      return { text: "Order filled", muted };
    case 5:
      return { text: "Order cancelled", muted };
    case 6:
      return { text: "Order expired", muted };
    case 7: {
      const sr = num(e.sr);
      return { text: `Order failed${sr ? `: ${STATUS_REASON[sr] ?? `reason ${sr}`}` : ""}`, muted: muted.filter((m) => m !== "IOC") };
    }
    default:
      return { text: st !== null ? `Order ${(ORDER_STATUS[st] ?? `status ${st}`).toLowerCase()}` : "Order update", muted };
  }
}

/** The Perpl reason text of a failed order (`mt 24`, `st 7`, `sr`), for the failed-alert callout. */
export function perplFailureReason(d: Pick<AlertDetail, "orders">): string | null {
  for (const { frame } of framesOf(d)) {
    if (frame.direction !== "in" || frame.mt !== 24) continue;
    const j = parse(frame.json);
    const first = Array.isArray(j?.d) ? (j!.d as unknown[]).find(isRec) : undefined;
    if (first && num(first.st) === 7) {
      const sr = num(first.sr);
      if (sr) return STATUS_REASON[sr] ?? `Perpl status reason ${sr}`;
    }
    // mt 3 refused at the gateway
  }
  for (const { frame } of framesOf(d)) {
    if (frame.direction !== "in" || frame.mt !== 3) continue;
    const j = parse(frame.json);
    const st = isRec(j?.status) ? j!.status : null;
    const code = st ? num(st.code) : null;
    if (code) return typeof st!.error === "string" ? `${st!.error}` : `Perpl refused the message (status ${code})`;
  }
  return null;
}

/**
 * One row per distinct Perpl message: the `mt 22` Hermes sent, then what came back (`mt 3` accepted for forwarding,
 * `mt 24` order status, `mt 25` fill), each with the time it was written and the block it names. A frame repeated after
 * a reconnect is dropped. `raw` is the parsed frame, for the expandable JSON.
 */
export function perplMessages(d: AlertDetail): PerplMessage[] {
  const frames = framesOf(d);
  if (frames.length === 0) return eventMessages(d);
  const fillsByTx = new Map<string, Fill>(d.fills.filter((f) => f.txHash).map((f) => [f.txHash!, f]));
  const out: PerplMessage[] = [];
  const seen = new Set<string>();
  for (const { frame, order } of frames) {
    const j = parse(frame.json);
    const raw = j ?? frame.json;
    const sym = order.market ?? d.market;
    const push = (key: string, text: string, muted: string, block: number | null) => {
      const k = `${frame.mt}:${key}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ key: `${frame.id}:${k}`, at: frame.atMs, mt: frame.mt, text, muted, block, raw });
    };
    if (frame.direction === "out") {
      if (frame.mt === 22) push(`${j?.rq ?? frame.id}`, "Order sent", [num(j?.rq) !== null ? `rq ${commas(j?.rq)}` : null, num(j?.sn) !== null ? `sn ${commas(j?.sn)}` : null].filter(Boolean).join(" · "), null);
      else push(`${frame.id}`, `Sent mt ${frame.mt}`, "", null);
      continue;
    }
    if (frame.mt === 3) {
      const st = isRec(j?.status) ? j!.status : null;
      const code = st ? num(st.code) : null;
      const cid = num(j?.cid);
      push(`${cid ?? ""}:${code ?? ""}`, code === 0 || code === null ? "Accepted for forwarding" : "Refused at the gateway", [cid !== null ? `cid ${commas(cid)}` : null, code ? `status ${code}` : null].filter(Boolean).join(" · "), null);
    } else if (frame.mt === 24) {
      const entries = Array.isArray(j?.d) ? (j!.d as unknown[]).filter(isRec) : [];
      const blockOf = (e: Record<string, unknown>) => num((isRec(e.at) ? e.at.b : undefined) ?? (isRec(j?.at) ? j!.at.b : undefined));
      if (entries.length === 0) push(`${frame.id}`, "Order update", "", null);
      for (const e of entries) {
        const { text, muted } = orderStatusText(e);
        push(`${num(e.oid) ?? ""}:${num(e.st) ?? ""}:${num(e.fs) ?? ""}`, text, muted.join(" · "), blockOf(e));
      }
    } else if (frame.mt === 25) {
      const entries = Array.isArray(j?.d) ? (j!.d as unknown[]).filter(isRec) : [];
      for (const e of entries) {
        const at = isRec(e.at) ? e.at : {};
        const tx = typeof at.txid === "string" ? at.txid : null;
        const fill = tx ? fillsByTx.get(tx) : undefined;
        const text = fill ? `Fill ${formatSize(fill.size, sym)} @ ${formatPrice(fill.price, sym)}` : "Fill";
        push(`${num(e.oid) ?? ""}:${tx ?? frame.id}`, text, fill ? `fee ${formatUsd(fill.fee)}` : "", num(at.b));
      }
      if (entries.length === 0) push(`${frame.id}`, "Fill", "", null);
    } else {
      push(`${frame.id}`, `Message mt ${frame.mt}`, "", num(isRec(j?.at) ? j!.at.b : undefined));
    }
  }
  return out;
}

/** Fallback for orders with no recorded frames: one row per order event (accepted, filled, failed). */
function eventMessages(d: AlertDetail): PerplMessage[] {
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
      msg = { mt: 24, text: "Order placed", muted: [oid ? `oid ${commas(oid)}` : null, d.orders[0]?.type === "market" ? "IOC" : null].filter(Boolean).join(" · "), block: null };
    } else if (e.status === "filled" || e.status === "partially_filled") {
      const fid = typeof det.fillId === "string" ? det.fillId : "";
      const f = fills.get(fid);
      key = `25:${fid || e.id}`;
      const size = f?.size ?? num(det.size);
      const price = f?.price ?? num(det.price);
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

/** Block of the first `mt 24` that placed the order and the order id, for the timeline's Accepted row. */
export function placedInfo(d: AlertDetail): { forwarded: boolean; block: number | null; oid: number | null } | null {
  const frames = framesOf(d);
  if (frames.length === 0) return null;
  const forwarded = frames.some((x) => x.frame.direction === "in" && x.frame.mt === 3);
  for (const { frame } of frames) {
    if (frame.direction !== "in" || frame.mt !== 24) continue;
    const j = parse(frame.json);
    const e = Array.isArray(j?.d) ? (j!.d as unknown[]).find(isRec) : undefined;
    if (e && num(e.st) === 2) return { forwarded, block: num(isRec(e.at) ? e.at.b : undefined), oid: num(e.oid) };
  }
  return { forwarded, block: null, oid: null };
}

