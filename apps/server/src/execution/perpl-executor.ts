import type { OrderLifecycleHandlers } from "@hermes/perpl";
import { hiresNowMs } from "@hermes/shared";
import { silentLogger, type Logger } from "../logger";
import type { RawClientProvider } from "../perpl/registry";
import { ExecutionEmitter, type ExecutionContext, type ExecutionEvent, type Executor, type OrderIntent } from "./types";

/**
 * Places orders on Perpl through the user's {@link RawPerplClient} (live or simulated, same code path).
 *
 *  - The order tracker inside the client owns `rq` allocation, same-rq re-sends and new-rq retries. This class never
 *    retries; it only translates the tracker's callbacks into {@link ExecutionEvent}s for the pipeline.
 *  - `submit()` resolves once the first frame was handed to the socket (or the order failed before that), not when it
 *    fills. Everything after that is pushed through `onEvent`.
 *  - Event timestamps are taken when the callback fires (`hiresNowMs()`), so alert -> sent -> fill latencies on the
 *    report card are measured on one clock.
 *  - Realised PnL of a close is the price PnL of the closed lots against the entry price of the position at the time
 *    the close was sent. Fees are reported separately (`fee`), exactly as the report card expects.
 */
export class PerplExecutor implements Executor {
  private readonly emitter = new ExecutionEmitter();
  onEvent = this.emitter.onEvent;

  constructor(
    private readonly clients: RawClientProvider,
    private readonly log: Logger = silentLogger,
  ) {}

  async submit(order: OrderIntent, ctx: ExecutionContext): Promise<void> {
    const base = { alertId: ctx.alertId, userId: ctx.userId, orderId: ctx.orderId };
    let finished = false;
    const emit = (e: ExecutionEvent): void => {
      if (e.type === "failed") {
        if (finished) return;
        finished = true;
      }
      this.emitter.emit(e);
    };
    const fail = (code: string, message: string, atMs = hiresNowMs()): void => emit({ ...base, type: "failed", atMs, code, message });

    if (order.type === "limit") {
      fail("limit_orders_unsupported", "Hermes executes market orders only. Send the alert without order_type=limit (use max_slippage_bps to bound the price).");
      return;
    }
    const client = this.clients.raw(ctx.userId);
    if (!client || !client.isConnected()) {
      fail("perpl_not_connected", "Perpl is not connected for this account. Check the connection on the dashboard.");
      return;
    }

    // Entry price of the position about to be (partly) closed, for the price PnL of the closing fills.
    let entryPrice: number | undefined;
    if (order.kind === "close") {
      try {
        const pos = (await client.getPositions()).find((p) => p.market === order.market && p.side === order.side);
        entryPrice = pos?.entryPrice;
      } catch (err) {
        this.log.warn({ err, alertId: ctx.alertId }, "could not read the position entry price before closing");
      }
    }

    let released: () => void = () => {};
    const handedOff = new Promise<void>((resolve) => (released = resolve));
    const handlers: OrderLifecycleHandlers = {
      sent: (e) => {
        // file the raw frames of this order (and of every retry) under the Hermes order
        this.clients.bindOrderFrames?.(ctx.userId, ctx.orderId, { rq: e.rq, sn: e.sn });
        if (e.kind !== "resend") {
          emit({ ...base, type: "sent", atMs: hiresNowMs(), rq: e.rq, sn: e.sn, lb: e.lb });
        }
        released();
      },
      accepted: (e) => {
        emit({ ...base, type: "accepted", atMs: hiresNowMs(), ...(e.orderId !== undefined ? { perplOrderId: String(e.orderId) } : {}) });
      },
      partially_filled: (f) => this.onFill("partially_filled", f, order, entryPrice, base, emit),
      filled: (f) => this.onFill("filled", f, order, entryPrice, base, emit),
      failed: (f) => {
        fail(f.code, f.message);
        released();
      },
      timeout: (t) => {
        fail(
          "perpl_timeout",
          `No final status from Perpl: ${t.reason}. The outcome is ambiguous: the order may still have executed${t.ambiguous ? " (the connection dropped while it was in flight)" : ""}. Check Perpl before sending it again.`,
        );
        released();
      },
    };

    void client
      .placeMarketOrder({
        market: order.market,
        side: order.side,
        kind: order.kind,
        ...(order.kind === "close" && order.closeAll ? { closeAll: true } : {}),
        ...(order.sizeUsd !== undefined ? { sizeUsd: order.sizeUsd } : {}),
        ...(order.sizeBase !== undefined ? { sizeBase: order.sizeBase } : {}),
        ...(order.leverage !== undefined ? { leverage: order.leverage } : {}),
        maxSlippageBps: order.maxSlippageBps,
        tag: ctx.alertId,
        handlers,
      })
      .then((outcome) => {
        // The callbacks above cover every terminal case; this is the safety net for any path that skipped them.
        if (outcome.status === "failed" && !finished) {
          fail(outcome.failure?.code ?? "order_failed", outcome.failure?.message ?? "Perpl did not execute the order.");
        } else if (outcome.status === "timeout" && !finished) {
          fail("perpl_timeout", "No final status from Perpl. The outcome is ambiguous: check Perpl before sending the order again.");
        } else if ((outcome.status === "open" || outcome.status === "cancelled" || outcome.status === "expired") && outcome.filledSize === 0 && !finished) {
          fail("unfilled", `The order was not filled (${outcome.status}).`);
        }
      })
      .catch((err: unknown) => {
        this.log.error({ err, alertId: ctx.alertId }, "Perpl order tracking threw");
        fail("executor_error", err instanceof Error ? err.message : String(err));
      })
      .finally(() => released());

    await handedOff;
  }

  private onFill(
    type: "partially_filled" | "filled",
    f: Parameters<NonNullable<OrderLifecycleHandlers["filled"]>>[0],
    order: OrderIntent,
    entryPrice: number | undefined,
    base: { alertId: string; userId: string; orderId: string },
    emit: (e: ExecutionEvent) => void,
  ): void {
    const atMs = hiresNowMs();
    let realizedPnl: number | undefined;
    if (order.kind === "close" && entryPrice !== undefined) {
      const dir = order.side === "long" ? 1 : -1;
      realizedPnl = dir * (f.price - entryPrice) * f.size;
    }
    emit({
      ...base,
      type,
      atMs,
      perplOrderId: String(f.orderId),
      fill: {
        // one id per (order, tx, cumulative size): a replayed mt:25 maps to the same row
        externalId: `${f.orderId}:${f.txHash ?? Math.round(f.atMs)}:${f.cumulativeSize}`,
        price: f.price,
        size: f.size,
        fee: f.fee,
        ...(realizedPnl !== undefined ? { realizedPnl } : {}),
        ...(f.txHash ? { txHash: f.txHash } : {}),
        ...(f.block !== undefined ? { block: f.block } : {}),
        atMs,
      },
    });
  }
}
