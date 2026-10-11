import { QueryClient } from "@tanstack/react-query";
import type { AlertListResponse, AlertRecord } from "@hermes/shared";
import { describe, expect, it } from "vitest";
import { qk } from "./queries";
import { applyStreamEvent, backoffMs } from "./stream";

const alert = (id: string, status: AlertRecord["status"]) => ({ id, strategyId: "s1", status, events: [] }) as unknown as AlertRecord;

describe("applyStreamEvent", () => {
  it("updates an existing row in place and prepends new ones", () => {
    const qc = new QueryClient();
    const key = qc.setQueryData<AlertListResponse>(qk.alerts.list({ limit: 50 }), { items: [alert("a2", "sent"), alert("a1", "filled")], nextCursor: null });
    expect(key).toBeTruthy();
    applyStreamEvent(qc, { type: "alert", alert: alert("a1", "filled") });
    applyStreamEvent(qc, { type: "alert", alert: alert("a2", "filled") });
    let data = qc.getQueryData<AlertListResponse>(qk.alerts.list({ limit: 50 }))!;
    expect(data.items.map((i) => `${i.id}:${i.status}`)).toEqual(["a2:filled", "a1:filled"]);
    applyStreamEvent(qc, { type: "alert", alert: alert("a3", "received") });
    data = qc.getQueryData<AlertListResponse>(qk.alerts.list({ limit: 50 }))!;
    expect(data.items[0]?.id).toBe("a3");
  });
  it("does not add a new alert to a different strategy's list", () => {
    const qc = new QueryClient();
    qc.setQueryData<AlertListResponse>(qk.alerts.list({ strategyId: "other" }), { items: [], nextCursor: null });
    applyStreamEvent(qc, { type: "alert", alert: alert("a1", "received") });
    expect(qc.getQueryData<AlertListResponse>(qk.alerts.list({ strategyId: "other" }))!.items).toHaveLength(0);
  });
  it("replaces positions", () => {
    const qc = new QueryClient();
    applyStreamEvent(qc, { type: "positions", positions: [{ market: "BTC", side: "long", size: 1, entryPrice: 1, markPrice: 1, upnl: 0, notionalUsd: 1, updatedAt: 0 }] });
    expect(qc.getQueryData(qk.positions)).toHaveLength(1);
  });
});

describe("backoff", () => {
  it("grows exponentially up to 15 s", () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4, 5, 6, 10].map((a) => backoffMs(a, mid))).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  });
});
