import { describe, expect, it } from "vitest";
import {
  MsgType,
  NON_FAILURE_STATUSES,
  ORDER_STATUS_REASON_NAMES,
  OrderFlag,
  OrderStatus,
  OrderType,
  buildOrderRequest,
  buildSubscribe,
  describeOrderStatus,
  describeStatusCode,
  describeStatusReason,
  isTerminalOrder,
  parseBatchStatus,
  parseHistoryPage,
  parseServerFrame,
  orderSchema,
  toOrderSpec,
  validateOrderSpec,
  type AccountUpdateFrame,
  type FillsFrame,
  type HeartbeatFrame,
  type MarketStateFrame,
  type OrdersFrame,
  type PositionsFrame,
  type StatusResponseFrame,
  type WalletFrame,
} from "../src/protocol";

const ok = (raw: unknown) => {
  const r = parseServerFrame(raw);
  if (!r.ok) throw new Error(r.error);
  return r.frame;
};

describe("enums", () => {
  it("order types 1..7 and flags", () => {
    expect(OrderType).toMatchObject({ OpenLong: 1, OpenShort: 2, CloseLong: 3, CloseShort: 4, Cancel: 5, IncreasePositionCollateral: 6, Change: 7 });
    expect(OrderFlag).toEqual({ GoodTillCancel: 0, PostOnly: 1, FillOrKill: 2, ImmediateOrCancel: 4 });
  });
  it("status reasons 0..69 are all named", () => {
    for (let i = 0; i <= 69; i++) expect(ORDER_STATUS_REASON_NAMES[i], `sr ${i}`).toBeTruthy();
    expect(ORDER_STATUS_REASON_NAMES[34]).toBe("OrderForwardingNotAllowed");
    expect(ORDER_STATUS_REASON_NAMES[32]).toBe("OrderDescIdTooLow");
    expect(ORDER_STATUS_REASON_NAMES[69]).toBe("OrderExtensionRejected");
  });
  it("non-failure statuses per the dedupe rule", () => {
    expect([...NON_FAILURE_STATUSES].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 8, 9, 10]);
    expect(isTerminalOrder({ st: OrderStatus.Filled })).toBe(true);
    expect(isTerminalOrder({ st: OrderStatus.Open })).toBe(false);
    expect(isTerminalOrder({ st: OrderStatus.Open, r: true })).toBe(true);
  });
  it("human readable reasons", () => {
    expect(describeStatusReason(34)).toMatch(/allowOrderForwarding/);
    expect(describeStatusReason(32)).toMatch(/Request id too low/);
    expect(describeStatusReason(3)).toBe("Cancel existing invalid close orders");
    expect(describeStatusReason(999)).toBe("Unknown reason 999");
    expect(describeOrderStatus({ st: 7, sr: 44, fr: 1 })).toBe("Order failed to settle: account balance is below the collateral and fee the new position requires");
    expect(describeOrderStatus({ st: 7, sr: 0 })).toBe("Failed");
    expect(describeStatusCode(403, "api key lacks trade scope")).toMatch(/forbidden.*lacks trade scope/);
    expect(describeStatusCode(0)).toBe("accepted for forwarding");
  });
});

describe("parseServerFrame: mt:3", () => {
  it("nested status", () => {
    const f = ok({ mt: 3, sid: 100, sn: 991, cid: 17, status: { code: 0, error: "" } }) as StatusResponseFrame;
    expect(f).toEqual({ mt: 3, sid: 100, sn: 991, cid: 17, status: { code: 0, error: "" } });
  });
  it("legacy flat form and string numbers", () => {
    const f = ok({ mt: 3, cid: "5", code: "400", error: "order already expired" }) as StatusResponseFrame;
    expect(f.cid).toBe(5);
    expect(f.status).toEqual({ code: 400, error: "order already expired" });
  });
  it("cid omitted when sn was 0", () => {
    const f = ok({ mt: 3, sid: 100, sn: 4, status: { code: 0 } }) as StatusResponseFrame;
    expect(f.cid).toBeUndefined();
  });
  it("rejects a status without a code", () => {
    expect(parseServerFrame({ mt: 3, status: {} }).ok).toBe(false);
  });
});

describe("parseServerFrame: wallet / account", () => {
  const acct = { in: 12, id: 4321, fr: false, fw: true, ft: 0, lfr: "1003", b: "100000000", lb: "0" };
  it("mt:19 with `as`, lfr as string", () => {
    const f = ok({ mt: 19, sn: 777, at: { b: 1, t: 2 }, addr: "0xabc", n: 0, fl: 0, as: [acct], sts: [{ in: 12, id: 4321, td: "1", tw: "0", tv: "0", tf: "0", trp: "0", wr: 0, tt: 0 }] }) as WalletFrame;
    expect(f.mt).toBe(19);
    expect(f.sn).toBe(777);
    expect(f.as[0]).toMatchObject({ id: 4321, in: 12, lfr: 1003, fw: true, b: "100000000" });
    expect(f.sts?.[0]?.id).toBe(4321);
  });
  it("legacy `accounts` key", () => {
    const f = ok({ mt: 19, sn: 1, accounts: [acct] }) as WalletFrame;
    expect(f.as).toHaveLength(1);
  });
  it("mt:21 and numeric amounts", () => {
    const f = ok({ mt: 21, ...acct, b: 5, lb: 0 }) as AccountUpdateFrame;
    expect(f.mt).toBe(21);
    expect(f.b).toBe("5");
    expect(f.lfr).toBe(1003);
  });
  it("defaults missing optional account fields", () => {
    const f = ok({ mt: 21, in: 12, id: 9 }) as AccountUpdateFrame;
    expect(f).toMatchObject({ fw: false, fr: false, lfr: 0, b: "0" });
  });
});

describe("parseServerFrame: orders / fills / positions", () => {
  const order = { at: { b: 10, t: 20, txid: "0x" + "ab".repeat(32) }, c: { b: 9, t: 19 }, rq: 1004, mkt: 16, acc: 4321, oid: 55, scid: 55, st: 4, sr: 43, t: 1, r: true, p: 0, os: 100, fp: 1120005, fs: 100, f: "386", fl: 4, mm: 0, lv: 300 };
  it("mt:24", () => {
    const f = ok({ mt: 24, at: { b: 10, t: 20 }, d: [order] }) as OrdersFrame;
    expect(f.d[0]).toMatchObject({ rq: 1004, st: 4, sr: 43, fp: 1120005, fs: 100, f: "386", r: true });
    expect(f.d[0]?.at.txid).toBe("0x" + "ab".repeat(32));
  });
  it("mt:23 snapshot entries carry no sr", () => {
    const { sr: _sr, ...noSr } = order;
    const f = ok({ mt: 23, sn: 3, d: [noSr] }) as OrdersFrame;
    expect(f.d[0]?.sr).toBe(0);
  });
  it("failure with fr", () => {
    const f = ok({ mt: 24, d: [{ ...order, st: 7, sr: 44, fr: 1 }] }) as OrdersFrame;
    expect(f.d[0]).toMatchObject({ st: 7, sr: 44, fr: 1 });
  });
  it("rejects an order without rq", () => {
    const { rq: _rq, ...bad } = order;
    expect(parseServerFrame({ mt: 24, d: [bad] }).ok).toBe(false);
  });
  it("mt:25", () => {
    const f = ok({ mt: 25, at: { b: 10 }, d: [{ at: { b: 10, t: 20, txid: "0xaa" }, mkt: 16, acc: 4321, oid: 55, t: 1, l: 2, p: 1120005, s: 100, f: "386" }] }) as FillsFrame;
    expect(f.d[0]).toMatchObject({ oid: 55, l: 2, p: 1120005, s: 100, f: "386" });
  });
  it("mt:26/27 with events", () => {
    const pos = { at: { b: 10, t: 20 }, mkt: 16, acc: 4321, pid: 9, rq: 1004, oid: 55, st: 1, sr: 21, sd: 1, c: "37333333", ep: 1120005, s: 100, fee: "386", efs: 0, lv: 300, xfs: 0, e: [{ at: { b: 10 }, mkt: 16, st: 1, sr: 21, sd: 1, s: 100, c: "1", fee: "386", ep: 1, lv: 300 }] };
    const f = ok({ mt: 27, d: [pos] }) as PositionsFrame;
    expect(f.mt).toBe(27);
    expect(f.d[0]?.e).toHaveLength(1);
    expect(ok({ mt: 26, sn: 1, d: [] }).mt).toBe(26);
  });
  it("missing d defaults to []", () => {
    expect((ok({ mt: 24 }) as OrdersFrame).d).toEqual([]);
  });
});

describe("parseServerFrame: heartbeat and market data", () => {
  it("mt:100", () => {
    expect(ok({ mt: 100, sn: 5, h: 55000000 })).toEqual({ mt: 100, sn: 5, h: 55000000 } satisfies HeartbeatFrame);
  });
  it("mt:9 market state keyed by market id", () => {
    const f = ok({ mt: 9, sn: 12, d: { "16": { at: { b: 12 }, orl: 1, mrk: 1120000, lst: 1120001, mid: 1, bid: 1, ask: 2, prv: 3, dv: 0, dva: "0", oi: 0, tvl: "0" } } }) as MarketStateFrame;
    expect(f.d["16"]?.mrk).toBe(1120000);
    expect(f.sn).toBe(12);
  });
  it("mt:6 subscription response", () => {
    const f = ok({ mt: 6, subs: [{ stream: "market-state@10143", sid: 1, status: { code: 0 } }, { stream: "bad", status: { code: 404, error: "unknown stream" } }] });
    expect((f as unknown as { subs: unknown[] }).subs).toHaveLength(2);
  });
  it("mt:15/17/11", () => {
    expect(ok({ mt: 15, sid: 1, bid: [{ p: 1, s: 2, o: 1 }], ask: [] }).mt).toBe(15);
    expect(ok({ mt: 18, sid: 1, d: [{ at: { b: 1 }, p: 1, s: 1, sd: 1 }] }).mt).toBe(18);
    expect(ok({ mt: 12, sid: 1, r: 60, d: [{ t: 1, o: 1, c: 1, h: 1, l: 1, v: "0", n: 0 }] }).mt).toBe(12);
  });
  it("unknown mt passes through", () => {
    expect(ok({ mt: 7, d: { h: 1 } })).toMatchObject({ mt: 7 });
  });
  it("never throws on junk", () => {
    for (const junk of ["", "{", "null", "[]", "42", { mt: "x" }, { nomt: 1 }, undefined]) expect(parseServerFrame(junk).ok).toBe(false);
  });
});

describe("client frames", () => {
  const base = { rq: 1004, mkt: 16, acc: 4321, t: 1, p: 0, s: 100, fl: 4, lv: 300, lb: 0, ms: 50 };
  it("builds the Desk market order shape", () => {
    expect(buildOrderRequest(base, 17)).toEqual({ mt: 22, sn: 17, rq: 1004, mkt: 16, acc: 4321, t: 1, p: 0, s: 100, fl: 4, lv: 300, lb: 0, ms: 50 });
  });
  it("sn must be a positive integer", () => {
    expect(() => buildOrderRequest(base, 0)).toThrow(RangeError);
    expect(() => buildOrderRequest(base, -1)).toThrow(RangeError);
    expect(() => buildOrderRequest(base, 1.5)).toThrow(RangeError);
  });
  it("drops undefined and unknown keys", () => {
    const spec = toOrderSpec({ ...base, oid: undefined, junk: 1 } as never);
    expect("oid" in spec).toBe(false);
    expect("junk" in spec).toBe(false);
  });
  it("validation", () => {
    expect(validateOrderSpec(base, { maxLeverageHdths: 1500, maxSlippageBps: 1000, isOpen: true })).toEqual([]);
    expect(validateOrderSpec({ ...base, s: 0 })).toContain("size must be > 0");
    expect(validateOrderSpec({ ...base, lv: 1600 }, { maxLeverageHdths: 1500 }).join()).toMatch(/exceeds the market maximum 15x/);
    expect(validateOrderSpec({ ...base, lv: 50 }).join()).toMatch(/below 1x/);
    expect(validateOrderSpec({ ...base, ms: 2000 }, { maxSlippageBps: 1000 }).join()).toMatch(/max slippage/);
    expect(validateOrderSpec({ ...base, mnp: 70000 }).join()).toMatch(/mnp/);
    expect(validateOrderSpec({ ...base, mnp: 0 })).toEqual([]);
    expect(validateOrderSpec({ ...base, fl: 3 }).join()).toMatch(/invalid flags/);
    expect(validateOrderSpec({ ...base, t: 9 }).join()).toMatch(/invalid order type/);
    expect(validateOrderSpec(base, { isOpen: false }).join()).toMatch(/closed/);
    expect(validateOrderSpec({ ...base, tp: 5 }).join()).toMatch(/tpc/);
    expect(validateOrderSpec({ ...base, p: -1 }).join()).toMatch(/unsigned/);
  });
  it("cancel needs oid, size 0 allowed", () => {
    const c = { rq: 5, mkt: 16, acc: 1, t: 5, s: 0, fl: 0, lv: 0, lb: 0 };
    expect(validateOrderSpec(c).join()).toMatch(/oid/);
    expect(validateOrderSpec({ ...c, oid: 9 })).toEqual([]);
  });
  it("subscribe frame", () => {
    expect(buildSubscribe(["market-state@10143", "heartbeat@10143"])).toEqual({ mt: 5, subs: [{ stream: "market-state@10143", subscribe: true }, { stream: "heartbeat@10143", subscribe: true }] });
    expect(MsgType.Heartbeat).toBe(100);
  });
});

describe("REST payloads", () => {
  it("history pages", () => {
    const page = parseHistoryPage({ d: [{ rq: 1, st: 4 }], np: "50" }, orderSchema);
    expect(page.np).toBe("50");
    expect(page.d[0]?.rq).toBe(1);
    expect(parseHistoryPage({ d: [], np: "" }, orderSchema)).toEqual({ d: [] });
  });
  it("batch status is positional", () => {
    const r = parseBatchStatus({ mt: 31, status: { code: 0 }, statuses: [{ code: 0 }, { code: 403, error: "invalid account" }] });
    expect(r.statuses?.[1]).toEqual({ code: 403, error: "invalid account" });
  });
});
