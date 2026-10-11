import { PerplClient, type PerplClientOptions } from "../src/client";
import { startPerplSimulator, type PerplSimulator, type SimOptions } from "../src/sim";

export interface Rig {
  sim: PerplSimulator;
  client: PerplClient;
  key: ReturnType<PerplSimulator["enrollNewKey"]>;
  rqLog: number[];
  stop(): Promise<void>;
}

/** Fast simulator + client wired together. Reconnects are quick so fault tests stay short. */
export async function startRig(opts: { sim?: SimOptions; client?: Partial<PerplClientOptions>; account?: { balanceAusd?: number; forwarding?: boolean }; connect?: boolean } = {}): Promise<Rig> {
  const sim = await startPerplSimulator({ seed: 7, latencyMs: [20, 60], blockTimeMs: 40, heartbeatIntervalMs: 100, ...opts.sim });
  const key = sim.enrollNewKey(opts.account ?? {});
  const rqLog: number[] = [];
  const client = new PerplClient({
    restUrl: sim.url,
    wsUrl: sim.wsUrl,
    apiKey: key.apiKey,
    apiSecret: key.apiSecret,
    onRqAdvance: (rq) => {
      rqLog.push(rq);
    },
    socket: { backoffMs: [30, 60, 120], jitter: 0, heartbeatTimeoutMs: 3000, authTimeoutMs: 3000 },
    tracker: { ackTimeoutMs: 700, fillGraceMs: 400, retryBackoffMs: 50, ...(opts.client?.tracker ?? {}) },
    ...opts.client,
  });
  if (opts.connect !== false) await client.connect();
  return {
    sim,
    client,
    key,
    rqLog,
    stop: async () => {
      await client.close();
      await sim.stop();
    },
  };
}

export const HASH = /^0x[0-9a-f]{64}$/;

export function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 5000, stepMs = 10): Promise<T> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      let v: T | undefined | false;
      try {
        v = fn();
      } catch (e) {
        reject(e);
        return;
      }
      if (v) return resolve(v);
      if (Date.now() - t0 > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}
