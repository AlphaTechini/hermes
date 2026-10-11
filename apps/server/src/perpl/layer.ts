import { startPerplSimulator, type PerplSimulator } from "@hermes/perpl";
import type { Config } from "../config";
import type { Repos } from "../db/repos";
import type { EventBus } from "../events/bus";
import { PerplExecutor } from "../execution/perpl-executor";
import type { Executor } from "../execution/types";
import type { Logger } from "../logger";
import { PerplClientRegistry, type RegistryOptions } from "./registry";
import type { PerplRuntime } from "./runtime";
import { SIM_START_BALANCE_AUSD } from "./sim-keys";

/** Everything the server needs from the Perpl integration, wired together. */
export interface PerplLayer {
  provider: PerplRuntime;
  executor: Executor;
  registry: PerplClientRegistry;
  /** Present in PERPL_MODE=sim. */
  simulator?: PerplSimulator | undefined;
  /** Starts the per-user clients (boot). Called by buildApp on ready. */
  start(): Promise<void>;
  /** Closes every client and the simulator if this layer started it. */
  stop(): Promise<void>;
}

export interface PerplLayerOptions {
  /** Use an already running simulator (tests) instead of starting one on PERPL_SIM_PORT. It is not stopped by `stop()`. */
  simulator?: PerplSimulator;
  registry?: Partial<RegistryOptions>;
}

export type PerplLayerFactory = (deps: { config: Config; repos: Repos; bus: EventBus; log: Logger }) => Promise<PerplLayer>;

/** Start the in-process simulator on the configured port; if that port is taken, fall back to a free one. */
export async function startConfiguredSimulator(config: Config, log: Logger): Promise<PerplSimulator> {
  const base = { defaultBalanceAusd: SIM_START_BALANCE_AUSD } as const;
  let sim: PerplSimulator;
  try {
    sim = await startPerplSimulator({ ...base, port: config.perplSimPort });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    log.warn({ port: config.perplSimPort }, `PERPL_SIM_PORT ${config.perplSimPort} is in use, picking a free port for the simulator`);
    sim = await startPerplSimulator({ ...base, port: 0 });
  }
  log.info({ rest: sim.url, ws: sim.wsUrl }, "Perpl simulator listening (PERPL_MODE=sim): synthetic prices, same wire protocol as testnet");
  return sim;
}

/** Build the registry + executor for the configured mode. In sim mode this boots the simulator in-process. */
export function createPerplLayer(opts: PerplLayerOptions = {}): PerplLayerFactory {
  return async ({ config, repos, bus, log }) => {
    const ownSim = config.perplMode === "sim" && !opts.simulator;
    const simulator = config.perplMode === "sim" ? (opts.simulator ?? (await startConfiguredSimulator(config, log))) : undefined;
    const registry = new PerplClientRegistry({ config, repos, bus, log, simulator, ...opts.registry });
    const executor = new PerplExecutor(registry, log);
    return {
      provider: registry,
      executor,
      registry,
      simulator,
      start: () => registry.start(),
      stop: async () => {
        await registry.stop();
        if (ownSim) await simulator?.stop();
      },
    };
  };
}
