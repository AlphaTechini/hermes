import { existsSync } from "node:fs";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { openDb } from "./db/connection";

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

  const config = loadConfig();
  const db = openDb(config.databasePath);

  // ---------------------------------------------------------------------------------------------
  // PERPL INTEGRATION POINT
  // The Perpl layer (live client + simulator) plugs in here:
  //   const perpl: PerplClientProvider = createPerplProvider(config, repos);   // implements get(userId) / refresh(userId)
  //   const executor: Executor = new PerplExecutor(perpl, repos);
  // and is passed to buildApp({ executor, perpl }). Until then the StubExecutor fails every order with
  // `perpl_not_connected`, so the whole pipeline is still observable end to end.
  // ---------------------------------------------------------------------------------------------
  const { app } = await buildApp({ config, db, logger: { level: process.env.LOG_LEVEL ?? "info" } });

  for (const w of config.warnings) {
    app.log.warn(`\n${"!".repeat(78)}\n  WARNING: ${w}\n${"!".repeat(78)}`);
  }
  app.log.warn(`No Perpl client provider registered (PERPL_MODE=${config.perplMode}): orders will fail with perpl_not_connected.`);

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
