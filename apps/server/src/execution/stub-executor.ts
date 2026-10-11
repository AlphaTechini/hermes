import { hiresNowMs } from "@hermes/shared";
import type { PerplClientProvider } from "../perpl/types";
import { ExecutionEmitter, type ExecutionContext, type Executor, type OrderIntent } from "./types";

/**
 * Placeholder executor used until the real Perpl executor is registered: no client is available, so
 * every order fails with `perpl_not_connected`. Keeps the whole pipeline runnable end to end.
 */
export class StubExecutor implements Executor {
  private emitter = new ExecutionEmitter();
  onEvent = this.emitter.onEvent;

  constructor(private readonly perpl?: PerplClientProvider) {}

  async submit(_order: OrderIntent, ctx: ExecutionContext): Promise<void> {
    const client = this.perpl?.get(ctx.userId);
    const reason = client ? "stub_executor_has_no_trading_logic" : "perpl_not_connected";
    // Emit asynchronously, as a real executor would.
    queueMicrotask(() =>
      this.emitter.emit({
        type: "failed",
        alertId: ctx.alertId,
        userId: ctx.userId,
        orderId: ctx.orderId,
        atMs: hiresNowMs(),
        code: reason,
        message:
          reason === "perpl_not_connected"
            ? "No Perpl client is registered for this user. Connect Perpl or run with PERPL_MODE=sim."
            : "The stub executor cannot place orders.",
      }),
    );
  }
}
