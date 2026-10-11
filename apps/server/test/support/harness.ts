import type { FastifyInstance } from "fastify";
import { buildApp, type HermesApp } from "../../src/app";
import { loadConfig, type Config } from "../../src/config";
import { openDb } from "../../src/db/connection";
import type { Executor } from "../../src/execution/types";
import type { PerplClientProvider } from "../../src/perpl/types";

export interface Harness extends HermesApp {
  db: import("../../src/db/connection").Db;
  config: Config;
  close(): Promise<void>;
}

export async function makeHarness(
  opts: { executor?: Executor; perpl?: PerplClientProvider; approvalTtlMs?: number; env?: Record<string, string> } = {},
): Promise<Harness> {
  const config = loadConfig({
    NODE_ENV: "test",
    HERMES_MASTER_KEY: "11".repeat(32),
    AUTH_MODE: "dev",
    PUBLIC_BASE_URL: "https://hermes.test",
    ...opts.env,
  });
  const db = openDb(":memory:");
  const h = await buildApp({
    config,
    db,
    ...(opts.executor ? { executor: opts.executor } : {}),
    ...(opts.perpl ? { perpl: opts.perpl } : {}),
    ...(opts.approvalTtlMs !== undefined ? { approvalTtlMs: opts.approvalTtlMs } : {}),
  });
  await h.app.ready();
  return {
    ...h,
    config,
    db,
    async close() {
      await h.app.close();
      db.close();
    },
  };
}

export async function createStrategy(
  app: FastifyInstance,
  body: Record<string, unknown> = { name: "Test strategy" },
): Promise<{ id: string; secret: string }> {
  const res = await app.inject({ method: "POST", url: "/api/strategies", payload: body });
  if (res.statusCode !== 201) throw new Error(`create strategy failed: ${res.body}`);
  const j = res.json() as { id: string; secret: string };
  return { id: j.id, secret: j.secret };
}

export function postHook(app: FastifyInstance, strategyId: string, body: string | object, contentType = "text/plain") {
  return app.inject({
    method: "POST",
    url: `/hooks/${strategyId}`,
    headers: { "content-type": contentType },
    payload: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Poll until `fn` returns a truthy value. */
export async function waitFor<T>(fn: () => T | undefined | false | null, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const SETTLED = ["filled", "partially_filled", "blocked", "failed", "expired", "pending_approval", "rejected_auth", "invalid", "duplicate"];
export async function settled(h: Harness, alertId: string) {
  return waitFor(() => {
    const a = h.repos.alerts.get(alertId);
    return a && SETTLED.includes(a.status) ? a : undefined;
  });
}
