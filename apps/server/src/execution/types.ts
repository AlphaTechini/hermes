import type { MarketSymbol, Side } from "@hermes/shared";

/** A fully resolved order the executor must place on Perpl. Produced by the pipeline after risk checks. */
export interface OrderIntent {
  market: MarketSymbol;
  marketId: number;
  /** Position side acted on (open long/short, or the side being closed). */
  side: Side;
  kind: "open" | "close";
  type: "market" | "limit";
  /** Notional to open (USD). The executor converts using the mark price. Absent for closes. */
  sizeUsd?: number;
  /** Explicit base-unit size (opens with `size`, or partial closes). */
  sizeBase?: number;
  /** Close the entire open position (kind === "close" and no explicit size). */
  closeAll?: boolean;
  limitPrice?: number;
  leverage?: number;
  maxSlippageBps: number;
  /** Chart price from the alert (for reference / slippage reporting only). */
  referencePrice?: number;
}

export interface ExecutionContext {
  alertId: string;
  userId: string;
  /** Pre-created `orders` row. Every event for this order must carry it. */
  orderId: string;
}

interface Base {
  alertId: string;
  userId: string;
  orderId: string;
  /** High-resolution epoch ms. */
  atMs: number;
}

/**
 * Status transitions an executor reports. The pipeline persists them (orders, fills, alert_events),
 * updates the alert status and fans them out over SSE.
 */
export type ExecutionEvent =
  | (Base & { type: "sent"; rq?: number; sn?: number; lb?: number; size?: number; price?: number })
  | (Base & { type: "accepted"; perplOrderId?: string })
  | (Base & {
      type: "partially_filled" | "filled";
      fill: {
        /** Perpl fill id, used to de-duplicate replays. */
        externalId?: string;
        price: number;
        size: number;
        fee: number;
        realizedPnl?: number;
        txHash?: string;
        block?: number;
        atMs: number;
      };
      perplOrderId?: string;
    })
  | (Base & { type: "failed"; code: string; message?: string });

export type ExecutionListener = (event: ExecutionEvent) => void;

export interface Executor {
  /**
   * Place the order. Resolves once the order has been handed off (not when filled); progress comes
   * through {@link Executor.onEvent}. Must not throw for business failures: emit `failed` instead.
   */
  submit(order: OrderIntent, ctx: ExecutionContext): Promise<void>;
  /** Subscribe to status transitions. Returns an unsubscribe function. */
  onEvent(listener: ExecutionListener): () => void;
}

/** Small helper for executor implementations. */
export class ExecutionEmitter {
  private listeners = new Set<ExecutionListener>();
  onEvent = (listener: ExecutionListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  emit(event: ExecutionEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // a faulty listener must never break execution
      }
    }
  }
}
