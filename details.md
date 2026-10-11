# Hermes: project details

Working notes for the Monad Metropolis hackathon entry. Plain-English overview first, technical facts after. Every external fact below has a source at the bottom; anything not verified is marked **(unverified)**.

## 1. The one-liner

Hermes turns your TradingView alerts into Perpl orders within a second, inside limits you set, and shows whether your strategy performs live the way it looked on the chart.

## 2. The problem (plain English)

- Many traders build their strategies and alerts on TradingView.
- When an alert fires, they still have to open Perpl and place the trade by hand. If they are asleep, busy or offline, they miss it, or they enter late at a worse price.
- Tools that turn TradingView alerts into trades already exist for Hyperliquid and the big centralised exchanges. We found none for Perpl.
- Traders also never see whether the live result matched the chart: how much price they lost between the alert and the fill, how long it took, and which alerts never became trades.

## 3. Who it is for

A trader who already uses TradingView alerts and wants them executed on Perpl automatically, with hard safety limits, without writing a bot.

## 4. Why we believe Perpl wants this

- Perpl's co-founder maintains **PerplBot**, an open-source Perpl trading toolkit. Its README roadmap lists, unchecked, **"PineScript compatibility for TradingView strategies"** under *Automated Strategies*: https://github.com/0x70626a/PerplBot
- The official Metropolis prizes page lists **PBJ, Perpl Co-founder** as a **bounty judge**, linked to https://x.com/0x70626a, the same handle as the GitHub account above: https://hackathon.monad.xyz/prizes
- How to say it in the demo: *"This is on the Perpl co-founder's own roadmap."* Do **not** say he asked hackathon teams to build it.
- Honest scope note: his item says "PineScript compatibility". Hermes builds the practical form traders already use: alerts become orders. It does not run Pine Script code itself.

## 5. What Hermes does (plain English)

1. **Sign in** with email (Privy). A wallet is created for you.
2. **Connect Perpl**: open a Perpl testnet account and give Hermes a trade-only Perpl key. Perpl designed these keys so they can trade but can never withdraw money.
3. **Set your limits**: allowed markets, max position size, max leverage, daily loss stop, and a size above which Hermes waits for your approval.
4. **Copy your Hermes alert link** into a TradingView alert, with a secret.
5. **When the alert fires**, Hermes checks it is genuine and not a repeat, checks your limits, places the order on Perpl, and tracks it until it fills or fails.
6. **Report card**: per strategy, the alert price vs the fill price, the alert-to-fill time, blocked or missed alerts with the reason, and profit and loss.

## 6. Hackathon facts that bind us

### Dates
- Submission deadline: **13 Oct 2026, 11:59 PM ET** (about 4:59 AM, 14 Oct, Nigeria time). Late submissions are not accepted; the version at the deadline is judged.
- Judging 14 to 27 Oct; winners announced 3 Nov.

### Rules (official Rules v3.0, as quoted by builders who read the signed-in modal)
- One project per participant, entered in exactly one main track. Multiple submissions risk disqualification.
- Bounties stack on top of the main track: pick one track, then claim as many bounties as the project earns.
- Open source is **mandatory**: OSI-approved licence, public GitHub repo, during and after the hackathon.
- README must disclose AI coding tools used.
- Commit history must cover the build window; the substantial majority of the work must be new.
- Show Monad use with contract addresses or transaction hashes (testnet is fine) and explain why Monad matters.
- Demo video: **3 minutes or less**, public, showing the real product working with real Monad transactions.
- Team of 1 to 5. Review is non-confidential: no keys or secrets in the repo.

### Judging
- Main track, 20% each: Product Quality & Completeness, Technical Excellence, Monad Integration, Track Fit & Problem Relevance, Innovation & Impact.
- Sponsor bounties: 40% adherence to the bounty's published requirement, 30% technical implementation, 20% Monad integration, 10% innovation.

### Track and bounties we target
| Item | Prize | Exact requirement text | Track tag |
|---|---|---|---|
| Main track: Onchain Finance & Trading | $30,000 split as $10,000 to each of the top 3 | Fast settlement making new financial instruments and onchain markets practical | Track 1 |
| Perpl: Best use of Perpl's API | $5,000 | "Build a production-ready trading bot or automation system on Perpl." | All tracks |
| Privy | $5,000 | "Integrate Privy beyond authentication; login-only integrations will not qualify." | All tracks |
| Perpl: Best Analytics / Risk Tool (bonus, only if core is done) | $3,000 | "Build a real-time analytics, risk-monitoring, or portfolio intelligence dashboard focused on Perpl." | Track 1 |
| Grand Champion | $25,000 | Best project across all tracks | All |

Number of winners per sponsor bounty is not confirmed for Perpl and Privy (pages are login-gated). Check on the dashboard.

## 7. Competing Metropolis entries (checked 11 Oct)

None of these turn TradingView alerts into Perpl orders.

| Project | What it does | Overlap with Hermes |
|---|---|---|
| xorr | AI agent council trades for you; Perpl desk with standing exits; mobile app | Different: agent decides, not your strategy |
| Mirror | Copy the best Perpl traders, limits enforced by contract; live on testnet | Different signal source (other traders) |
| PerpGuard | Liquidation alerts, stress tests, kill switch | Risk tool, not execution |
| Monday | AI market maker on Perpl that steps aside on Nansen smart-money moves | Different strategy type |
| Metrix AI | Autonomous AI trading agent on Kuru and Perpl | Agent decides |
| Perpl Alpha Terminal | Funding arbitrage and risk analytics | Different strategy |
| MOTBOT | Chat-based trading assistant | Different input |
| Clearbook | Perpl account balance reconciliation | Analytics, different question |
| PerplBot (Perpl co-founder) | SDK, CLI, Telegram bot, grid and market-making strategies | TradingView support is an open roadmap item |

Also exists outside the hackathon: Tread.fi connects to Perpl for algorithmic order execution on mainnet.

## 8. Perpl technical facts (testnet)

| Item | Value |
|---|---|
| REST base | `https://testnet.perpl.xyz/api` |
| WebSocket base | `wss://testnet.perpl.xyz` (market data `/ws/v1/market-data`, trading `/ws/v1/trading`) |
| Chain ID | 10143 |
| RPC | `https://testnet-rpc.monad.xyz` |
| Exchange contract | `0x1964c32f0be608e7d29302aff5e61268e72080cc` |
| Collateral token | Read it from `GET /v1/pub/context`. The README lists `0xdf5b…c027`, but one builder reported that as outdated; PerplBot's testnet config and Mirror both use test AUSD `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC`. |
| Testnet market IDs | BTC 16, ETH 32, SOL 48, MON 64, ZEC 256 |

### Setup
- API key: Ed25519 key pair, created at `https://testnet.perpl.xyz/apikeys` with one wallet signature. Scopes: read, trade (trade implies read). **API keys can never withdraw or transfer out.** Optional expiry and IP allow-list.
- Programmatic key enrolment (`/v1/api-key/payload` + `/v1/api-key/enroll`) requires Perpl to **whitelist our Origin**. Ask in Perpl's Discord early; fallback is the user creating the key on Perpl's site and pasting it in.
- Exchange account is separate from the API key: call `createAccount(amount)` on the Exchange contract with an initial collateral deposit (minimum from `/v1/pub/context`). API auth alone cannot trade.

### Trading WebSocket rules
- First frame must be API-key sign-in (`mt: 29`) within the idle timeout (10 s on testnet).
- Orders: `mt: 22`. Types: 1 OpenLong, 2 OpenShort, 3 CloseLong, 4 CloseShort, 5 Cancel, 6 IncreasePositionCollateral, 7 Change. Flags: 0 GTC, 1 PostOnly, 2 FillOrKill, 4 ImmediateOrCancel. Leverage `lv` in hundredths. Max slippage `ms` in bps.
- `rq` is the idempotency key: strictly increasing per account, seed from the account's `lfr`, at-most-once execution.
- `mt: 3` = accepted for forwarding only. The real outcome comes on `mt: 24` (orders); fills on `mt: 25`; positions `mt: 26/27`; account `mt: 21`.
- Set a unique non-zero `sn` on every frame so acks can be matched (`cid` echoes `sn`).
- `lb` (last execution block): 0, or `head < lb <= head + order_ttl_blocks`; read `order_ttl_blocks` at runtime.
- Retry rules: same `rq` before any status and before `lb` expires; new `rq` after a failure status, or once head ≥ `lb` with no status and no reconnect since posting. Deduplicate status messages.
- Heartbeat `mt: 100`: sequence must go up by exactly 1; on a gap, force reconnect.
- Unknown market, foreign account or bad frame closes the socket with `1011` and no status.
- Limits (testnet): trading 60 requests/min, 4 connections per wallet; market data 10 requests/min, 16 subscriptions per connection.
- Native stop-loss and take-profit exist as trigger orders (`tp` + `tpc`, linked via `tr` / `lp`).

### Access
- `pub/context` carries a `geo_block` list. One builder read it on 13 Sep as BY, CU, GB, IR, KP, RU, SY, UA, US. Nigeria was not listed. **Check live before building.**

## 9. Test funds (zero spend)

- MON for gas: `https://faucet.monad.xyz` (rate-limited).
- Test AUSD: Agora testnet faucet `0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C`; one request per 60 s, shared by everyone.
- Rule for this project: **no real money spent on any protocol.**

## 10. TradingView facts

- Webhook alerts need a **paid** TradingView plan and two-factor authentication. The free plan cannot send webhooks. Paid plans offer a 30-day free trial.
- Webhooks are only sent to ports 80 and 443, so Hermes needs a public HTTPS URL (for example a free Cloudflare Tunnel).
- TradingView does not list Perpl. The alert runs on another exchange's chart for the same asset (for example Binance BTC) and Hermes executes on Perpl. Hyperliquid tools work the same way. Very short timeframes will see more price difference.
- Demo fallback: a "send test alert" button that posts the exact same message TradingView would send.

## 11. Privy facts

- Free Developer plan: up to 499 monthly active users, 50,000 signatures and $1M transaction volume per month.
- Monad testnet (`eip155:10143`) appears in Privy's supported-chain list. EVM is Privy's "send transactions" tier; transaction policies need Privy to decode the transaction, which it does for EVM.
- **Avoid:** gas sponsorship (runs on prepaid credits), Privy swaps on Monad testnet (route through Uniswap, which is not deployed on testnet), fiat and card features (real money).
- Webhooks appear under the Enterprise column on the pricing page **(unverified for free tier)**; plan to poll instead.
- What counts as "beyond login" for Hermes: wallet created at sign-in, the wallet signing the Perpl account setup and deposits, spending rules (only the Perpl exchange contract, value caps, time bounds), and human approval for large actions (intents).
- First check: one real server-side transaction on Monad testnet, and one transaction blocked by a policy.

## 12. Scope

### Must have (the core)
- Alert receiver: secret check, duplicate protection, message validation.
- Limits check: markets, size, leverage, daily loss stop, approval threshold.
- Perpl execution with the retry, reconnect and tracking rules in section 8.
- Log of every alert: received, blocked (with reason), sent, filled or failed, with timings and transaction hashes.
- Privy sign-in and wallet; deposit to Perpl through the Privy wallet under a spending rule.
- Simple web page: alerts, orders, fills, limits, a test-alert button.

### Bonus (only if the core works)
- Report card per strategy (the analytics bounty).
- Human approval flow for large orders.

### Out
- Mobile app, Kuru, other exchanges, running Pine Script itself, mainnet.

### Cut order if behind
Report card, then approval flow, then Privy extras. Never cut the alert-to-order core.

## 13. Open questions and risks

1. Perpl testnet access from Nigeria (check `geo_block` live).
2. Testnet collateral token and minimum deposit (read `pub/context`).
3. Whether Perpl will whitelist our Origin for key enrolment (ask in Discord; fallback is paste-in).
4. Whether Privy policies work on Monad testnet transactions (test once before relying on them).
5. Perpl testnet instability near the deadline: record a working run as soon as one exists.
6. Number of winners per bounty (check signed-in bounty pages).

## 14. Submission checklist

- [ ] Public GitHub repo with an OSI licence (MIT)
- [ ] README: setup steps, AI tool disclosure, why Monad, testnet transaction hashes
- [ ] Commits spread across the build window
- [ ] Demo video, 3 minutes or less, public, real Monad transactions
- [ ] Registered on hackathon.monad.xyz; one project; Track 1; bounties selected (Perpl API, Privy, and Perpl Analytics if built)
- [ ] No keys or secrets in the repo

## 15. Sources

- Metropolis official page: https://monad.xyz/developers/hackathons/metropolis
- Prizes and judges: https://hackathon.monad.xyz/prizes
- Bounty text (participant copy of the signed-in page): https://github.com/HackerFetch/Baret-Metropolis/blob/main/Bounties.txt
- Rules v3.0 as quoted by a participant: https://github.com/precious-akpan/monad-metropolis-merchant-rails
- PerplBot roadmap: https://github.com/0x70626a/PerplBot
- Perpl API docs: https://github.com/PerplFoundation/api-docs (README, websocket.md, integrations.md, rest-endpoints.md)
- Perpl geo-block reading (13 Sep): https://github.com/frankolien/desk/blob/main/docs/00-prd.md
- Testnet collateral note: https://github.com/altf4-games/Receipts
- Agora testnet faucet: https://github.com/YieldShield/yieldshield-monad/blob/main/docs/SPONSOR_STRATEGY.md
- Privy chain support: https://docs.privy.io/wallets/overview/chains.md
- Privy swap chains: https://docs.privy.io/wallets/actions/swap/overview
- Privy pricing: https://www.privy.io/pricing
- TradingView webhook plan requirement: https://crosstrade.io/blog/tradingview-plan-for-webhook-alerts
- TradingView alerts for exchanges it does not list: https://support.altrady.com/en/article/webhook-signals-trading-view-setup-1hmwo4c/
- TradingView to Hyperliquid example: https://github.com/davassi/hypertrade
- Competitors: https://github.com/nickthelegend/xorr-metropolis, https://github.com/Jagadeeshftw/mirror, https://github.com/0xMigzy/PerpGuard, https://github.com/moudybk1/monday, https://github.com/yigenfeng0707-netizen/metrix-ai, https://github.com/willmao66/perpl-alpha-terminal, https://github.com/mikecity11/motbot, https://github.com/osskinda/clearbook
- Tread.fi Perpl connection: https://docs.tread.fi/account-creation-and-api-key-connection/connecting-to-exchanges/perpl.md
