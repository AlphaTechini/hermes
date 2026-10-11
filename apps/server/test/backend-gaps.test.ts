import { afterEach, describe, expect, it } from "vitest";
import type { AccountSummary, AlertDetail, Approval, RiskCheckResult, RiskLimits, StrategyDTO } from "@hermes/shared";
import { createStrategy, makeHarness, postHook, settled, waitFor, type Harness } from "./support/harness";
import { MockPerplClient, MockProvider, TestExecutor } from "./support/mock-perpl";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function setup(opts: { approvalTtlMs?: number; strategy?: Record<string, unknown> } = {}) {
  const client = new MockPerplClient();
  const executor = new TestExecutor(client);
  h = await makeHarness({ executor, perpl: new MockProvider(client), ...(opts.approvalTtlMs ? { approvalTtlMs: opts.approvalTtlMs } : {}) });
  const s = await createStrategy(h.app, { name: "P", defaultMarket: "BTC", ...opts.strategy });
  const send = async (over: Record<string, unknown>) => {
    const res = await postHook(h.app, s.id, { secret: s.secret, time: new Date().toISOString(), ...over });
    return (res.json() as { alertId: string }).alertId;
  };
  return { client, executor, s, send };
}
const putLimits = (over: Record<string, unknown>) => h.app.inject({ method: "PUT", url: "/api/limits", payload: over });
const detail = async (id: string) => (await h.app.inject({ method: "GET", url: `/api/alerts/${id}` })).json<AlertDetail>();

describe("risk checks stored per alert", () => {
  it("risk_checked carries every rule and GET /api/alerts/:id exposes them", async () => {
    const { send } = await setup();
    const id = await send({ action: "buy", size_usd: 500, price: 100000, leverage: 2 });
    await waitFor(() => h.repos.alerts.get(id)?.status === "filled");
    const ev = h.repos.alerts.events(id).find((e) => e.status === "risk_checked");
    const checks = ev?.detail?.checks as RiskCheckResult[];
    expect(checks.map((c) => c.key)).toEqual(["strategy_enabled", "alert_age", "rate_limit", "perpl_connected", "pause", "markets", "daily_loss", "size_known", "leverage", "size", "approval"]);
    const d = await detail(id);
    expect(d.riskChecks).toEqual(checks);
    expect(d.riskChecks?.find((c) => c.key === "size")).toMatchObject({ passed: true, value: 500, limit: 5000, unit: "USD" });
    expect(d.riskChecks?.find((c) => c.key === "leverage")).toMatchObject({ value: 2, limit: 10, unit: "x" });
  });

  it("a blocked alert records the failing check, those before it, and the rest as skipped", async () => {
    const { send } = await setup();
    await putLimits({ maxPositionUsd: 1000 });
    const id = await send({ action: "buy", size_usd: 4000, price: 100000 });
    expect(await settled(h, id)).toMatchObject({ status: "blocked", blockReason: "size_above_max" });
    const d = await detail(id);
    const checks = d.riskChecks!;
    const bad = checks.findIndex((c) => c.passed === false);
    expect(checks[bad]).toMatchObject({ key: "size", value: 4000, limit: 1000, skipped: false });
    expect(checks.slice(0, bad).every((c) => c.passed === true)).toBe(true);
    expect(checks.slice(bad + 1).map((c) => [c.key, c.skipped])).toEqual([["approval", true]]);
  });

  it("alerts that never reached the risk gate have no checks", async () => {
    const { s } = await setup();
    const res = await postHook(h.app, s.id, { secret: "wrong", action: "buy" });
    expect(res.statusCode).toBe(401);
    const a = h.repos.alerts.list({ userId: "usr_demo", limit: 5 }).items[0]!;
    expect((await detail(a.id)).riskChecks).toBeNull();
  });
});

describe("daily loss stop uses realised + unrealised PnL", () => {
  it("blocks when open positions are losing enough, and the account endpoint shows the same numbers", async () => {
    const { client, send } = await setup();
    await putLimits({ dailyLossStopUsd: 200 });
    h.repos.dailyPnl.add("usr_demo", new Date().toISOString().slice(0, 10), -120);
    client.positions = [{ market: "ETH", side: "long", size: 1, entryPrice: 4100, markPrice: 4000, upnl: -80, notionalUsd: 4000, updatedAt: Date.now() }];
    const baseAccount = client.getAccount.bind(client);
    client.getAccount = async () => ({ ...(await baseAccount()), unrealizedPnlUsd: client.positions.reduce((a, p) => a + p.upnl, 0) });
    const acct = (await h.app.inject({ method: "GET", url: "/api/account" })).json<AccountSummary>();
    expect(acct).toMatchObject({ todayRealizedUsd: -120, todayUnrealizedUsd: -80, todayPnlUsd: -200, lossStopUsd: 200, lossStopUsedUsd: 200 });
    const id = await send({ action: "buy", size_usd: 100, price: 100000 });
    expect(await settled(h, id)).toMatchObject({ status: "blocked", blockReason: "daily_loss_stop_hit" });
    const loss = (await detail(id)).riskChecks!.find((c) => c.key === "daily_loss");
    expect(loss).toMatchObject({ passed: false, value: 200, limit: 200, unit: "USD" });
  });

  it("realised profit offsets an unrealised loss", async () => {
    const { client, executor, send } = await setup();
    await putLimits({ dailyLossStopUsd: 200 });
    h.repos.dailyPnl.add("usr_demo", new Date().toISOString().slice(0, 10), 150);
    client.positions = [{ market: "ETH", side: "long", size: 1, entryPrice: 4300, markPrice: 4000, upnl: -300, notionalUsd: 4000, updatedAt: Date.now() }];
    const id = await send({ action: "buy", size_usd: 100, price: 100000 });
    await waitFor(() => h.repos.alerts.get(id)?.status === "filled");
    expect(executor.submitted).toHaveLength(1);
  });
});

describe("dry run, slippage override, approval expiry", () => {
  it("a dry-run strategy runs every check, records dry_run and never calls the executor", async () => {
    const { send, executor } = await setup({ strategy: { dryRun: true } });
    const id = await send({ action: "buy", size_usd: 100, price: 100000 });
    expect(await settled(h, id)).toMatchObject({ status: "dry_run" });
    expect(h.repos.alerts.events(id).map((e) => e.status)).toEqual(["received", "verified", "risk_checked", "dry_run"]);
    expect(executor.submitted).toHaveLength(0);
    expect(h.repos.orders.byAlert(id)).toHaveLength(0);
    expect((await detail(id)).riskChecks).toHaveLength(11);
    // above the approval threshold a dry run still just stops: nothing waits for a human
    await putLimits({ approvalThresholdUsd: 50 });
    const big = await send({ action: "buy", size_usd: 100, price: 100000, id: "big" });
    expect(await settled(h, big)).toMatchObject({ status: "dry_run" });
    expect(h.repos.approvals.byAlert(big)).toBeUndefined();
  });

  it("dry runs still get blocked by limits", async () => {
    const { send } = await setup({ strategy: { dryRun: true } });
    await putLimits({ paused: true });
    const id = await send({ action: "buy", size_usd: 100, price: 100000 });
    expect(await settled(h, id)).toMatchObject({ status: "blocked", blockReason: "trading_paused" });
  });

  it("a strategy's maxSlippageBps overrides the account default; the alert message overrides both", async () => {
    const { send, executor } = await setup({ strategy: { maxSlippageBps: 12 } });
    const a = await send({ action: "buy", size_usd: 100, price: 100000, id: "a" });
    await waitFor(() => h.repos.alerts.get(a)?.status === "filled");
    expect(executor.submitted[0]?.maxSlippageBps).toBe(12);
    const b = await send({ action: "buy", size_usd: 100, price: 100000, id: "b", max_slippage_bps: 7 });
    await waitFor(() => h.repos.alerts.get(b)?.status === "filled");
    expect(executor.submitted[1]?.maxSlippageBps).toBe(7);
  });

  it("limits.approvalExpirySec sets how long an approval lives", async () => {
    const { send } = await setup();
    const saved = await putLimits({ approvalThresholdUsd: 200, approvalExpirySec: 45 });
    expect(saved.json<RiskLimits>().approvalExpirySec).toBe(45);
    const id = await send({ action: "buy", size_usd: 300, price: 100000 });
    await waitFor(() => h.repos.alerts.get(id)?.status === "pending_approval");
    const a = h.repos.approvals.byAlert(id)!;
    expect(a.expiresAt - a.createdAt).toBe(45_000);
  });
});

describe("approval wait is not latency", () => {
  it("measures alert-to-fill from the decision and exposes the wait", async () => {
    const { send } = await setup({ approvalTtlMs: 10_000 });
    await putLimits({ approvalThresholdUsd: 200 });
    const id = await send({ action: "buy", size_usd: 300, price: 100000 });
    await waitFor(() => h.repos.alerts.get(id)?.status === "pending_approval");
    await new Promise((r) => setTimeout(r, 300));
    const appr = h.repos.approvals.byAlert(id)!;
    const res = await h.app.inject({ method: "POST", url: `/api/approvals/${appr.id}/approve` });
    expect((res.json() as Approval).status).toBe("approved");
    const d = await detail(id);
    const ev = (s: string) => d.events.find((e) => e.status === s)!.atMs;
    expect(ev("filled") - ev("received")).toBeGreaterThan(290); // wall time includes the wait
    expect(d.latencyMs).toBeLessThan(150);
    expect(d.approvalWaitMs).toBeGreaterThanOrEqual(290);
    const report = (await h.app.inject({ method: "GET", url: `/api/reports/${d.strategyId}?range=24h` })).json<{ latency: { maxMs: number }; approvalGated: number }>();
    expect(report.latency.maxMs).toBeLessThan(150);
    expect(report.approvalGated).toBe(1);
  });
});

describe("strategy and limits DTO extras", () => {
  it("exposes and updates dryRun, maxSlippageBps and orderType", async () => {
    await setup();
    const created = await h.app.inject({ method: "POST", url: "/api/strategies", payload: { name: "X" } });
    expect(created.json<StrategyDTO>()).toMatchObject({ dryRun: false, maxSlippageBps: null, orderType: "market" });
    const id = created.json<StrategyDTO>().id;
    const patched = await h.app.inject({ method: "PATCH", url: `/api/strategies/${id}`, payload: { dryRun: true, maxSlippageBps: 30 } });
    expect(patched.json<StrategyDTO>()).toMatchObject({ dryRun: true, maxSlippageBps: 30, orderType: "market" });
    const cleared = await h.app.inject({ method: "PATCH", url: `/api/strategies/${id}`, payload: { maxSlippageBps: null } });
    expect(cleared.json<StrategyDTO>().maxSlippageBps).toBeNull();
    expect((await h.app.inject({ method: "PATCH", url: `/api/strategies/${id}`, payload: { orderType: "limit" } })).statusCode).toBe(400);
    expect((await h.app.inject({ method: "GET", url: `/api/strategies/${id}` })).json<StrategyDTO>().dryRun).toBe(true);
  });

  it("limits default approvalExpirySec to 120 and stamp updatedAt on save", async () => {
    await setup();
    const before = (await h.app.inject({ method: "GET", url: "/api/limits" })).json<RiskLimits>();
    expect(before).toMatchObject({ approvalExpirySec: 120, updatedAt: null });
    const t0 = Date.now();
    const saved = (await putLimits({ maxLeverage: 7, updatedAt: 5 })).json<RiskLimits>(); // a client-sent updatedAt is ignored
    expect(saved.maxLeverage).toBe(7);
    expect(saved.updatedAt).toBeGreaterThanOrEqual(t0);
    expect((await h.app.inject({ method: "GET", url: "/api/limits" })).json<RiskLimits>().updatedAt).toBe(saved.updatedAt);
  });
});
