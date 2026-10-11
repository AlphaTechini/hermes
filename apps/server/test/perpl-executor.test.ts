import type { OrderLifecycleHandlers, PerplClient as RawPerplClient } from "@hermes/perpl";
import { describe, expect, it } from "vitest";
import { PerplExecutor } from "../src/execution/perpl-executor";
import type { ExecutionEvent, OrderIntent } from "../src/execution/types";

type FakeFill = Parameters<NonNullable<OrderLifecycleHandlers["filled"]>>[0];

const ctx = { alertId: "alr_1", userId: "usr_1", orderId: "ord_1" };
const open: OrderIntent = { market: "BTC", marketId: 16, side: "long", kind: "open", type: "market", sizeUsd: 500, leverage: 3, maxSlippageBps: 40 };
const close: OrderIntent = { market: "BTC", marketId: 16, side: "long", kind: "close", type: "market", closeAll: true, maxSlippageBps: 40 };

function fill(over: Partial<FakeFill> = {}): FakeFill {
  return { rq: 7, atMs: 1, orderId: 99, price: 101_000, size: 0.01, fee: 0.3, feeCns: "300000", txHash: "0xabc", block: 12, cumulativeSize: 0.01, requestedSize: 0.01, ...over };
}

/** A raw client whose placeMarketOrder runs `script` against the handlers the executor passes in. */
function fake(script: (h: OrderLifecycleHandlers, params: Record<string, unknown>) => Promise<unknown> | void, connected = true) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    isConnected: () => connected,
    getPositions: async () => [{ market: "BTC", side: "long", entryPrice: 100_000, size: 0.01 }],
    placeMarketOrder: async (p: { handlers: OrderLifecycleHandlers } & Record<string, unknown>) => {
      calls.push(p);
      await script(p.handlers, p);
      return { status: "filled" };
    },
  } as unknown as RawPerplClient;
  const executor = new PerplExecutor({ raw: () => client });
  const events: ExecutionEvent[] = [];
  executor.onEvent((e) => events.push(e));
  return { executor, events, calls };
}

const sent = { rq: 7, sn: 3, lb: 0, atMs: 1, accountId: 1, marketId: 16, kind: "initial" as const, attempt: 1, head: 5 };

describe("PerplExecutor", () => {
  it("translates an open into placeMarketOrder and the callbacks into ordered execution events", async () => {
    const { executor, events, calls } = fake((h) => {
      h.sent?.(sent);
      h.accepted?.({ rq: 7, atMs: 2, source: "status" });
      h.accepted?.({ rq: 7, atMs: 3, source: "order", orderId: 99 });
      h.filled?.(fill());
    });
    await executor.submit(open, ctx);
    expect(calls[0]).toMatchObject({ market: "BTC", side: "long", kind: "open", sizeUsd: 500, leverage: 3, maxSlippageBps: 40, tag: "alr_1" });
    expect(events.map((e) => e.type)).toEqual(["sent", "accepted", "accepted", "filled"]);
    expect(events[0]).toMatchObject({ rq: 7, sn: 3, lb: 0 });
    expect(events[2]).toMatchObject({ perplOrderId: "99" });
    const f = events[3] as Extract<ExecutionEvent, { fill: unknown }>;
    expect(f.fill).toMatchObject({ price: 101_000, size: 0.01, fee: 0.3, txHash: "0xabc", block: 12 });
    expect(f.fill.realizedPnl).toBeUndefined();
    expect(f.fill.externalId).toBe("99:0xabc:0.01");
    expect(Number.isInteger(f.atMs * 1000)).toBe(true); // ms with 3 decimals
  });

  it("closeAll closes without a size, and realised PnL is the price PnL against the entry (short side flips the sign)", async () => {
    const a = fake((h) => {
      h.sent?.(sent);
      h.filled?.(fill());
    });
    await a.executor.submit(close, ctx);
    expect(a.calls[0]).toMatchObject({ kind: "close", closeAll: true });
    expect(a.calls[0]).not.toHaveProperty("sizeUsd");
    const f = a.events.find((e) => e.type === "filled") as Extract<ExecutionEvent, { fill: unknown }>;
    expect(f.fill.realizedPnl).toBeCloseTo((101_000 - 100_000) * 0.01, 9);
  });

  it("a tracker timeout becomes failed perpl_timeout and says the outcome is ambiguous", async () => {
    const { executor, events } = fake((h) => {
      h.sent?.(sent);
      h.timeout?.({ rq: 7, atMs: 9, reason: "no final status from Perpl before the order window closed", ambiguous: true });
    });
    await executor.submit(open, ctx);
    const failed = events.find((e) => e.type === "failed") as Extract<ExecutionEvent, { type: "failed" }>;
    expect(failed.code).toBe("perpl_timeout");
    expect(failed.message).toMatch(/ambiguous/i);
    expect(events.filter((e) => e.type === "failed")).toHaveLength(1);
  });

  it("a failure before anything was sent still resolves submit and reports the readable reason once", async () => {
    const { executor, events } = fake((h) => {
      h.failed?.({ rq: 0, atMs: 1, source: "validation", code: "forwarding_disabled", message: "order forwarding is off for this account" });
    });
    await executor.submit(open, ctx);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "failed", code: "forwarding_disabled", message: "order forwarding is off for this account" });
  });

  it("does not retry: one placeMarketOrder call per submit, even after a failure", async () => {
    const { executor, calls } = fake((h) => {
      h.sent?.(sent);
      h.failed?.({ rq: 7, atMs: 1, source: "order", code: "sr:32", message: "descending id too low" });
    });
    await executor.submit(open, ctx);
    expect(calls).toHaveLength(1);
  });

  it("fails fast with perpl_not_connected and for limit orders, without touching the client", async () => {
    const down = fake(() => {}, false);
    await down.executor.submit(open, ctx);
    expect(down.events[0]).toMatchObject({ type: "failed", code: "perpl_not_connected" });
    expect(down.calls).toHaveLength(0);

    const lim = fake(() => {});
    await lim.executor.submit({ ...open, type: "limit", limitPrice: 100_000 }, ctx);
    expect(lim.events[0]).toMatchObject({ type: "failed", code: "limit_orders_unsupported" });
    expect(lim.calls).toHaveLength(0);
  });

  it("a placeMarketOrder that throws is reported as executor_error", async () => {
    const { executor, events } = fake(() => {
      throw new Error("boom");
    });
    await executor.submit(open, ctx);
    expect(events[0]).toMatchObject({ type: "failed", code: "executor_error", message: "boom" });
  });
});
