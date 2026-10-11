import { existsSync } from "node:fs";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { openDb } from "./db/connection";
import { createPerplLayer } from "./perpl/layer";

async function main() {
  // Optional .env (Node 22+). Real environment variables win.
  for (const f of [".env", "apps/server/.env"]) {
    if (existsSync(f)) {
      try {
        process.loadEnvFile(f);
      } catch {
        /* ignore malformed env file; zod will report missing values */
      }
    }
  }

  const config = loadConfig(process.env, { devKeyFile: true });
  const db = openDb(config.databasePath);

  // The Perpl layer (per-user client registry, executor and, with PERPL_MODE=sim, the in-process simulator) is built
  // by buildApp once the logger, repos and event bus exist, and started on ready.
  const { app } = await buildApp({ config, db, perplLayer: createPerplLayer(), logger: { level: process.env.LOG_LEVEL ?? "info" } });

  for (const w of config.warnings) {
    const bar = "!".repeat(78);
    process.stderr.write(`\n${bar}\n  WARNING: ${w}\n${bar}\n\n`);
  }
  app.log.info(
    config.perplMode === "sim"
      ? "PERPL_MODE=sim: orders go to the in-process Perpl simulator. POST /api/perpl/sim/connect (or the onboarding button) connects a funded simulated account."
      : `PERPL_MODE=live: orders go to Perpl (${config.perplApiBase}). A user's API key is validated against Perpl when it is saved.`,
  );

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(`Hermes server listening on :${config.port}, webhook base ${config.publicBaseUrl}/hooks/<strategyId>`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
