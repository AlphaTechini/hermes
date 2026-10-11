import { afterEach, describe, expect, it } from "vitest";
import type { Approval, AlertRecord } from "@hermes/shared";
import { createStrategy, makeHarness, postHook, settled, waitFor, type Harness } from "./support/harness";
import { MockPerplClient, MockProvider, TestExecutor } from "./support/mock-perpl";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function setup(opts: { approvalTtlMs?: number; connected?: boolean } = {}) {
  const client = new MockPerplClient();
  client.connected = opts.connected ?? true;
  const executor = new TestExecutor(client);
  h = await makeHarness({ executor, perpl: new MockProvider(client), ...(opts.approvalTtlMs ? { approvalTtlMs: opts.approvalTtlMs } : {}) });
  const s = await createStrategy(h.app, { name: "P", defaultMarket: "BTC" });
  const send = async (over: Record<string, unknown>) => {
    const res = await postHook(h.app, s.id, { secret: s.secret, time: new Date().toISOString(), ...over });
    return (res.json() as { alertId: string }).alertId;
  };
  return { client, executor, s, send };
}

const putLimits = (over: Record<string, unknown>) =>
  h.app.inject({ method: "PUT", url: "/api/limits", payload: over });

describe("alert -> risk -> executor -> fills", () => {
  it("runs the full happy path and records every transition with timestamps", async () => {
    const { send, executor } = await setup();
    const id = await send({ action: "buy", size_usd: 500, price: 100000, leverage: 2 });
    await waitFor(() => h.repos.alerts.get(id)?.status === "filled");
    const rec = h.repos.alerts.record(id)!;
    expect(rec.events.map((e) => e.status)).toEqual(["received", "verified", "risk_checked", "sent", "accepted", "filled"]);
    expect(executor.submitted[0]).toMatchObject({ market: "BTC", marketId: 16, side: "long", kind: "open", sizeUsd: 500, leverage: 2, maxSlippageBps: 50 });
    expect(rec.latencyMs).toBeGreaterThanOrEqual(0);
    expect(rec.avgFillPrice).toBeCloseTo(100030, 0);
    expect(rec.slippageBps).toBeCloseTo(3, 0); // 3 bps worse than the alert price
    const detail = h.repos.alertDetail(id)!;
    expect(detail.orders).toHaveLength(1);
    expect(detail.orders[0]).toMatchObject({ status: "filled", rq: 101, sn: 1, lb: 1005, perplOrderId: "po-1", market: "BTC" });
    expect(detail.fills).toHaveLength(1);
    expect(h.repos.positions.list("usr_demo")[0]).toMatchObject({ market: "BTC", side: "long" });
  });

  it("closes a position and books realised PnL into daily_pnl", async () => {
    const { send } = await setup();
    const openId = await send({ action: "long", size_usd: 1000, price: 100000, id: "o1" });
    await waitFor(() => h.repos.alerts.get(openId)?.status === "filled");
    const closeId = await send({ action: "close_long", price: 100000, id: "c1" });
    await waitFor(() => h.repos.alerts.get(closeId)?.status === "filled");
    const close = h.repos.alertDetail(closeId)!;
    expect(close).toMatchObject({ kind: "close", side: "long" });
    expect(close.fills[0]?.realizedPnl).not.toBeNull();
    const today = new Date().toISOString().slice(0, 10);
    expect(h.repos.dailyPnl.get("usr_demo", today)).toBeCloseTo(close.fills[0]!.realizedPnl!, 6);
  });

  it("supports TradingView strategy placeholders: sell + flat closes a long", async () => {
    const { send } = await setup();
    const o = await send({ action: "buy", market_position: "long", size: 0.01, price: 100000, id: "a" });
    await waitFor(() => h.repos.alerts.get(o)?.status === "filled");
    const c = await send({ action: "sell", market_position: "flat", size: 0.01, price: 100000, id: "b" });
    await waitFor(() => h.repos.alerts.get(c)?.status === "filled");
    expect(h.repos.alerts.get(c)).toMatchObject({ kind: "close", side: "long" });
  });

  it("generic `close` resolves the side from the open position", async () => {
    const { send } = await setup();
    const o = await send({ action: "short", size_usd: 800, price: 100000, id: "s" });
    await waitFor(() => h.repos.alerts.get(o)?.status === "filled");
    const c = await send({ action: "flat", id: "f" });
    await waitFor(() => h.repos.alerts.get(c)?.status === "filled");
    expect(h.repos.alerts.get(c)).toMatchObject({ kind: "close", side: "short" });
  });

  it("derives notional from base size using the alert price", async () => {
    const { send, executor } = await setup();
    const ok = await send({ action: "buy", size: 0.01, price: 100000, id: "n1" });
    await waitFor(() => h.repos.alerts.get(ok)?.status === "filled");
    expect(h.repos.alerts.get(ok)?.sizeUsd).toBeCloseTo(1000, 6);
    expect(executor.submitted[0]).toMatchObject({ sizeBase: 0.01 });

    const big = await send({ action: "buy", size: 0.5, price: 100000, id: "n2" }); // 50,000 USD > default 5,000 max
    expect(await settled(h, big)).toMatchObject({ status: "blocked", blockReason: "size_above_max", sizeUsd: 50000 });
    expect(executor.submitted).toHaveLength(1);
  });
});

describe("blocking", () => {
  it.each([
    ["market_not_allowed", { market: "ETH" }, { allowedMarkets: ["BTC"] }],
    ["size_above_max", { size_usd: 6000 }, { maxPositionUsd: 5000 }],
    ["leverage_above_max", { leverage: 25 }, { maxLeverage: 10 }],
    ["trading_paused", {}, { paused: true }],
  ])("blocks with %s and never reaches the executor", async (reason, payload, limits) => {
    const { send, executor } = await setup();
    expect((await putLimits(limits)).statusCode).toBe(200);
    const id = await send({ action: "buy", size_usd: 100, price: 100000, ...payload });
    const a = await settled(h, id);
    expect(a).toMatchObject({ status: "blocked", blockReason: reason });
    expect(executor.submitted).toHaveLength(0);
    expect(h.repos.alerts.events(id).at(-1)?.detail).toMatchObject({ reason });
  });

  it("blocks stale alerts based on the alert's own timestamp", async () => {
    const { send } = await setup();
    const id = await send({ action: "buy", size_usd: 100, time: new Date(Date.now() - 120_000).toISOString() });
    expect(await settled(h, id)).toMatchObject({ status: "blocked", blockReason: "stale_alert" });
  });

  it("blocks closes with no position", async () => {
    const { send } = await setup();
    const id = await send({ action: "close_long" });
    expect(await settled(h, id)).toMatchObject({ status: "blocked", blockReason: "no_position_to_close" });
  });

  it("blocks when the registered Perpl client is disconnected", async () => {
    const { send } = await setup({ connected: false });
    const id = await send({ action: "buy", size_usd: 100 });
    expect(await settled(h, id)).toMatchObject({ status: "blocked", blockReason: "perpl_not_connected" });
  });

  it("blocks after the daily loss stop is breached", async () => {
    const { send } = await setup();
    await putLimits({ dailyLossStopUsd: 100 });
    h.repos.dailyPnl.add("usr_demo", new Date().toISOString().slice(0, 10), -150);
    const id = await send({ action: "buy", size_usd: 100 });
    expect(await settled(h, id)).toMatchObject({ status: "blocked", blockReason: "daily_loss_stop_hit" });
  });

  it("rate limits per user per minute", async () => {
    const { send } = await setup();
    await putLimits({ maxOrdersPerMinute: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await send({ action: "buy", size_usd: 50, price: 100000, id: `r${i}` });
      await settled(h, id);
      ids.push(id);
    }
    const statuses = ids.map((i) => h.repos.alerts.get(i)?.status);
    expect(statuses.slice(0, 2)).toEqual(["filled", "filled"]);
    expect(h.repos.alerts.get(ids[2]!)).toMatchObject({ status: "blocked", blockReason: "rate_limited" });
  });

  it("blocks if the strategy was disabled after the alert was accepted", async () => {
    const { s, send } = await setup();
    const id = await send({ action: "buy", size_usd: 100 });
    h.repos.strategies.update(s.id, { enabled: false }); // lands before the async pipeline tick
    expect(await settled(h, id)).toMatchObject({ status: "blocked", blockReason: "strategy_disabled" });
  });
});

describe("executor outcomes", () => {
  it("records a rejected order as failed with the executor's code", async () => {
    const { send, executor } = await setup();
    executor.mode = "reject";
    const id = await send({ action: "buy", size_usd: 100, price: 100000 });
    await waitFor(() => h.repos.alerts.get(id)?.status === "failed");
    expect(h.repos.alerts.get(id)?.errorCode).toBe("order_rejected");
    expect(h.repos.alertDetail(id)!.orders[0]).toMatchObject({ status: "failed", errorCode: "order_rejected" });
  });

  it("keeps partially_filled and ignores replayed fills", async () => {
    const { send, executor } = await setup();
    executor.mode = "partial";
    const id = await send({ action: "buy", size_usd: 1000, price: 100000 });
    await waitFor(() => h.repos.alerts.get(id)?.status === "partially_filled");
    expect(h.repos.fills.byAlert(id)).toHaveLength(1);
  });

  it("does not downgrade a filled alert when a late failure arrives", async () => {
    const { send } = await setup();
    const id = await send({ action: "buy", size_usd: 100, price: 100000 });
    await waitFor(() => h.repos.alerts.get(id)?.status === "filled");
    h.pipeline.transition(id, "failed", { errorCode: "late" }, { note: "late failure" });
    expect(h.repos.alerts.get(id)?.status).toBe("filled");
    expect(h.repos.alerts.events(id).at(-1)?.status).toBe("failed");
  });
});

describe("approvals", () => {
  const needApproval = async () => {
    const ctx = await setup({ approvalTtlMs: 150 });
    await putLimits({ approvalThresholdUsd: 200 });
    return ctx;
  };

  it("queues large orders, then executes after approve", async () => {
    const { send, executor } = await needApproval();
    const id = await send({ action: "buy", size_usd: 300, price: 100000 });
    await waitFor(() => h.repos.alerts.get(id)?.status === "pending_approval");
    const list = (await h.app.inject({ method: "GET", url: "/api/approvals?status=pending" })).json() as Approval[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ alertId: id, status: "pending", notionalUsd: 300, market: "BTC", side: "long" });
    expect(executor.submitted).toHaveLength(0);

    const res = await h.app.inject({ method: "POST", url: `/api/approvals/${list[0]!.id}/approve` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Approval).status).toBe("approved");
    expect(h.repos.alerts.get(id)?.status).toBe("filled");
    expect(executor.submitted).toHaveLength(1);
    const again = await h.app.inject({ method: "POST", url: `/api/approvals/${list[0]!.id}/approve` });
    expect(again.statusCode).toBe(409);
  });

  it("rejecting blocks the alert with approval_rejected", async () => {
    const { send, executor } = await needApproval();
    const id = await send({ action: "buy", size_usd: 300, price: 100000 });
    await waitFor(() => h.repos.alerts.get(id)?.status === "pending_approval");
    const a = h.repos.approvals.byAlert(id)!;
    const res = await h.app.inject({ method: "POST", url: `/api/approvals/${a.id}/reject` });
    expect((res.json() as Approval).status).toBe("rejected");
    expect(h.repos.alerts.get(id)).toMatchObject({ status: "blocked", blockReason: "approval_rejected" });
    expect(executor.submitted).toHaveLength(0);
  });

  it("expires unanswered approvals", async () => {
    const { send, executor } = await needApproval();
    const id = await send({ action: "buy", size_usd: 300, price: 100000 });
    await waitFor(() => h.repos.alerts.get(id)?.status === "expired");
    expect(h.repos.alerts.get(id)).toMatchObject({ status: "expired", blockReason: "approval_expired" });
    expect(h.repos.approvals.byAlert(id)?.status).toBe("expired");
    expect(executor.submitted).toHaveLength(0);
    const res = await h.app.inject({ method: "POST", url: `/api/approvals/${h.repos.approvals.byAlert(id)!.id}/approve` });
    expect(res.statusCode).toBe(409);
  });

  it("re-checks risk on approval (limits tightened while waiting)", async () => {
    const { send, executor } = await setup({ approvalTtlMs: 5000 });
    await putLimits({ approvalThresholdUsd: 200 });
    const id = await send({ action: "buy", size_usd: 300, price: 100000 });
    await waitFor(() => h.repos.alerts.get(id)?.status === "pending_approval");
    await putLimits({ approvalThresholdUsd: 200, paused: true });
    const a = h.repos.approvals.byAlert(id)!;
    await h.app.inject({ method: "POST", url: `/api/approvals/${a.id}/approve` });
    expect(h.repos.alerts.get(id)).toMatchObject({ status: "blocked", blockReason: "trading_paused" });
    expect(executor.submitted).toHaveLength(0);
  });

  it("cannot be decided by another user", async () => {
    const { send } = await needApproval();
    const id = await send({ action: "buy", size_usd: 300, price: 100000 });
    await waitFor(() => h.repos.alerts.get(id)?.status === "pending_approval");
    const a = h.repos.approvals.byAlert(id)!;
    expect(() => h.pipeline.reject(a.id, "someone-else")).toThrow(/not found/);
  });
});

describe("event bus", () => {
  it("publishes alert updates to the owner only", async () => {
    const { send } = await setup();
    const mine: AlertRecord["status"][] = [];
    const theirs: unknown[] = [];
    h.bus.subscribe((m) => {
      if (m.event.type !== "alert") return;
      (m.userId === "usr_demo" ? mine : theirs).push(m.event.alert.status as never);
    });
    const id = await send({ action: "buy", size_usd: 100, price: 100000 });
    await waitFor(() => h.repos.alerts.get(id)?.status === "filled");
    expect(mine).toContain("verified");
    expect(mine.at(-1)).toBe("filled");
    expect(theirs).toHaveLength(0);
  });
});
