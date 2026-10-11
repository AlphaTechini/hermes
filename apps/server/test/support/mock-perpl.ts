import { MARKETS, hiresNowMs, marketSymbolById, type AccountSummary, type Position } from "@hermes/shared";
import { ExecutionEmitter, type ExecutionContext, type Executor, type OrderIntent } from "../../src/execution/types";
import type {
  CancelParams,
  PerplClient,
  PerplClientProvider,
  PerplEventListener,
  PlaceOrderParams,
  PlaceOrderResult,
} from "../../src/perpl/types";

/** Test-only PerplClient with hand-controlled state. */
export class MockPerplClient implements PerplClient {
  connected = true;
  positions: Position[] = [];
  prices: Record<number, number> = { [MARKETS.BTC.id]: 100_000, [MARKETS.ETH.id]: 4_000 };
  placed: PlaceOrderParams[] = [];
  private listeners = new Set<PerplEventListener>();
  private sn = 0;
  private rq = 100;

  async connect() {
    this.connected = true;
  }
  async close() {
    this.connected = false;
  }
  isConnected() {
    return this.connected;
  }
  onStatus(cb: PerplEventListener) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  async getAccount(): Promise<AccountSummary> {
    return {
      connected: this.connected,
      accountId: "1",
      collateralUsd: 10_000,
      equityUsd: 10_000,
      availableUsd: 10_000,
      openNotionalUsd: 0,
      unrealizedPnlUsd: 0,
      realizedPnlTodayUsd: 0,
      updatedAt: Date.now(),
      live: true,
    };
  }
  async getPositions() {
    return this.positions.map((p) => ({ ...p }));
  }
  async getMarkPrice(marketId: number) {
    const p = this.prices[marketId];
    if (p === undefined) throw new Error("no price");
    return p;
  }
  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
    this.placed.push(params);
    return { sn: ++this.sn, rq: params.rq ?? ++this.rq };
  }
  async cancel(_p: CancelParams): Promise<PlaceOrderResult> {
    return { sn: ++this.sn, rq: ++this.rq };
  }
  async headBlock() {
    return 1_000;
  }
}

export class MockProvider implements PerplClientProvider {
  constructor(readonly client: MockPerplClient | undefined) {}
  get() {
    return this.client;
  }
}

/** Fills everything at the client's mark price plus `slipBps` (adverse). Maintains the mock client's positions. */
export class TestExecutor extends ExecutionEmitter implements Executor {
  submitted: OrderIntent[] = [];
  mode: "fill" | "partial" | "reject" | "hang" = "fill";
  slipBps = 3;
  constructor(private readonly client: MockPerplClient) {
    super();
  }

  async submit(order: OrderIntent, ctx: ExecutionContext): Promise<void> {
    this.submitted.push(order);
    const base = { alertId: ctx.alertId, userId: ctx.userId, orderId: ctx.orderId };
    const t = () => hiresNowMs();
    const mark = this.client.prices[order.marketId] ?? 1;
    this.emit({ ...base, type: "sent", atMs: t(), rq: 101, sn: 1, lb: 1005 });
    if (this.mode === "hang") return;
    if (this.mode === "reject") {
      this.emit({ ...base, type: "failed", atMs: t(), code: "order_rejected", message: "rejected by test" });
      return;
    }
    this.emit({ ...base, type: "accepted", atMs: t(), perplOrderId: "po-1" });
    const buy = (order.kind === "open") === (order.side === "long");
    const price = mark * (1 + ((buy ? 1 : -1) * this.slipBps) / 1e4);
    const existing = this.client.positions.find((p) => p.market === order.market);
    const size = order.sizeBase ?? (order.sizeUsd ? order.sizeUsd / mark : (existing?.size ?? 0));
    const filled = this.mode === "partial" ? size / 2 : size;
    let realizedPnl: number | undefined;
    if (order.kind === "open") {
      this.client.positions = this.client.positions.filter((p) => p.market !== order.market);
      this.client.positions.push({
        market: order.market,
        side: order.side,
        size: filled,
        entryPrice: price,
        markPrice: mark,
        upnl: 0,
        notionalUsd: filled * mark,
        updatedAt: Date.now(),
      });
    } else if (existing) {
      realizedPnl = (order.side === "long" ? price - existing.entryPrice : existing.entryPrice - price) * filled;
      this.client.positions = this.client.positions.filter((p) => p.market !== order.market);
    }
    this.emit({
      ...base,
      type: this.mode === "partial" ? "partially_filled" : "filled",
      atMs: t(),
      fill: {
        externalId: `f-${this.submitted.length}`,
        price,
        size: filled,
        fee: filled * price * 0.0001,
        ...(realizedPnl !== undefined ? { realizedPnl } : {}),
        txHash: "0xabc",
        block: 1001,
        atMs: t(),
      },
    });
  }
}

export { marketSymbolById };
