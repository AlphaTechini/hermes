# @hermes/perpl

Everything Hermes needs to talk to the Perpl exchange (Monad testnet, chain id 10143): Ed25519 API-key signing, REST,
the trading and market-data WebSockets, the rq / retry order state machine, viem calldata builders for account setup,
and a **protocol simulator** that is a real WebSocket + HTTP server.

Source of truth for the protocol is `docs/research/perpl.md` (it corrects `details.md`), which cites
`PerplFoundation/api-docs`. Where the docs and a working third-party integration (Desk) disagree, this package follows
perpl.md. The build sandbox could not reach `testnet.perpl.xyz` or the Monad RPC, so the live code is written from the
spec and unit-tested against the spec'd frames and the Desk signing vectors, and the whole stack is exercised against the
simulator.

```
src/protocol.ts       frame types + zod parsers, enums (order types 1..7, flags, st, sr 0..69, fr), readable reasons
src/signing.ts        Ed25519 signing (node:crypto), canonical strings, key parsing (hex/base64/base64url/PEM)
src/scaling.ts        bigint-safe price/size/leverage/AUSD conversions, tick/lot rounding, fees
src/rest.ts           PerplRest: pub/context, signed state + history endpoints, POST orders, 451/429/503 handling
src/trading-ws.ts     PerplTradingSocket: sign-in, heartbeat gap detection, reconnect/backoff, token bucket
src/order-tracker.ts  OrderTracker: rq allocation + retry rules (perpl.md 5.9), lifecycle callbacks
src/market-data.ts    PerplMarketData: market-state/heartbeat streams, mark price cache, REST fallback
src/chain.ts          viem: Monad testnet chain, calldata builders, on-chain reads (no private keys)
src/client.ts         PerplClient: the high-level class for one user account
src/server-adapter.ts toServerClient(client): satisfies apps/server/src/perpl/types.ts `PerplClient`
src/sim/              startPerplSimulator() + CLI
```

## Quick start

```ts
import { PerplClient } from "@hermes/perpl";

const client = new PerplClient({
  restUrl: "https://testnet.perpl.xyz/api", // default
  wsUrl: "wss://testnet.perpl.xyz",         // default
  apiKey: "<X-API-Key token>",
  apiSecret: "<hex / base64 / base64url / PEM Ed25519 private key>",
  lastRq: storedLastRq,                      // persisted high-water mark (optional)
  onRqAdvance: (rq, accountId) => saveRq(accountId, rq), // called BEFORE the frame is sent
});
await client.connect();

const out = await client.placeMarketOrder({ market: "BTC", side: "long", kind: "open", sizeUsd: 500, leverage: 3, maxSlippageBps: 50 });
// out.status: "filled" | "partially_filled" | "failed" | "timeout"; out.fills[].txHash / block / price / fee
await client.placeMarketOrder({ market: "BTC", side: "long", kind: "close", closeAll: true }); // out.realizedPnlUsd
```

Business failures never throw: inspect `outcome.status` and `outcome.failure` (`code`: `sr:34`, `forwarding_disabled`,
`size_too_small`, `socket_closed_1011`, ...; `message` is human readable). `timeout` with `ambiguous: true` means the
order may have executed and must be reconciled (REST orders / order-history by rq); the tracker never blindly re-sends it
under a new rq.

### Wiring into apps/server

`apps/server/src/perpl/types.ts` already declares the server's `PerplClient` interface. This package provides it through
an adapter (structural copy in `server-adapter.ts`, verified to type-check against the server file):

```ts
import { PerplClient, toServerClient } from "@hermes/perpl";

const perpl = new PerplClient({ restUrl, wsUrl, apiKey: creds.apiKeyPublic, apiSecret: creds.apiKeyPrivate, lastRq: creds.lastRq,
  onRqAdvance: (rq) => persistLastRq(userId, rq) }); // persistLastRq: your storage
const serverClient = toServerClient(perpl);   // PerplClient from apps/server/src/perpl/types.ts
await serverClient.connect();
serverClient.onStatus((e) => { /* kind: connection | order | fill | positions | account */ });
await serverClient.placeOrder({ marketId: 16, type: 1, size: 0.002, leverage: 3, maxSlippageBps: 50 });
```

Notes for the executor:

* The **tracker owns rq management and retries** (same-rq retry, new rq after failure). The executor should not
  implement its own. `placeOrder` resolves when the first frame was handed to the socket (`{sn, rq, lb}`); the rest is
  pushed as `PerplEvent`s carrying `sn` and `rq` (`accepted` fires twice: after mt:3, then again with the exchange
  `orderId` from mt:24).
* A failure **before** anything was sent (validation, no account, forwarding off, not connected) rejects `placeOrder`
  with `PerplOrderRejectedError` (`.code`) and also emits an `order` event with status `rejected`.
* To see realised PnL for a close, use `PerplClient.placeMarketOrder` (`outcome.realizedPnlUsd`) or the client `realized`
  event; the server-shaped `fill` event leaves `realizedPnl` unset.
* Persist the `onRqAdvance` values (`lastRq`). After a restart the tracker seeds from `max(lastRq, account.lfr)`.

## Public API (PerplClient)

```ts
class PerplClient extends TypedEmitter<PerplClientEvents> {
  constructor(opts: PerplClientOptions);
  connect(): Promise<void>;                       // context -> sign-in -> snapshots -> market data
  close(): Promise<void>;
  isConnected(): boolean;
  headBlock(): Promise<number>;                   // heartbeat -> market-data heartbeat -> REST ticker `sn`
  getAccount(): Promise<PerplAccountSnapshot>;
  getPositions(): Promise<PerplPosition[]>;
  getMarkPrice(market: number | string): Promise<number>;
  placeMarketOrder(p: PlaceMarketOrderParams): Promise<PerplOrderResult>;
  cancel(p: { market: string | number; orderId: number; handlers?: OrderLifecycleHandlers; tag?: string }): Promise<OrderOutcome>;
  getOpenOrders(): Promise<Order[]>;
  refreshAccounts(): Promise<Account[]>;          // REST wallet re-read (after allowOrderForwarding / deposit)
  getRealizedPnlForRq(rq: number): number | undefined;
  readonly context: PerplContext;                 // collateral token, min deposits, markets, geo_block
  readonly rest: PerplRest;
  readonly orderTracker: OrderTracker;
  readonly tradingSocket: PerplTradingSocket;
}
```

Events: `connected`, `disconnected`, `account` (mt:21), `order` (mt:23/24), `fill` (mt:25, every fill), `positions`,
`realized`, `status` (mt:3, de-duplicated), `heartbeat`, `warning` (`forwarding_disabled`, `no_exchange_account`,
`retired_rq_became_active`, ...), `error`.

Lifecycle callbacks per order (`handlers`): `sent`, `accepted`, `partially_filled`, `filled`, `failed`, `timeout`,
`retry`, `order` (raw mt:24 messages).

### Account selection and order forwarding

The account is the one whose `in` equals the market's `instance_id` (not `as[0]`). While `fw === false` (re-read on every
mt:21) orders fail locally with `forwarding_disabled` without touching the wire. The setup transactions are in
`chain.ts`: `buildApproveTx`, `buildCreateAccountTx`, `buildAllowOrderForwardingTx`, `buildDepositTx`,
`buildFaucetRequestTx`, `buildSetupPlan`, and `PerplChain` for reads (account by address, AUSD balance/allowance). They
return `{to, data, value}`; the web app signs them with the Privy wallet. No private key is handled here.

## The rq / retry rules (order-tracker.ts, perpl.md 5.9)

| Situation | Action |
|---|---|
| any new order | `rq = max(counter, lfr) + 1`, `onRqAdvance(rq)` awaited **before** send, sends serialised in rq order |
| every frame | unique non-zero `sn` (echoed as `cid` on mt:3) |
| no mt:3 within `ackTimeoutMs` (2.5 s), or socket reconnected, before `lb` expiry | re-send the **same** rq (at-most-once) |
| mt:3 `code != 0` | terminal failure (400/403), except 429/503 which get a new rq |
| mt:24 `st 7` | first failure wins; `sr 32` (DescIdTooLow) retried **once** with a new rq after re-reading `lfr` |
| `head >= lb` (`lb: 0` => `sentHead + order_ttl_blocks + 5`), no status, **no reconnect** | new rq |
| the same, but a reconnect happened | ambiguous: `reconcile(rq)` through REST; new rq only if Perpl has no record, else `timeout` (ambiguous) |
| first non-failure mt:24 per rq | definitive; later failures ignored; late failures of a retired rq ignored; a late non-failure of a retired rq raises the `retired_rq_became_active` warning |
| socket closed 1011 with an order in flight | one same-rq re-send, a second 1011 fails it `socket_closed_1011` |

`lb: 0` is always sent (perpl.md 0.5). `ms` defaults to 50 bps and is clamped to the market maximum.

## Simulator

```bash
pnpm --filter @hermes/perpl sim -- --port 8787 [--seed 1] [--vol 1] [--balance 10000] [--keys 1]
```

prints `REST` (`http://127.0.0.1:8787/api`), `WS` (`ws://127.0.0.1:8787`) and freshly enrolled demo keys
(`PERPL_API_KEY` / `PERPL_API_KEY_SECRET`). In code:

```ts
import { startPerplSimulator } from "@hermes/perpl"; // or "@hermes/perpl/sim"
const sim = await startPerplSimulator({ port: 0 });    // { url, wsUrl, stop(), enrollKey(pub, accountId), enrollNewKey(), inject(), ... }
const key = sim.enrollNewKey({ balanceAusd: 10_000 }); // { apiKey, apiSecret, accountId, signer }
const client = new PerplClient({ restUrl: sim.url, wsUrl: sim.wsUrl, apiKey: key.apiKey, apiSecret: key.apiSecret });
```

What it does: verifies mt:29 signatures against enrolled public keys (3401 on failure, 1008 `idle timeout` without a
sign-in), verifies REST signatures (30 s window, single-use nonces), snapshots 19/23/26, heartbeats every 1 s with
`sn + 1`, GBM prices (BTC 112000, ETH 4100, SOL 210, MON 0.04, ZEC 60), market-data stream, mt:3 then after 150-600 ms
mt:24 + mt:25 + mt:27 + mt:21 at mark +/- 0-8 bps (skewed small) with fees (345 micros taker), `0x` + 64 hex tx hashes and
a block number advancing every 400 ms. Strictly increasing rq (`rq <= lfr` => `sr 32`), a repeated rq never executes
twice, unknown market / foreign account / unparseable frame => close 1011 with no status, 60 requests/min and 4
connections per wallet (1008), resting limit orders, cancels, 10 requests/min and 16 subscriptions on market data.

Fault injection (`sim.inject(fault)`, consumed by the next order / heartbeat; `count` repeats):

| fault | effect |
|---|---|
| `{kind:"drop_status", which?:"mt3"\|"mt24"\|"all", execute?}` | swallow the ack and/or the mt:24+mt:25 of the next order (still executed by default) |
| `{kind:"disconnect_before_status", execute?}` | terminate the socket before any status; `execute:false` = the frame never arrived |
| `{kind:"reject", sr?, fr?, via?:"order"\|"status", httpCode?, error?}` | mt:24 `st 7` with that reason code, or an mt:3 non-zero status |
| `{kind:"heartbeat_gap"}` | skip a heartbeat sequence number (forces the client to reconnect) |
| `{kind:"delay", ms}` | extra execution latency |
| `{kind:"fill_before_order"}` | mt:25 arrives before mt:24 |
| `{kind:"partial_fill", fraction}` / `{kind:"no_liquidity"}` | IOC partial fill + cancel / IOC cancelled with zero fill |
| `{kind:"close_socket", code}` | close the socket with that code on the next order (for example 1011) |

Other helpers: `setPrice`, `setForwarding`, `deposit`, `dropConnections(code)`, `executedOrders()` (assert "no double
fill"), `account(id)`, `blockNumber()`, options `geoBlocked` (451), `idleTimeoutMs`, `latencyMs`, `seed`, `volMultiplier`.

### Live vs simulator

| | live Perpl | simulator |
|---|---|---|
| data | real order book, funding, liquidations | synthetic GBM mark; infinite liquidity at mark +/- <= 8 bps |
| fills | Monad blocks, real tx hashes | fake tx hashes, block counter, 150-600 ms latency |
| heartbeat | assumed every block on the trading socket | every `heartbeatIntervalMs` (1 s) |
| duplicate rq | at-most-once; what is re-emitted is unspecified | records and **replays** the mt:24/25 to the re-sender |
| idle timeout | 10 s (sign-in), ping/pong afterwards | 10 s before sign-in, protocol ping/pong afterwards |
| funding, liquidation, ADL, trigger orders, builder fees | yes | not modelled |
| geo / Origin rules | 451 from US datacenters, browser Origins refused | only if `geoBlocked: true` |

## Known uncertainties (from perpl.md, plus ours)

1. `lb = head + ttl` was rejected by testnet v235 for Desk; we send `lb: 0` and estimate the window as `sentHead + ttl + 5`.
2. Server-side `/v1/api-key/*` enrolment without an `Origin` header is unverified on testnet. Paste-in of the key made on
   `testnet.perpl.xyz/apikeys` is the fallback; the exact format that page displays is undocumented, so `parseEd25519Seed`
   accepts hex (0x optional, 32 or 64 bytes), base64, base64url and PEM, and `parseApiCredentials` accepts JSON/env text.
3. Whether testnet trading endpoints answer **451** to US IPs like mainnet. Run the backend in an EU region; 451 surfaces as
   `PerplGeoBlockedError`. The browser must never call Perpl directly (Origin refusal).
4. The live `pub/context` may differ from the captured 13 Sep snapshot (collateral, `min_account_open_amount` 100 AUSD,
   markets, `geo_block`): everything is read at runtime and logged on `connect()`.
5. Agora faucet: AUSD per `requestFunds` and whether it is still funded are unknown.
6. `depositCollateral` minimum (10 AUSD) may only be enforced in the UI.
7. Exact meaning of `ms` with `p: 0` (bps vs mark or vs best price).
8. Whether `lp` is required on Close orders (we omit it, as Desk does).
9. `lfr` and amounts may arrive as numbers or strings; parsers accept both.
10. Whether mt:100 heartbeats are sent on the trading socket at every block. If they are not, `head` is unknown: the tracker
    falls back to wall-clock expiry and `headBlock()` falls back to the market-data heartbeat / REST ticker.
11. Balance semantics (ours): we assume position collateral is held outside the free balance `b`
    (equity = b + position collateral + upnl). `getAccount()` documents this; verify against a live account.
12. What Perpl re-emits when an already executed rq is re-sent (replay of mt:24/25, nothing, or only mt:3) is unspecified.
    The tracker therefore also reconciles through REST order-history by rq whenever the outcome is ambiguous.
13. Cancel responses: whether the cancel's mt:24 carries the cancel's rq or the cancelled order's rq. The tracker accepts
    both (matches by `oid`).
14. IOC orders that fill partly: whether Perpl sends `st 3` then `st 5`, or only one; a lone `st 3` is settled after
    `iocSettleMs` (3 s).

## Tests

```bash
pnpm --filter @hermes/perpl typecheck
pnpm --filter @hermes/perpl test
```

`test/signing.test.ts` runs the Desk vectors (`test/fixtures/desk-canonical-vectors.json`, from
`frankolien/desk` `CanonicalVectors.json`): WS sign-in and three REST requests must reproduce the signatures byte for
byte. `test/order-tracker.test.ts` covers every retry branch with fake timers and a fake socket. `test/integration.test.ts`
and `test/faults.test.ts` run the real `PerplClient` against the simulator (long BTC, fill, position, close, realised PnL;
disconnect before status => same rq, no double fill; failure status => new rq).
