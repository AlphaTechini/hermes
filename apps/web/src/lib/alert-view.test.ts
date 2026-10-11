import { describe, expect, it } from "vitest";
import type { AlertRecord } from "@hermes/shared";
import { alertOutcome, alertPipeline, alertSide } from "./alert-view";

const ev = (status: string, atMs: number, detail: Record<string, unknown> | null = null) => ({ id: 1, alertId: "a", status, atMs, detail }) as AlertRecord["events"][number];
const base = (over: Partial<AlertRecord>): AlertRecord =>
  ({ id: "a", strategyId: "s", strategyName: "S", idempotencyKey: null, status: "received", blockReason: null, errorCode: null, market: "BTC", side: "long", kind: "open", sizeUsd: 1, alertPrice: 1, receivedAt: 0, createdAt: 0, events: [], latencyMs: null, avgFillPrice: null, slippageBps: null, ...over }) as AlertRecord;

describe("alertPipeline", () => {
  it("filled: all done, last final, deltas from server timestamps", () => {
    const p = alertPipeline(base({ status: "filled", events: [ev("received", 1000), ev("verified", 1004), ev("risk_checked", 1006), ev("sent", 1017), ev("accepted", 1201), ev("filled", 1612)] }));
    expect(p.stages.map((s) => s.state)).toEqual(["done", "done", "done", "done", "done", "final"]);
    expect(p.stages.map((s) => s.label)).toEqual(["0 ms", "+4 ms", "+2 ms", "+11 ms", "+184 ms", "+411 ms"]);
    expect(p.totalMs).toBe(612);
  });
  it("in flight: next stage active, rest pending, no total", () => {
    const p = alertPipeline(base({ status: "sent", events: [ev("received", 1000), ev("verified", 1003), ev("risk_checked", 1005), ev("sent", 1017)] }));
    expect(p.stages.map((s) => s.state)).toEqual(["done", "done", "done", "done", "active", "pending"]);
    expect(p.stages[4]?.label).toBe("…");
    expect(p.totalMs).toBeNull();
  });
  it("blocked at checks: amber stage, later stages skipped", () => {
    const p = alertPipeline(base({ status: "blocked", blockReason: "size_above_max", events: [ev("received", 1000), ev("verified", 1004), ev("blocked", 1005)] }));
    expect(p.stages.map((s) => s.state)).toEqual(["done", "done", "blocked", "skipped", "skipped", "skipped"]);
    expect(p.stages[2]?.label).toBe("+1 ms");
    expect(p.totalMs).toBe(5);
  });
  it("failed after accepted: red Filled stage", () => {
    const p = alertPipeline(base({ status: "failed", errorCode: "timeout", events: [ev("received", 1000), ev("verified", 1004), ev("risk_checked", 1006), ev("sent", 1016), ev("accepted", 1192), ev("failed", 1494)] }));
    expect(p.stages[5]?.state).toBe("failed");
    expect(p.stages[5]?.label).toBe("+302 ms");
  });
  it("waiting for approval shows 'waiting' on Sent", () => {
    const p = alertPipeline(base({ status: "pending_approval", events: [ev("received", 1000), ev("verified", 1003), ev("risk_checked", 1005), ev("pending_approval", 1006)] }));
    expect(p.awaitingApproval).toBe(true);
    expect(p.stages[3]).toMatchObject({ state: "pending", label: "waiting" });
  });
  it("duplicate stops at Verified", () => {
    const p = alertPipeline(base({ status: "duplicate", events: [ev("received", 1000), ev("duplicate", 1002, { duplicateOf: "A-1" })] }));
    expect(p.stages[1]?.state).toBe("blocked");
  });
});

describe("dry run", () => {
  it("stops after Checked with the rest skipped, and has its own outcome", () => {
    const a = base({ status: "dry_run", events: [ev("received", 1000), ev("verified", 1004), ev("risk_checked", 1006), ev("dry_run", 1007)] });
    expect(alertPipeline(a).stages.map((s) => s.state)).toEqual(["done", "done", "done", "skipped", "skipped", "skipped"]);
    expect(alertPipeline(a).totalMs).toBe(7);
    expect(alertOutcome(a)).toMatchObject({ kind: "dry_run", label: "Dry run" });
  });
});

describe("alertOutcome and side", () => {
  it("maps statuses to pill kinds and sub-lines", () => {
    expect(alertOutcome(base({ status: "filled", avgFillPrice: 112048.5, slippageBps: 1.6 }))).toMatchObject({ kind: "filled", why: "112,048.5 · 1.6 bps" });
    expect(alertOutcome(base({ status: "blocked", blockReason: "market_not_allowed", market: "ZEC" })).why).toBe("ZEC is not an allowed market");
    expect(alertOutcome(base({ status: "failed", errorCode: "order_rejected" })).kind).toBe("rejected");
    expect(alertOutcome(base({ status: "duplicate", events: [ev("duplicate", 1, { duplicateOf: "A-10474" })] })).why).toBe("Duplicate of A-10474");
    expect(alertOutcome(base({ status: "pending_approval" })).kind).toBe("needs_approval");
  });
  it("side kinds", () => {
    expect(alertSide({ side: "short", kind: "open" })).toBe("short");
    expect(alertSide({ side: "long", kind: "close" })).toBe("close-long");
    expect(alertSide({ side: null, kind: "close" })).toBe("close");
  });
});
