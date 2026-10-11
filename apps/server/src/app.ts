import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { createAuth, type Auth } from "./auth/plugin";
import { AuthError, DevVerifier, type AuthVerifier } from "./auth/verifier";
import { PrivyVerifier } from "./auth/privy";
import { apiRoutes } from "./api/routes";
import type { Config } from "./config";
import { createRepos, type Repos } from "./db/repos";
import type { Db } from "./db/connection";
import { EventBus } from "./events/bus";
import { StubExecutor } from "./execution/stub-executor";
import type { Executor } from "./execution/types";
import { HermesError } from "./errors";
import { createIngest, type Ingest } from "./ingest/handler";
import { hookRoutes } from "./ingest/routes";
import type { PerplClientProvider } from "./perpl/types";
import { Pipeline } from "./pipeline/pipeline";

export interface BuildAppOptions {
  config: Config;
  db: Db;
  /** Defaults to {@link StubExecutor}, which fails every order with `perpl_not_connected`. */
  executor?: Executor;
  /** Finds the PerplClient of a user (live or simulator). */
  perpl?: PerplClientProvider;
  verifier?: AuthVerifier;
  logger?: boolean | { level: string };
  approvalTtlMs?: number;
}

export interface HermesApp {
  app: FastifyInstance;
  repos: Repos;
  bus: EventBus;
  pipeline: Pipeline;
  ingest: Ingest;
  auth: Auth;
}

const stripSecretsFromUrl = (url: string) => url.replace(/([?&](?:token|ticket)=)[^&]*/g, "$1[redacted]");

export async function buildApp(opts: BuildAppOptions): Promise<HermesApp> {
  const { config } = opts;
  const app = Fastify({
    logger: opts.logger ?? false
      ? {
          level: typeof opts.logger === "object" ? opts.logger.level : "info",
          serializers: {
            req: (req: { method?: string; url?: string }) => ({ method: req.method, url: stripSecretsFromUrl(req.url ?? "") }),
          },
        }
      : false,
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  });

  const repos = createRepos(opts.db);
  const bus = new EventBus();
  const executor = opts.executor ?? new StubExecutor(opts.perpl);
  const pipeline = new Pipeline({
    repos,
    bus,
    executor,
    perpl: opts.perpl,
    log: app.log,
    ...(opts.approvalTtlMs !== undefined ? { approvalTtlMs: opts.approvalTtlMs } : {}),
  });
  pipeline.start();
  app.addHook("onClose", async () => pipeline.stop());

  const verifier: AuthVerifier =
    opts.verifier ??
    (config.authMode === "privy" && config.privyAppId && config.privyAppSecret
      ? new PrivyVerifier(config.privyAppId, config.privyAppSecret)
      : new DevVerifier());
  const auth = createAuth({ config, repos, verifier });
  const ingest = createIngest({ repos, config, pipeline, bus });

  await app.register(cors, {
    origin: config.webOrigin.split(",").map((o) => o.trim()),
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    maxAge: 600,
  });

  app.decorateRequest("user", undefined as never);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HermesError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, ...(err.issues ? { issues: err.issues } : {}) } });
    }
    if (err instanceof AuthError) {
      return reply.code(401).send({ error: { code: "unauthorized", message: err.message } });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: { code: (e.code ?? "request_error").toLowerCase(), message: e.message ?? "Bad request" } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { code: "internal_error", message: "Internal server error" } });
  });
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: { code: "not_found", message: "Route not found" } });
  });

  hookRoutes(app, { ingest });
  apiRoutes(app, { config, repos, auth, pipeline, ingest, bus, perpl: opts.perpl });

  return { app, repos, bus, pipeline, ingest, auth };
}
