# Hermes architecture (contract for all contributors)

## Stack
- Monorepo, pnpm workspaces, TypeScript everywhere, Node 22, ESM.
- `apps/server`: Fastify 5, SQLite via `better-sqlite3` (WAL), `zod` for validation, `pino` logs, `ws` for Perpl WebSocket, `@noble/ed25519` / `@noble/hashes` for API-key signing, `viem` for Monad chain reads, Privy server SDK for token verification. Tests with `vitest`.
- `apps/web`: React 18 + Vite + TypeScript + Tailwind CSS v4, `@privy-io/react-auth`, `viem`, `@tanstack/react-query`, `react-router-dom`, `lucide-react`. Live updates over Server-Sent Events from the server.
- `packages/shared`: zod schemas + TS types shared by server and web (alert payload, alert lifecycle, risk limits, API DTOs).

## Runtime modes
- `PERPL_MODE=live`: real Perpl testnet (`https://testnet.perpl.xyz/api`, `wss://testnet.perpl.xyz`).
- `PERPL_MODE=sim`: in-process Perpl simulator that speaks the same WebSocket protocol (same frames, statuses, heartbeats) with a synthetic price feed. Default for local dev and CI, because this build sandbox cannot reach the testnet.
- The executor talks to Perpl only through the `PerplClient` interface, so both modes share all execution logic.

## Alert lifecycle (single source of truth: `alert_events` table)
`received -> verified -> risk_checked -> (pending_approval ->) sent -> accepted -> filled | partially_filled`
Terminal failure states: `rejected_auth` (bad secret), `duplicate`, `invalid` (schema), `blocked` (risk, with `reason` code), `expired` (approval timeout), `failed` (Perpl status error / timeout, with code).
Each transition is a row with a high-resolution timestamp (`performance.timeOrigin + performance.now()`, ms with 3 decimals) so the report card can compute alert-to-fill latency precisely.

## Server modules (apps/server/src)
- `config.ts` env parsing (zod).
- `db/` schema + migrations + typed repositories.
- `ingest/` `POST /hooks/:strategyId` TradingView receiver: accepts `text/plain` or JSON body, constant-time secret compare, idempotency key (explicit `id` or hash of strategy+body+time bucket), replies 200 fast and processes async.
- `risk/` pure function `evaluate(alert, limits, accountState) -> {ok} | {ok:false, reason}`; reasons are an enum.
- `execution/` executor: maps an alert to a Perpl order intent, manages `rq` (seed from `lfr`, strictly increasing, persisted), `sn`, `lb`, retries per the Perpl rules, tracks status until terminal.
- `perpl/` `PerplClient` interface; `live/` real WS + REST client; `sim/` simulator.
- `privy/` access-token verification middleware, user/wallet lookup.
- `api/` REST for the web app (session, strategies, limits, alerts, positions, fills, approvals, report card) + `GET /api/stream` SSE.
- `reports/` report card computations.

## Security
- No secrets in the repo. `.env.example` only.
- Perpl API private keys and webhook secrets are encrypted at rest with AES-256-GCM using `HERMES_MASTER_KEY` (32 bytes hex).
- Perpl API keys are trade-only and cannot withdraw by Perpl design.
