# Submission checklist and bounty mapping

Monad Metropolis hackathon. Submission deadline: **13 Oct 2026, 11:59 PM ET** (about 4:59 AM on 14 Oct in Nigeria). Late submissions are not accepted and the version at the deadline is judged.

Entry: one project, main track **Onchain Finance & Trading** (Track 1), plus the bounties Perpl "Best use of Perpl's API", Privy, and Perpl "Best Analytics / Risk Tool".

## Checklist status

| Item | Status | What remains |
|---|---|---|
| Public GitHub repo with an OSI licence (MIT) | Mostly done | Repo `AlphaTechini/hermes` is public and `LICENSE` (MIT) is in the working tree. GitHub's licence detection returned nothing at last check (the file may not have been pushed yet). Push, then confirm the repo page shows "MIT license". |
| README: setup steps | Done | [README.md](../README.md): quick start (simulator mode) and live testnet setup. Re-run the quick start on a clean clone before submitting. |
| README: AI tool disclosure | Done | "AI tools disclosure" section in the README. |
| README: why Monad | Done | "Why Monad" section, with the measured live figures (median alert-to-fill 989 ms, p95 1.11 s, 0.7 bps median slippage). |
| README: testnet transaction hashes | Done | Faucet, approve, createAccount, allowOrderForwarding and an order fill, with explorer links, plus Privy's `400 policy_violation` denial text. See the [README](../README.md#testnet-transactions). |
| Live run on Monad testnet | Done | 14 Oct 2026 on Cloud Run (europe-west1): Privy email wallet, Hermes signer under the policy, Perpl account #1292, API key created from Hermes, 4 live fills and 1 blocked alert. Alerts were sent with "Send test alert" (same webhook TradingView uses). |
| Confirm unverified Privy and Perpl behaviours on the live run | Mostly done | Confirmed: Privy policy syntax (rule names under 50 characters, fixed), the denial error, server-side Perpl key enrolment without a whitelisted Origin, no geo block from a European server, market IOC orders with `lb: 0`. Not tested: the paste-in key path, reconnect and retry paths under live faults. |
| Commits spread across the build window | In progress | 16 commits, all dated 11 Oct 2026 so far. Keep committing real work through the deadline (live-run fixes, screenshots, README updates). Do not rewrite history. |
| Demo video, 3 minutes or less, public, real Monad transactions | **Todo** | Script and pre-recording checklist: [DEMO.md](DEMO.md). Record in live mode, export under 3:00, upload as public, check the link in a private window. Put the link at the top of the README. |
| Real screenshots | **Todo** | README currently shows design-prototype renders (`design/screenshots/`). Replace with captures of the running app after the live run. |
| Registered on hackathon.monad.xyz | **Todo** | Register, create one project, select Track 1, select bounties: Perpl API, Privy, Perpl Analytics. Check the number of winners per Perpl and Privy bounty on the signed-in dashboard (not confirmed in public pages). |
| No keys or secrets in the repo | Done, re-check at submit | `.env` files and `data/` are git-ignored; only `.env.example` files are tracked. A search of tracked files found no private keys. Run a final scan on the last commit, and do not paste real values into issues, docs or the video. The `.hermes-dev-master-key` file is git-ignored. |
| Tests and typecheck green | Done | `pnpm test`: 440 passing (shared 29, perpl 211, server 152, web 48). `pnpm typecheck` and `pnpm lint` were clean at that run; `apps/web` typecheck was failing at the last check because of in-progress changes to the shared report types. Re-run all three before submitting. |
| One project, one main track | Done | Do not submit a second project. |

### Order of work to the deadline

1. Live run end to end (Privy bootstrap, funded wallet, Perpl account and key, tunnel, TradingView alert). Capture transaction hashes and the denial.
2. Fix whatever the live run breaks (see the unverified list). Commit each fix.
3. Fill in the README table, replace screenshots, add measured latency if it supports the claim.
4. Record and upload the video.
5. Register on hackathon.monad.xyz, select the bounties, submit with the repo and video links.
6. Final pass: clean-clone quick start, secret scan, links.

If behind, the cut order from `details.md` applies: report card, then approval flow, then Privy extras. Never cut the alert-to-order core.

## Judging

Main track (20% each): Product Quality & Completeness, Technical Excellence, Monad Integration, Track Fit & Problem Relevance, Innovation & Impact.

Sponsor bounties: 40% adherence to the bounty's published requirement, 30% technical implementation, 20% Monad integration, 10% innovation.

## Bounty by bounty

### Main track: Onchain Finance & Trading

Requirement: "Fast settlement making new financial instruments and onchain markets practical."

| Criterion | How Hermes meets it | Where |
|---|---|---|
| Product quality and completeness | Full path from sign-in to report card: onboarding, live stream with lifecycle bars, strategies, limits, approvals, wallet page, report card, test-alert button. 440 tests. | [`apps/web/src/pages/`](../apps/web/src/pages/), [`apps/server/src/`](../apps/server/src/) |
| Technical excellence | Idempotent order state machine, protocol simulator with fault injection, pure risk engine, encrypted secrets, constant-time auth, SSE live updates. | [`packages/perpl/src/order-tracker.ts`](../packages/perpl/src/order-tracker.ts), [`packages/perpl/src/sim/server.ts`](../packages/perpl/src/sim/server.ts), [`apps/server/src/risk/evaluate.ts`](../apps/server/src/risk/evaluate.ts), [`apps/server/src/crypto.ts`](../apps/server/src/crypto.ts) |
| Monad integration | Orders fill on Perpl's on-chain exchange (Monad testnet, chain 10143). Fills are recorded with their transaction hash. Account setup transactions go through the user's Monad wallet. Head block and latency shown from the chain. | [`packages/perpl/src/chain.ts`](../packages/perpl/src/chain.ts), [`apps/server/src/privy/`](../apps/server/src/privy/), [`apps/web/src/lib/chain.ts`](../apps/web/src/lib/chain.ts) |
| Track fit | An on-chain perpetuals exchange made usable from TradingView alerts, with limits. | [README](../README.md#the-problem) |
| Innovation and impact | Alert execution for an exchange that has none, and a report card measuring the gap between chart and fill. PerplBot's roadmap lists TradingView compatibility as unchecked. | [`apps/server/src/reports/report-card.ts`](../apps/server/src/reports/report-card.ts) |

### Perpl: Best use of Perpl's API

Requirement: "Build a production-ready trading bot or automation system on Perpl."

| Requirement element | How Hermes meets it | Where |
|---|---|---|
| Trading bot or automation system | Webhook-driven execution: TradingView alert in, Perpl market order out, tracked to a terminal state. | [`apps/server/src/ingest/`](../apps/server/src/ingest/), [`apps/server/src/pipeline/pipeline.ts`](../apps/server/src/pipeline/pipeline.ts), [`apps/server/src/execution/perpl-executor.ts`](../apps/server/src/execution/perpl-executor.ts) |
| Authentication done properly | Ed25519 API keys, REST request signing (canonical string, nonce, body hash), WebSocket sign-in frame `mt 29`. Verified against third-party test vectors. Trade-only scope. | [`packages/perpl/src/signing.ts`](../packages/perpl/src/signing.ts), [`packages/perpl/test/signing.test.ts`](../packages/perpl/test/signing.test.ts) |
| Idempotent ordering (`rq`) | `rq` strictly increasing per account, seeded from `lfr`, persisted before send; same `rq` on retry before any status; new `rq` only after a failure or an expired window; statuses de-duplicated; ambiguous outcomes reconciled through REST, never blindly re-sent. | [`packages/perpl/src/order-tracker.ts`](../packages/perpl/src/order-tracker.ts), [`apps/server/src/perpl/registry.ts`](../apps/server/src/perpl/registry.ts) (`onRqAdvance` persists `last_rq`), [`packages/perpl/test/order-tracker.test.ts`](../packages/perpl/test/order-tracker.test.ts), [`packages/perpl/test/faults.test.ts`](../packages/perpl/test/faults.test.ts) |
| Reconnect and heartbeat rules | Heartbeat `sn` must rise by exactly 1, else reconnect. Documented back-off, `1001` immediate reconnect, `3401` re-sign, stale-heartbeat watchdog, order in flight at `1011` re-sent once with the same `rq`. | [`packages/perpl/src/trading-ws.ts`](../packages/perpl/src/trading-ws.ts) |
| Rate limits | Token bucket at 60 requests per minute on the trading socket; market data limited to its 10 requests per minute and 16 subscriptions; 429 and 503 handled in REST. | [`packages/perpl/src/trading-ws.ts`](../packages/perpl/src/trading-ws.ts), [`packages/perpl/src/market-data.ts`](../packages/perpl/src/market-data.ts), [`packages/perpl/src/rest.ts`](../packages/perpl/src/rest.ts) |
| Order lifecycle (`mt 3`, `mt 24`, `mt 25`) | `mt 3` treated as forwarding ack only; outcome from `mt 24`; fills and transaction hashes from `mt 25`; positions from `mt 26/27`. | [`packages/perpl/src/protocol.ts`](../packages/perpl/src/protocol.ts), [`packages/perpl/src/client.ts`](../packages/perpl/src/client.ts) |
| Account and chain setup | Context read at runtime (collateral token, minimums, markets, geo block), account selected by market instance id, calldata builders for `approve`, `createAccount`, `allowOrderForwarding`, deposits. | [`packages/perpl/src/chain.ts`](../packages/perpl/src/chain.ts), [`packages/perpl/src/rest.ts`](../packages/perpl/src/rest.ts) |
| Production concerns | Per-user client registry with back-off reconnects and health data, risk limits in front of every order, approval queue, encrypted secrets, 451 handling, startup config validation. | [`apps/server/src/perpl/registry.ts`](../apps/server/src/perpl/registry.ts), [`apps/server/src/config.ts`](../apps/server/src/config.ts), [`apps/server/src/risk/evaluate.ts`](../apps/server/src/risk/evaluate.ts) |
| Testable without network | Protocol simulator as a real WebSocket and HTTP server, with fault injection. | [`packages/perpl/src/sim/`](../packages/perpl/src/sim/), [`packages/perpl/README.md`](../packages/perpl/README.md) |

Open items for this bounty: a recorded live order and fill with a transaction hash, and confirmation of the Perpl behaviours listed as unverified in the README.

### Privy

Requirement: "Integrate Privy beyond authentication; login-only integrations will not qualify."

| Requirement element | How Hermes meets it | Where |
|---|---|---|
| Wallet created at sign-in | Email login with an embedded EVM wallet created on login, Monad testnet as the default chain. | [`apps/web/src/auth/privy-provider.tsx`](../apps/web/src/auth/privy-provider.tsx) |
| Server verifies the session | Access tokens verified with `@privy-io/node`. | [`apps/server/src/auth/privy.ts`](../apps/server/src/auth/privy.ts) |
| Hermes server as a restricted signer | The user adds the Hermes key quorum as a signer on their wallet with the Hermes policy attached (`useSigners().addSigners`). The server checks with Privy that the signer and policy are on the wallet before using it. | [`apps/web/src/pages/onboarding/StepWallet.tsx`](../apps/web/src/pages/onboarding/StepWallet.tsx), [`apps/server/src/privy/module.ts`](../apps/server/src/privy/module.ts), [`apps/server/src/privy/routes.ts`](../apps/server/src/privy/routes.ts) |
| Spending policy enforced by Privy | Chain `10143` only; native value 0; targets limited to the Perpl Exchange, the AUSD token (only `approve` to the Exchange, up to a cap) and the Agora faucet; valid until an expiry. Default-deny. Created by a bootstrap script, owned by the Hermes key quorum. | [`apps/server/src/privy/policy.ts`](../apps/server/src/privy/policy.ts), [`apps/server/src/privy/bootstrap.ts`](../apps/server/src/privy/bootstrap.ts) |
| Transactions signed under the policy | `approve`, `createAccount`, `allowOrderForwarding`, deposit and faucet requests sent by the server through `wallets().ethereum().sendTransaction` with an authorization context. Calldata built server-side, status tracked to a receipt, history kept. | [`apps/server/src/privy/privy-service.ts`](../apps/server/src/privy/privy-service.ts), [`apps/server/src/privy/module.ts`](../apps/server/src/privy/module.ts), [`apps/server/src/privy/abi.ts`](../apps/server/src/privy/abi.ts), [`apps/web/src/pages/onboarding/StepAccount.tsx`](../apps/web/src/pages/onboarding/StepAccount.tsx) |
| A demonstrated policy denial | `POST /api/wallet/policy-demo` sends a transaction the policy must refuse and skips Hermes's own pre-flight check, so the refusal comes from Privy. The attempt is stored as `denied_by_policy`. A button on the wallet page runs it. | [`apps/server/src/privy/module.ts`](../apps/server/src/privy/module.ts) (`policyDemo`), [`apps/web/src/pages/wallet/parts.tsx`](../apps/web/src/pages/wallet/parts.tsx) |
| Policy logic tested | A local mirror of the policy is tested for every rule (wrong chain, native value, unknown target, wrong spender, over-cap approve, expiry). | [`apps/server/test/privy-policy.test.ts`](../apps/server/test/privy-policy.test.ts), [`apps/server/test/wallet-api.test.ts`](../apps/server/test/wallet-api.test.ts) |
| Documentation | [docs/PRIVY.md](PRIVY.md) | |

Open items for this bounty: capture the real denial on a live run (Privy's error text and the transaction hashes of the allowed setup transactions), and confirm the policy field names for `approve.spender` and `approve.amount` against the live API.

### Perpl: Best Analytics / Risk Tool

Requirement: "Build a real-time analytics, risk-monitoring, or portfolio intelligence dashboard focused on Perpl."

| Requirement element | How Hermes meets it | Where |
|---|---|---|
| Real-time | One SSE stream feeds the dashboard: alert stages, positions, account, Perpl connection health, approvals. | [`apps/server/src/api/routes.ts`](../apps/server/src/api/routes.ts) (`/api/stream`), [`apps/web/src/lib/stream.ts`](../apps/web/src/lib/stream.ts), [`apps/web/src/pages/live/`](../apps/web/src/pages/live/) |
| Analytics focused on Perpl | Report card per strategy: alert price vs fill price (slippage bps and histogram), alert-to-fill latency (median, p95, over time), fill rate, realised PnL with slippage and fee cost, blocked and missed alerts grouped by reason, and a 0 to 100 grade with a published formula. | [`apps/server/src/reports/report-card.ts`](../apps/server/src/reports/report-card.ts), [`apps/server/test/report-card.test.ts`](../apps/server/test/report-card.test.ts), [`apps/web/src/pages/report/`](../apps/web/src/pages/report/) |
| Risk monitoring | Limits (markets, size, leverage, daily loss stop, approval threshold, alert age, order rate), pause switch, loss-stop meter in the top bar, approval queue, per-alert risk outcome. | [`apps/server/src/risk/evaluate.ts`](../apps/server/src/risk/evaluate.ts), [`apps/web/src/pages/limits/`](../apps/web/src/pages/limits/), [`apps/web/src/pages/approvals/`](../apps/web/src/pages/approvals/), [`apps/web/src/components/shell/TopBar.tsx`](../apps/web/src/components/shell/TopBar.tsx) |
| Portfolio view | Open positions, equity, margin, recent fills with transaction links. | [`apps/web/src/pages/live/Tables.tsx`](../apps/web/src/pages/live/Tables.tsx) |

Open items for this bounty: the report card should show real data from the live run in the video and screenshots, not seeded history. This bounty is a bonus on top of the core; its panels are about one strategy's alerts, not a whole-account portfolio tool.

## Risks still open (from details.md section 13)

| Risk | Status |
|---|---|
| Perpl testnet access from Nigeria (`geo_block`) | Unchecked live. Host the backend outside the US/GB; a 451 is reported as `perpl_geo_blocked`. |
| Collateral token and minimum deposit | Read at runtime; expected AUSD `0xa9012a055bd4e0edff8ce09f960291c09d5322dc`, 100 AUSD minimum. Confirm on the live run. |
| Perpl whitelisting our Origin for key enrolment | Not requested. Paste-in key is the supported path. |
| Privy policies on Monad testnet transactions | Untested live. The first live run settles it. |
| Perpl testnet instability near the deadline | Record a working run as soon as one exists. |
| Number of winners per bounty | Check the signed-in bounty pages. |
