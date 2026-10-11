import { describe, expect, it } from "vitest";
import type { AlertDetail, OrderFrame, RiskCheckResult } from "@hermes/shared";
import { payloadView, riskChecks } from "./derive";
import { orderFrame, perplMessages } from "./frame";

const chk = (key: string, label: string, passed: boolean | null, extra: Partial<RiskCheckResult> = {}): RiskCheckResult => ({ key, label, passed, skipped: passed === null, value: null, limit: null, unit: null, ...extra });
const base = (over: Partial<AlertDetail>): AlertDetail =>
  ({ id: "a", strategyId: "s", strategyName: "S", status: "filled", blockReason: null, market: "ETH", side: "short", kind: "open", events: [], orders: [], fills: [], approval: null, rawBody: "{}", parsed: null, ...over }) as unknown as AlertDetail;

describe("riskChecks", () => {
  it("alerts that never reached the risk gate are Not checked, never passed", () => {
    for (const status of ["duplicate", "invalid", "rejected_auth"] as const) {
      const r = riskChecks(base({ status, riskChecks: null, kind: null, side: null, market: null }));
      expect(r.notChecked).toBe(true);
      expect(r.items).toEqual([]);
      expect(r.passed).toBe(0);
      expect(r.meta).toBe("Not checked");
    }
  });

  it("skipped rules are shown as not run, and counted separately", () => {
    const r = riskChecks(base({ status: "blocked", blockReason: "leverage_above_max", riskChecks: [chk("strategy_enabled", "Strategy enabled", true, { value: "On" }), chk("leverage", "Max leverage", false, { value: 25, limit: 10, unit: "x" }), chk("size", "Max position size", null)] }));
    expect(r.items.map((i) => i.state)).toEqual(["fail", "pass", "skip"]);
    expect(r).toMatchObject({ failed: 1, passed: 1, skipped: 1, evaluated: 2, notChecked: false });
    expect(r.items[0]?.value).toBe("25x / 10x");
    expect(r.items[2]?.value).toBe("n/a");
  });
});

describe("payloadView", () => {
  it("reads side, market, size and price from a message that was never parsed", () => {
    expect(payloadView({ rawBody: '{"secret":"x","action":"short","market":"BTCUSDT.P","size_usd":1100,"price":108557.81}' })).toMatchObject({ side: "short", market: "BTC", sizeUsd: 1100, price: 108557.81 });
    expect(payloadView({ rawBody: "not json" })).toMatchObject({ side: null, market: null, sizeUsd: null });
  });
});

const frame = (id: number, direction: "out" | "in", mt: number, atMs: number, json: object): OrderFrame => ({ id, direction, mt, atMs, json: JSON.stringify(json) });

describe("order frames", () => {
  const d = base({
    orders: [
      {
        id: "o", market: "ETH", size: 0.2504, frames: [
          frame(1, "out", 22, 1000, { mt: 22, sn: 211, rq: 5420, mkt: 32, acc: 1001, t: 2, p: 0, s: 250, ms: 50, fl: 4, lv: 200, lb: 99 }),
          frame(2, "in", 3, 1040, { mt: 3, sid: 100, sn: 90211, cid: 211, status: { code: 0 } }),
          frame(3, "in", 24, 1100, { mt: 24, d: [{ oid: 700210, st: 2, fl: 4, at: { b: 12021620 } }] }),
          frame(4, "in", 24, 1100.5, { mt: 24, d: [{ oid: 700210, st: 2, fl: 4, at: { b: 12021620 } }] }),
        ],
      },
    ] as unknown as AlertDetail["orders"],
  });

  it("derives comments from the values that were actually sent", () => {
    const f = orderFrame(d)!;
    expect(f.copy).toContain('"rq":5420');
    expect(f.display).toMatch(/"p": 0,\s+\/\/ market, bounded by ms/);
    expect(f.display).toMatch(/"t": 2,\s+\/\/ OpenShort/);
    expect(f.display).toMatch(/"lv": 200,\s+\/\/ 2.00x/);
    expect(f.display).not.toContain("alert + ");
  });

  it("lists sent and inbound messages with timestamps, dropping a repeated frame", () => {
    const m = perplMessages(d);
    expect(m.map((x) => x.mt)).toEqual([22, 3, 24]);
    expect(m[1]).toMatchObject({ text: "Accepted for forwarding", muted: "cid 211", at: 1040 });
    expect(m[2]).toMatchObject({ text: "Order placed", block: 12021620 });
  });

  it("has no frame card when no frame was recorded", () => {
    expect(orderFrame(base({ orders: [{ id: "o", frames: [] } as unknown as AlertDetail["orders"][number]] }))).toBeNull();
  });
});
