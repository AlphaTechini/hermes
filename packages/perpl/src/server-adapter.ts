/**
 * Thin adapter: `toServerClient(client)` returns an object that satisfies the `PerplClient` interface declared in
 * apps/server/src/perpl/types.ts (re-declared structurally below so this package does not import from the app).
 *
 * Mapping notes
 *  - `placeOrder` resolves as soon as the first frame was handed to the socket (`{sn, rq, lb}`); everything afterwards
 *    is pushed to `onStatus` listeners as `PerplEvent`s (mt:3 / mt:24 as `order`, mt:25 as `fill`, mt:26/27 as `positions`,
 *    mt:21 as `account`, connection state as `connection`).
 *  - The tracker owns rq management and retries (same-rq retry, new rq after failure), so the server's executor does
 *    not need to. Passing `rq` re-sends an in-flight order with that exact rq.
 *  - A failure before anything was sent (validation, no account, forwarding disabled) rejects `placeOrder` with
 *    `PerplOrderRejectedError` AND emits an `order` event with status `rejected`.
 */
import type { AccountSummary, Position as SharedPosition } from "@hermes/shared";
import { OrderFlag, OrderType } from "./protocol";
import type { PerplClient, PerplPosition } from "./client";
import type { FailureInfo, FillInfo, OrderIntent } from "./order-tracker";
import { leverageToHundredths, sizeToLots, toScaledNumber } from "./scaling";

/** Structural copy of apps/server/src/perpl/types.ts. Keep in sync. */
export type ServerOrderTypeCode = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export interface ServerPlaceOrderParams {
  marketId: number;
  type: ServerOrderTypeCode;
  size: number;
  price?: number;
  leverage?: number;
  flags?: 0 | 1 | 2 | 4;
  maxSlippageBps?: number;
  rq?: number;
  lastExecutionBlock?: number;
}
export interface ServerPlaceOrderResult {
  sn: number;
  rq: number;
  lb?: number;
}
export interface ServerCancelParams {
  marketId: number;
  orderId: string;
  rq?: number;
}
export type ServerPerplEvent =
  | { kind: "connection"; state: "connected" | "disconnected" | "reconnecting" }
  | {
      kind: "order";
      sn?: number;
      rq?: number;
      orderId?: string;
      status: "accepted" | "partially_filled" | "filled" | "cancelled" | "rejected" | "expired";
      errorCode?: string;
      message?: string;
      atMs: number;
    }
  | {
      kind: "fill";
      sn?: number;
      rq?: number;
      orderId?: string;
      fillId?: string;
      price: number;
      size: number;
      fee: number;
      realizedPnl?: number;
      txHash?: string;
      block?: number;
      atMs: number;
    }
  | { kind: "positions"; positions: SharedPosition[] }
  | { kind: "account"; account: AccountSummary };
export type ServerPerplEventListener = (event: ServerPerplEvent) => void;

export interface ServerPerplClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  isConnected(): boolean;
  onStatus(cb: ServerPerplEventListener): () => void;
  getAccount(): Promise<AccountSummary>;
  getPositions(): Promise<SharedPosition[]>;
  getMarkPrice(marketId: number): Promise<number>;
  placeOrder(params: ServerPlaceOrderParams): Promise<ServerPlaceOrderResult>;
  cancel(params: ServerCancelParams): Promise<ServerPlaceOrderResult>;
  headBlock(): Promise<number>;
}

export class PerplOrderRejectedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PerplOrderRejectedError";
    this.code = code;
  }
}

function toSharedPosition(p: PerplPosition): SharedPosition {
  return {
    market: p.market,
    side: p.side,
    size: p.size,
    entryPrice: p.entryPrice,
    markPrice: p.markPrice,
    upnl: p.upnl,
    notionalUsd: p.notionalUsd,
    updatedAt: p.updatedAtMs,
  };
}

export function toServerClient(client: PerplClient): ServerPerplClient {
  const listeners = new Set<ServerPerplEventListener>();
  const emit = (e: ServerPerplEvent): void => {
    for (const l of [...listeners]) {
      try {
        l(e);
      } catch {
        // a faulty listener must never break the client
      }
    }
  };

  let wired = false;
  const wire = (): void => {
    if (wired) return;
    wired = true;
    client.on("connected", () => emit({ kind: "connection", state: "connected" }));
    client.on("disconnected", (d) => emit({ kind: "connection", state: d.willReconnect ? "reconnecting" : "disconnected" }));
    client.on("positions", (ps) => emit({ kind: "positions", positions: ps.map(toSharedPosition) }));
    client.on("account", () => {
      void client
        .getAccount()
        .then((a) => emit({ kind: "account", account: toAccountSummary(a) }))
        .catch(() => {});
    });
  };

  const intentFrom = (p: ServerPlaceOrderParams): OrderIntent => {
    const market = client.getMarketSpec(p.marketId);
    if (!market) throw new PerplOrderRejectedError("unknown_market", `unknown market ${p.marketId}`);
    const isCancel = p.type === OrderType.Cancel;
    const market0 = p.price === undefined || p.price === 0;
    return {
      marketId: p.marketId,
      type: p.type,
      size: isCancel ? 0 : sizeToLots(p.size, market.sizeDecimals, "floor"),
      price: market0 ? 0 : toScaledNumber(p.price as number, market.priceDecimals, "round"),
      flags: p.flags ?? (market0 ? OrderFlag.ImmediateOrCancel : OrderFlag.GoodTillCancel),
      leverage: p.leverage !== undefined ? leverageToHundredths(p.leverage) : isCancel ? 0 : 100,
      ...(p.maxSlippageBps !== undefined ? { maxSlippageBps: Math.min(p.maxSlippageBps, market.maxSlippageBps) } : {}),
      lastExecBlock: p.lastExecutionBlock ?? 0,
      ...(p.rq !== undefined ? { rq: p.rq } : {}),
    };
  };

  const track = (intent: OrderIntent): Promise<ServerPlaceOrderResult> =>
    new Promise<ServerPlaceOrderResult>((resolve, reject) => {
      let sent = false;
      let sn = 0;
      let rq = 0;
      const base = (): { sn?: number; rq?: number } => ({ ...(sn ? { sn } : {}), ...(rq ? { rq } : {}) });
      const fillEvent = (f: FillInfo): ServerPerplEvent => ({
        kind: "fill",
        ...base(),
        orderId: String(f.orderId),
        fillId: `${f.orderId}:${f.txHash ?? f.atMs}:${f.cumulativeSize}`,
        price: f.price,
        size: f.size,
        fee: f.fee,
        ...(f.txHash ? { txHash: f.txHash } : {}),
        ...(f.block !== undefined ? { block: f.block } : {}),
        atMs: f.atMs,
      });
      const failure = (f: FailureInfo): ServerPerplEvent => ({
        kind: "order",
        ...base(),
        status: "rejected",
        errorCode: f.code,
        message: f.message,
        atMs: f.atMs,
      });
      void client.orderTracker
        .placeOrder(intent, {
          sent: (e) => {
            sn = e.sn;
            rq = e.rq;
            if (!sent) {
              sent = true;
              resolve({ sn: e.sn, rq: e.rq, lb: e.lb });
            }
          },
          accepted: (e) => emit({ kind: "order", ...base(), ...(e.orderId !== undefined ? { orderId: String(e.orderId) } : {}), status: "accepted", atMs: e.atMs }),
          partially_filled: (f) => {
            emit(fillEvent(f));
            emit({ kind: "order", ...base(), orderId: String(f.orderId), status: "partially_filled", atMs: f.atMs });
          },
          filled: (f) => {
            emit(fillEvent(f));
            emit({ kind: "order", ...base(), orderId: String(f.orderId), status: "filled", atMs: f.atMs });
          },
          failed: (f) => {
            emit(failure(f));
            if (!sent) reject(new PerplOrderRejectedError(f.code, f.message));
          },
          timeout: (t) => {
            emit({ kind: "order", ...base(), status: "expired", errorCode: "timeout", message: t.reason, atMs: t.atMs });
            if (!sent) reject(new PerplOrderRejectedError("timeout", t.reason));
          },
        })
        .then((outcome) => {
          if (outcome.status === "cancelled") emit({ kind: "order", ...base(), status: "cancelled", atMs: outcome.doneAtMs });
          if (outcome.status === "expired") emit({ kind: "order", ...base(), status: "expired", atMs: outcome.doneAtMs });
        });
    });

  return {
    connect: async () => {
      wire();
      await client.connect();
    },
    close: () => client.close(),
    isConnected: () => client.isConnected(),
    onStatus: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getAccount: async () => toAccountSummary(await client.getAccount()),
    getPositions: async () => (await client.getPositions()).map(toSharedPosition),
    getMarkPrice: (marketId) => client.getMarkPrice(marketId),
    placeOrder: (params) => track(intentFrom(params)),
    cancel: (params) => {
      const market = client.getMarketSpec(params.marketId);
      if (!market) return Promise.reject(new PerplOrderRejectedError("unknown_market", `unknown market ${params.marketId}`));
      return track({
        marketId: params.marketId,
        type: OrderType.Cancel,
        size: 0,
        orderId: Number(params.orderId),
        flags: OrderFlag.GoodTillCancel,
        leverage: 0,
        lastExecBlock: 0,
        ...(params.rq !== undefined ? { rq: params.rq } : {}),
      });
    },
    headBlock: () => client.headBlock(),
  };
}

function toAccountSummary(a: Awaited<ReturnType<PerplClient["getAccount"]>>): AccountSummary {
  return {
    connected: a.connected,
    accountId: a.accountId === null ? null : String(a.accountId),
    collateralUsd: a.balanceUsd + a.positionCollateralUsd,
    equityUsd: a.equityUsd,
    availableUsd: a.availableUsd,
    openNotionalUsd: a.openNotionalUsd,
    unrealizedPnlUsd: a.unrealizedPnlUsd,
    realizedPnlTodayUsd: a.realizedPnlTodayUsd,
    updatedAt: a.updatedAtMs,
    live: a.live,
  };
}
