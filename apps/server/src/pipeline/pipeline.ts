import { randomUUID } from "node:crypto";
import {
  MARKETS,
  hiresNowMs,
  isMarketSymbol,
  type AlertStatus,
  type Approval,
  type BlockReason,
  type MarketSymbol,
  type NormalizedAlert,
  type Position,
  type RiskLimits,
  type Side,
} from "@hermes/shared";
import type { EventBus } from "../events/bus";
import type { Executor, ExecutionEvent, OrderIntent } from "../execution/types";
import { conflict, notFound } from "../errors";
import { silentLogger, type Logger } from "../logger";
import type { PerplClient, PerplClientProvider } from "../perpl/types";
import { evaluate, type PositionState, type RiskIntent, type RiskResult, type RiskState } from "../risk/evaluate";
import { utcDay, type AlertRow, type Repos, type StrategyRow } from "../db/repos";

export const APPROVAL_TTL_MS = 120_000;

/** Higher = further along the happy path. Failure statuses are final. */
const RANK: Partial<Record<AlertStatus, number>> = {
  received: 0,
  verified: 1,
  risk_checked: 2,
  pending_approval: 3,
  sent: 4,
  accepted: 5,
  partially_filled: 6,
  filled: 7,
};
const FINAL_FAILURES: readonly AlertStatus[] = ["rejected_auth", "duplicate", "invalid", "blocked", "expired", "failed"];

export interface PipelineDeps {
  repos: Repos;
  bus: EventBus;
  executor: Executor;
  perpl?: PerplClientProvider | undefined;
  log?: Logger;
  approvalTtlMs?: number;
  now?: () => number;
}

/**
 * verified alert -> risk -> (approval queue) -> executor, plus persistence of everything the executor reports.
 * All state transitions go through {@link Pipeline.transition}, which writes the alert_events row.
 */
export class Pipeline {
  private readonly repos: Repos;
  private readonly bus: EventBus;
  private readonly log: Logger;
  private readonly ttl: number;
  private readonly now: () => number;
  private executor: Executor;
  private unsubscribe: (() => void) | undefined;
  private timers = new Map<string, NodeJS.Timeout>();
  private perpl: PerplClientProvider | undefined;
  /** Tracks in-flight process() promises so tests can await quiescence. */
  private inflight = new Set<Promise<void>>();

  constructor(deps: PipelineDeps) {
    this.repos = deps.repos;
    this.bus = deps.bus;
    this.executor = deps.executor;
    this.perpl = deps.perpl;
    this.log = deps.log ?? silentLogger;
    this.ttl = deps.approvalTtlMs ?? APPROVAL_TTL_MS;
    this.now = deps.now ?? Date.now;
  }

  /** Subscribe to the executor and re-arm timers for approvals that were pending before a restart. */
  start(): void {
    this.attachExecutor(this.executor);
    for (const a of this.repos.approvals.allPending()) this.armApprovalTimer(a.id, a.expiresAt);
  }

  /** Stop timers and executor subscription. Call `await idle()` first for a graceful drain. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Swap in the real executor once the Perpl layer is ready. */
  setExecutor(executor: Executor): void {
    this.unsubscribe?.();
    this.executor = executor;
    this.attachExecutor(executor);
  }

  setPerplProvider(provider: PerplClientProvider | undefined): void {
    this.perpl = provider;
  }

  private attachExecutor(executor: Executor): void {
    this.unsubscribe = executor.onEvent((e) => {
      try {
        this.onExecutionEvent(e);
      } catch (err) {
        this.log.error({ err, event: e }, "failed to handle execution event");
      }
    });
  }

  /** Resolves when all currently running process() calls finished (for tests and graceful shutdown). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  // -------------------------------------------------------------------------
  // Entry point
  // -------------------------------------------------------------------------

  /** Fire-and-forget hand-off from ingest, deferred to the next tick so the HTTP reply goes out first. Never throws. */
  enqueue(alertId: string): void {
    const p: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.process(alertId))
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  async process(alertId: string): Promise<void> {
    try {
      await this.run(alertId);
    } catch (err) {
      this.log.error({ err, alertId }, "pipeline error");
      try {
        this.transition(alertId, "failed", { errorCode: "pipeline_error" }, {
          message: err instanceof Error ? err.message : String(err),
        });
      } catch (err2) {
        this.log.error({ err: err2, alertId }, "could not record pipeline failure");
      }
    }
  }

  private async run(alertId: string): Promise<void> {
    const alert = this.repos.alerts.get(alertId);
    if (!alert || !alert.parsedJson) throw new Error("alert missing or unparsed");
    const strategy = this.repos.strategies.get(alert.strategyId);
    if (!strategy) throw new Error("strategy missing");
    const parsed = JSON.parse(alert.parsedJson) as NormalizedAlert;
    const limits = this.repos.limits.get(alert.userId);
    const client = this.perpl?.get(alert.userId);

    const { state, positionFor } = await this.buildState(alert, strategy, parsed, client, parsed.intent.kind === "close");
    const price = parsed.price ?? parsed.limitPrice ?? (await this.markPrice(client, parsed.market));
    const notionalUsd = this.notional(parsed, price);

    const riskIntent: RiskIntent = {
      market: parsed.market,
      kind: parsed.intent.kind,
      side: parsed.intent.side,
      notionalUsd,
      leverage: parsed.leverage,
    };
    const result = evaluate(riskIntent, limits, state);

    // Remember what we resolved, even for blocked alerts (the UI and report card read these columns).
    const pos = positionFor(parsed.market);
    const resolvedSide: Side | null = parsed.intent.side ?? (parsed.intent.kind === "close" ? (pos?.side ?? null) : null);
    this.repos.alerts.patch(alertId, {
      market: parsed.market,
      side: resolvedSide,
      kind: parsed.intent.kind,
      sizeUsd: parsed.intent.kind === "open" ? notionalUsd : (parsed.sizeUsd ?? null),
      alertPrice: parsed.price ?? null,
    });

    if (!result.ok) return this.block(alertId, result);

    this.transition(alertId, "risk_checked", {}, { needsApproval: result.needsApproval, notionalUsd });
    if (result.needsApproval) return this.requestApproval(alert);
    await this.execute(alertId, parsed, limits, pos, price, client);
  }

  // -------------------------------------------------------------------------
  // Approval flow
  // -------------------------------------------------------------------------

  private requestApproval(alert: AlertRow): void {
    const createdAt = this.now();
    const expiresAt = createdAt + this.ttl;
    const row = this.repos.approvals.insert({
      id: `apr_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      alertId: alert.id,
      userId: alert.userId,
      createdAt,
      expiresAt,
    });
    this.transition(alert.id, "pending_approval", {}, { approvalId: row.id, expiresAt });
    this.bus.publish(alert.userId, { type: "approval", approval: this.repos.toApprovalDto(row) });
    this.armApprovalTimer(row.id, expiresAt);
  }

  private armApprovalTimer(approvalId: string, expiresAt: number): void {
    const delay = Math.max(0, expiresAt - this.now());
    const t = setTimeout(() => this.expireApproval(approvalId), delay);
    t.unref();
    this.timers.set(approvalId, t);
  }

  private clearTimer(approvalId: string): void {
    const t = this.timers.get(approvalId);
    if (t) clearTimeout(t);
    this.timers.delete(approvalId);
  }

  expireApproval(approvalId: string): void {
    this.clearTimer(approvalId);
    const row = this.repos.approvals.get(approvalId);
    if (!row || row.status !== "pending") return;
    if (!this.repos.approvals.decide(approvalId, "expired", this.now())) return;
    this.transition(row.alertId, "expired", { blockReason: "approval_expired" }, { approvalId });
    this.publishApproval(approvalId);
  }

  /** Approve a pending approval and continue to execution. */
  async approve(approvalId: string, userId: string): Promise<Approval> {
    const row = this.ownedPending(approvalId, userId);
    if (this.now() >= row.expiresAt) {
      this.expireApproval(approvalId);
      throw conflict("This approval has expired.", "approval_expired");
    }
    if (!this.repos.approvals.decide(approvalId, "approved", this.now())) {
      throw conflict("This approval was already decided.", "approval_not_pending");
    }
    this.clearTimer(approvalId);
    this.publishApproval(approvalId);
    const p = this.resumeAfterApproval(row.alertId).finally(() => this.inflight.delete(p));
    this.inflight.add(p);
    await p;
    return this.repos.toApprovalDto(this.repos.approvals.get(approvalId)!);
  }

  reject(approvalId: string, userId: string): Approval {
    const row = this.ownedPending(approvalId, userId);
    if (!this.repos.approvals.decide(approvalId, "rejected", this.now())) {
      throw conflict("This approval was already decided.", "approval_not_pending");
    }
    this.clearTimer(approvalId);
    this.transition(row.alertId, "blocked", { blockReason: "approval_rejected" }, { approvalId });
    this.publishApproval(approvalId);
    return this.repos.toApprovalDto(this.repos.approvals.get(approvalId)!);
  }

  private ownedPending(approvalId: string, userId: string) {
    const row = this.repos.approvals.get(approvalId);
    if (!row || row.userId !== userId) throw notFound("approval");
    if (row.status !== "pending") throw conflict(`Approval is already ${row.status}.`, "approval_not_pending");
    return row;
  }

  private publishApproval(approvalId: string): void {
    const row = this.repos.approvals.get(approvalId);
    if (row) this.bus.publish(row.userId, { type: "approval", approval: this.repos.toApprovalDto(row) });
  }

  /** After a human approved: re-run the risk gate against fresh state (age 0, approval waived), then execute. */
  private async resumeAfterApproval(alertId: string): Promise<void> {
    try {
      const alert = this.repos.alerts.get(alertId);
      if (!alert?.parsedJson) throw new Error("alert missing or unparsed");
      const strategy = this.repos.strategies.get(alert.strategyId);
      if (!strategy) throw new Error("strategy missing");
      const parsed = JSON.parse(alert.parsedJson) as NormalizedAlert;
      const limits: RiskLimits = { ...this.repos.limits.get(alert.userId), approvalThresholdUsd: 0 };
      const client = this.perpl?.get(alert.userId);
      const { state, positionFor } = await this.buildState(alert, strategy, parsed, client, true);
      state.alertAgeSec = 0;
      const price = parsed.price ?? parsed.limitPrice ?? (await this.markPrice(client, parsed.market));
      const notionalUsd = this.notional(parsed, price);
      const result = evaluate(
        { market: parsed.market, kind: parsed.intent.kind, side: parsed.intent.side, notionalUsd, leverage: parsed.leverage },
        limits,
        state,
      );
      if (!result.ok) return this.block(alertId, result);
      await this.execute(alertId, parsed, limits, positionFor(parsed.market), price, client);
    } catch (err) {
      this.log.error({ err, alertId }, "post-approval error");
      this.transition(alertId, "failed", { errorCode: "pipeline_error" }, {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Risk state
  // -------------------------------------------------------------------------

  private async buildState(
    alert: AlertRow,
    strategy: StrategyRow,
    parsed: NormalizedAlert,
    client: PerplClient | undefined,
    needFreshPositions: boolean,
  ): Promise<{ state: RiskState; positionFor: (market: string) => PositionState | undefined }> {
    const now = this.now();
    let list: Position[] | undefined;
    if (client && client.isConnected()) {
      try {
        list = await withTimeout(client.getPositions(), needFreshPositions ? 2500 : 1500);
        this.repos.positions.replaceAll(alert.userId, list);
      } catch (err) {
        this.log.warn({ err }, "getPositions failed, using stored snapshot");
      }
    }
    list ??= this.repos.positions.list(alert.userId);
    const positions: Record<string, PositionState | undefined> = {};
    let openNotionalUsd = 0;
    for (const p of list) {
      positions[p.market] = { side: p.side, size: p.size, notionalUsd: p.notionalUsd };
      openNotionalUsd += p.notionalUsd;
    }
    const alertTime = parsed.timeMs ?? alert.receivedAtMs;
    const state: RiskState = {
      strategyEnabled: strategy.enabled,
      positions,
      realizedPnlTodayUsd: this.repos.dailyPnl.get(alert.userId, utcDay(now)),
      openNotionalUsd,
      ordersLastMinute: this.repos.orders.countSince(alert.userId, now - 60_000),
      // Without any Perpl provider (the stub executor setup) we let the executor fail the order with
      // `perpl_not_connected` so the full lifecycle is recorded. With a provider, a user who has no client yet
      // (nothing connected) or whose client is down is blocked here, before anything is sent.
      perplConnected: client ? client.isConnected() : !this.perpl,
      alertAgeSec: Math.max(0, (now - alertTime) / 1000),
    };
    return { state, positionFor: (m) => positions[m.toUpperCase()] };
  }

  private async markPrice(client: PerplClient | undefined, market: string): Promise<number | undefined> {
    if (!client || !client.isConnected() || !isMarketSymbol(market)) return undefined;
    try {
      const p = await withTimeout(client.getMarkPrice(MARKETS[market].id), 1500);
      return Number.isFinite(p) && p > 0 ? p : undefined;
    } catch {
      return undefined;
    }
  }

  /** Notional of an opening order in USD (null if it cannot be determined). */
  private notional(parsed: NormalizedAlert, price: number | undefined): number | null {
    if (parsed.intent.kind === "close") return null;
    if (parsed.sizeUsd !== undefined) return parsed.sizeUsd;
    if (parsed.size !== undefined && price !== undefined) return parsed.size * price;
    return null;
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  private async execute(
    alertId: string,
    parsed: NormalizedAlert,
    limits: RiskLimits,
    pos: PositionState | undefined,
    price: number | undefined,
    _client: PerplClient | undefined,
  ): Promise<void> {
    const alert = this.repos.alerts.get(alertId)!;
    if (!isMarketSymbol(parsed.market)) throw new Error("unreachable: unknown market passed risk");
    const market: MarketSymbol = parsed.market;
    const kind = parsed.intent.kind;
    const side: Side = parsed.intent.side ?? pos!.side;

    const intent: OrderIntent = {
      market,
      marketId: MARKETS[market].id,
      side,
      kind,
      type: parsed.orderType,
      maxSlippageBps: parsed.maxSlippageBps ?? limits.defaultSlippageBps,
    };
    if (parsed.limitPrice !== undefined) intent.limitPrice = parsed.limitPrice;
    if (parsed.leverage !== undefined) intent.leverage = parsed.leverage;
    if (parsed.price !== undefined) intent.referencePrice = parsed.price;
    if (kind === "open") {
      if (parsed.sizeUsd !== undefined) intent.sizeUsd = parsed.sizeUsd;
      if (parsed.size !== undefined) intent.sizeBase = parsed.size;
    } else if (parsed.size === undefined && parsed.sizeUsd === undefined) {
      intent.closeAll = true;
    } else {
      if (parsed.sizeUsd !== undefined) intent.sizeUsd = parsed.sizeUsd;
      if (parsed.size !== undefined) intent.sizeBase = pos ? Math.min(parsed.size, pos.size) : parsed.size;
    }

    const order = this.repos.orders.insert({
      alertId,
      userId: alert.userId,
      marketId: intent.marketId,
      side,
      kind,
      type: intent.type,
      size: intent.sizeBase ?? null,
      price: intent.limitPrice ?? price ?? null,
      leverage: intent.leverage ?? null,
    });
    this.bus.publish(alert.userId, { type: "order", order });

    try {
      await this.executor.submit(intent, { alertId, userId: alert.userId, orderId: order.id });
    } catch (err) {
      this.log.error({ err, alertId }, "executor.submit threw");
      this.onExecutionEvent({
        type: "failed",
        alertId,
        userId: alert.userId,
        orderId: order.id,
        atMs: hiresNowMs(),
        code: "executor_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private onExecutionEvent(e: ExecutionEvent): void {
    const order = this.repos.orders.get(e.orderId);
    if (!order) {
      this.log.warn({ event: e }, "execution event for unknown order");
      return;
    }
    const publishOrder = (patch: Parameters<Repos["orders"]["patch"]>[1]) => {
      const updated = this.repos.orders.patch(e.orderId, patch);
      if (updated) this.bus.publish(e.userId, { type: "order", order: updated });
    };

    switch (e.type) {
      case "sent": {
        // A retry under a new rq re-announces `sent`: update rq/sn/lb but never move the order backwards.
        const patch: Parameters<Repos["orders"]["patch"]>[1] =
          order.status === "pending" || order.status === "sent" ? { status: "sent" } : {};
        if (e.rq !== undefined) patch.rq = e.rq;
        if (e.sn !== undefined) patch.sn = e.sn;
        if (e.lb !== undefined) patch.lb = e.lb;
        if (e.size !== undefined) patch.size = e.size;
        if (e.price !== undefined) patch.price = e.price;
        publishOrder(patch);
        if (e.rq !== undefined) this.repos.connections.setLastRq(e.userId, e.rq);
        this.transition(e.alertId, "sent", {}, { orderId: e.orderId, rq: e.rq, sn: e.sn, lb: e.lb }, e.atMs);
        break;
      }
      case "accepted": {
        // Perpl acknowledges twice (forwarded, then the exchange order id). The second one only enriches the order.
        const already = order.status === "accepted" || order.status === "partially_filled" || order.status === "filled";
        publishOrder({
          ...(already ? {} : { status: "accepted" as const }),
          ...(e.perplOrderId ? { perplOrderId: e.perplOrderId } : {}),
        });
        if (!already) this.transition(e.alertId, "accepted", {}, { orderId: e.orderId, perplOrderId: e.perplOrderId }, e.atMs);
        break;
      }
      case "partially_filled":
      case "filled": {
        const fill = this.repos.fills.insert({
          orderId: e.orderId,
          alertId: e.alertId,
          userId: e.userId,
          externalId: e.fill.externalId ?? null,
          price: e.fill.price,
          size: e.fill.size,
          fee: e.fill.fee,
          realizedPnl: e.fill.realizedPnl ?? null,
          txHash: e.fill.txHash ?? null,
          block: e.fill.block ?? null,
          atMs: e.fill.atMs,
        });
        if (!fill) return; // replayed fill
        if (e.fill.realizedPnl !== undefined) {
          this.repos.dailyPnl.add(e.userId, utcDay(Math.round(e.fill.atMs)), e.fill.realizedPnl);
        }
        // Size and price of the order become what actually executed (volume weighted over its fills).
        const mine = this.repos.fills.byAlert(e.alertId).filter((f) => f.orderId === e.orderId);
        const filledSize = mine.reduce((a, f) => a + f.size, 0);
        const vwap = filledSize > 0 ? mine.reduce((a, f) => a + f.price * f.size, 0) / filledSize : e.fill.price;
        publishOrder({
          status: e.type,
          size: filledSize > 0 ? filledSize : e.fill.size,
          price: vwap,
          ...(e.perplOrderId ? { perplOrderId: e.perplOrderId } : {}),
          ...(e.fill.txHash ? { txHash: e.fill.txHash } : {}),
        });
        this.bus.publish(e.userId, { type: "fill", fill });
        this.transition(
          e.alertId,
          e.type,
          {},
          { orderId: e.orderId, fillId: fill.id, price: fill.price, size: fill.size, txHash: fill.txHash },
          e.atMs,
        );
        void this.refreshPositions(e.userId);
        break;
      }
      case "failed": {
        publishOrder({ status: "failed", errorCode: e.code });
        this.transition(e.alertId, "failed", { errorCode: e.code }, { orderId: e.orderId, code: e.code, message: e.message }, e.atMs);
        break;
      }
    }
  }

  /** Pull positions from the client (if any), persist and push over SSE. */
  async refreshPositions(userId: string): Promise<Position[]> {
    const client = this.perpl?.get(userId);
    if (client?.isConnected()) {
      try {
        const list = await withTimeout(client.getPositions(), 3000);
        this.repos.positions.replaceAll(userId, list);
      } catch (err) {
        this.log.warn({ err }, "refreshPositions failed");
      }
    }
    const positions = this.repos.positions.list(userId);
    this.bus.publish(userId, { type: "positions", positions });
    return positions;
  }

  // -------------------------------------------------------------------------
  // State transitions
  // -------------------------------------------------------------------------

  private block(alertId: string, r: Extract<RiskResult, { ok: false }>): void {
    this.transition(alertId, "blocked", { blockReason: r.reason }, { reason: r.reason, detail: r.detail });
  }

  /**
   * Record an alert_events row (always) and update the alert's current status (monotonic along the happy
   * path; failure statuses are final; a late failure after a fill is recorded but does not change the status).
   */
  transition(
    alertId: string,
    status: AlertStatus,
    patch: { blockReason?: BlockReason | null; errorCode?: string | null } = {},
    detail?: Record<string, unknown>,
    atMs: number = hiresNowMs(),
  ): void {
    const alert = this.repos.alerts.get(alertId);
    if (!alert) return;
    this.repos.alerts.addEvent(alertId, status, atMs, detail ?? null);
    const cur = alert.status;
    const failing = FINAL_FAILURES.includes(status);
    let apply: boolean;
    if (FINAL_FAILURES.includes(cur)) apply = false;
    else if (failing) apply = (RANK[cur] ?? 0) < (RANK.partially_filled as number);
    else apply = (RANK[status] ?? 0) >= (RANK[cur] ?? 0);
    if (apply) this.repos.alerts.patch(alertId, { status, ...patch });
    const record = this.repos.alerts.record(alertId);
    if (record) this.bus.publish(alert.userId, { type: "alert", alert: record });
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
