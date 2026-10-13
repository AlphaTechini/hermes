# Single image: the Fastify server also serves the built web app (WEB_DIST_DIR), so one Cloud Run URL covers both.
# Plain Dockerfile syntax on purpose: Cloud Build's docker builder does not enable BuildKit.

FROM node:22-bookworm AS build
WORKDIR /app
RUN corepack enable

# Manifests first so the dependency layer is cached until the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/perpl/package.json packages/perpl/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY apps ./apps
COPY packages ./packages

# Vite inlines VITE_* at build time. The Privy app id is public; leave VITE_API_URL empty for same-origin calls.
ARG VITE_PRIVY_APP_ID=""
ENV VITE_PRIVY_APP_ID=$VITE_PRIVY_APP_ID
RUN pnpm --filter @hermes/web build \
 && pnpm --filter @hermes/server build \
 && pnpm --filter @hermes/server deploy --prod --legacy /out

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    WEB_DIST_DIR=/app/web \
    DATABASE_PATH=/app/data/hermes.db
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./server/package.json
COPY --from=build --chown=node:node /out/node_modules ./server/node_modules
COPY --from=build --chown=node:node /app/apps/server/dist ./server/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./web
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
