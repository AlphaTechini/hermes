import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import path from "node:path";

const SERVER_PREFIXES = ["/api/", "/hooks/", "/healthz"];

const isServerPath = (url: string) => SERVER_PREFIXES.some((p) => url === p.replace(/\/$/, "") || url.startsWith(p));

/**
 * Serves the built web app from the same origin as the API, for a single-service deploy. Unknown GET paths outside
 * the API fall back to index.html so client-side routes (`/live`, `/report/...`) survive a refresh.
 */
export async function registerWebApp(app: FastifyInstance, distDir: string): Promise<void> {
  const root = path.resolve(distDir);
  if (!existsSync(path.join(root, "index.html"))) {
    throw new Error(`WEB_DIST_DIR has no index.html: ${root}`);
  }
  await app.register(fastifyStatic, { root, wildcard: false, index: ["index.html"] });

  app.setNotFoundHandler((req, reply) => {
    const pathname = req.url.split("?")[0] ?? "/";
    if ((req.method === "GET" || req.method === "HEAD") && !isServerPath(pathname)) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.code(404).send({ error: { code: "not_found", message: "Route not found" } });
  });
}
