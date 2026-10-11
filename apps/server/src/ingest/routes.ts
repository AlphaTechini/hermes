import { hiresNowMs } from "@hermes/shared";
import type { FastifyInstance } from "fastify";
import { MAX_BODY_BYTES, type Ingest } from "./handler";

declare module "fastify" {
  interface FastifyRequest {
    receivedAtMs: number;
  }
}

/**
 * `POST /hooks/:strategyId`. Registered in its own encapsulated scope so the raw-string body parser does not
 * affect the JSON API. Accepts any content type (TradingView uses text/plain or application/json).
 */
export function hookRoutes(app: FastifyInstance, deps: { ingest: Ingest }): void {
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "string", bodyLimit: MAX_BODY_BYTES }, (_req, body, done) => {
      done(null, body);
    });
    scope.decorateRequest("receivedAtMs", 0);
    scope.addHook("onRequest", async (req) => {
      req.receivedAtMs = hiresNowMs();
    });

    scope.post<{ Params: { strategyId: string } }>(
      "/hooks/:strategyId",
      { bodyLimit: MAX_BODY_BYTES },
      async (req, reply) => {
        const rawBody = typeof req.body === "string" ? req.body : "";
        const result = deps.ingest.handle({
          strategyId: req.params.strategyId,
          rawBody,
          receivedAtMs: req.receivedAtMs || hiresNowMs(),
          source: "webhook",
        });
        return reply.code(result.status).send(result.body);
      },
    );
  });
}
