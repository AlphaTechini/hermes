# Perpl integration research (testnet)

Researched 11 Oct 2026. Primary source: PerplFoundation/api-docs @ `25ab6e2` (25 Sep 2026). Cross-checked against
working competitor code: frankolien/desk (Swift + JS, live API-key trading on Perpl, captured testnet `pub/context`),
Jagadeeshftw/mirror (on-chain Exchange integration on testnet, 8-9 Oct 2026) and PerplFoundation/dex-sdk (canonical ABI).
`testnet.perpl.xyz` and the Monad RPC were unreachable from the research sandbox, so nothing below was called live by us.

Legend: **[doc]** official api-docs, **[desk]** / **[mirror]** observed in a working third-party integration,
**[ours]** our inference, **[?]** unverified.

## 0. Corrections to details.md (read first)

1. **Order forwarding must be enabled on-chain** before any API order works: call `allowOrderForwarding(true)` on the
   Exchange from the account's wallet after `createAccount`. Without it every `mt:22` gets `mt:3 code:0` and then
   `mt:24 st:7 sr:34` (OrderForwardingNotAllowed). **[doc]** README.md "Enabling Order Forwarding". details.md omits this.
2. **PerplBot is outdated for auth.** It uses the removed SIWE flow (`/v1/auth/payload`, `/v1/auth/connect`, cookie +
   `X-Auth-Nonce`, WS `mt:4`) and the old testnet exchange `0x9C216D1A…6ab7`. API-key auth (`mt:29`, `X-API-*`
   headers) replaced it on 3 Jul 2026 (api-docs commit `7a39768`). Use the api-docs, not PerplBot, for auth.
   PerplBot is still useful for the Exchange ABI shapes and deposit flow.
3. **Testnet collateral is AUSD `0xa9012a055bd4e0edff8ce09f960291c09d5322dc`, 6 decimals**, not the README's
   `0xdf5b…c027`. Confirmed by a captured testnet `pub/context` (protocol ver 235, ~13 Sep 2026) **[desk]**
   `DeskKit/Tests/DeskPerplTests/Context-testnet.json` and by Mirror's testnet config **[mirror]** `shared/config.json`.
4. **Testnet minimum to open an account is 100 AUSD** (`min_account_open_amount: "100000000"`, 6 dp). Top-ups min
   10 AUSD (`min_deposit_amount: "10000000"`). Mainnet minimum is 10 AUSD. **[desk]** captured context, **[mirror]**.
5. **Use `lb: 0` on every order.** The docs allow `head < lb <= head+ttl`, but Desk got `code 400` sending
   `head + order_ttl_blocks` against protocol v235 and fixed it with `lb: 0` (the server then substitutes the market's
   max window, which the docs also allow). **[desk]** `docs/perpl-order-400-audit-2026-09-15.md`, **[doc]** "lb: 0 is legal on any order type".
6. **Pick the account whose `in` equals the market's `instance_id`**, not blindly `as[0]`. **[desk]** same audit.
   (Testnet has one instance, id 12, so `as[0]` works today, but code it properly.)
7. **Geo / IP:** Perpl answers trading endpoints with **HTTP 451 from US datacenter IPs** (seen on mainnet by Desk,
   which pins its relay to Frankfurt) **[desk]** `docs/web-app.md`. Perpl also refuses browser `Origin`s other than its
   own on REST/market-data WS **[desk]**. => The Hermes backend must run outside US/GB (e.g. EU region) and the
   browser must never call Perpl directly; proxy through our backend. `geo_block` on testnet (13 Sep):
   `["BY","CU","GB","IR","KP","RU","SY","UA","US"]` (NG not listed). **[?]** whether testnet also 451s US IPs.
8. **Perpl will not enroll an API key for a wallet that has no exchange account.** **[desk]** `docs/web-app.md`
   ("Without one Perpl will not enrol a key"). Order of setup is therefore: approve → createAccount → allowOrderForwarding → enroll key.

## 1. Endpoints and constants (testnet)

| Item | Value | Source |
|---|---|---|
| REST base | `https://testnet.perpl.xyz/api` (paths below start `/v1/...`) | [doc] README |
| WS base | `wss://testnet.perpl.xyz` + `/ws/v1/trading` or `/ws/v1/market-data` | [doc] |
| chain_id | `10143` (string `"10143"` in canonical strings) | [doc] |
| Exchange | `0x1964c32f0be608e7d29302aff5e61268e72080cc` (instance id 12, deployed block 54964161) | [doc], [desk], [mirror] |
| Collateral | AUSD `0xa9012a055bd4e0edff8ce09f960291c09d5322dc`, decimals 6, token id 1 | [desk], [mirror] |
| Agora AUSD faucet | `0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C`, `requestFunds(address to)`, 1 call / 60 s global | [desk] `web/api/faucet.mjs`, altf4-games/Receipts `bots/src/tick.ts` |
| Faucet amount per call | unknown [?] (Desk falls back to sending 1000 AUSD itself) | |
| Testnet base fee | `gas.base = "100000000000"` (100 gwei) in captured context | [desk] |

Testnet markets from the captured context (`id`, `symbol`, `price_decimals`, `size_decimals`, `initial_margin`,
`order_ttl_blocks`, `order_max_market_slippage_bps`). Always re-read at runtime.

| id | sym | pdec | sdec | initial_margin (=max lev x100) | ttl | max slip bps | taker fee micros (base) |
|---|---|---|---|---|---|---|---|
| 16 | BTC | 1 | 5 | 1500 (15x) | 20 | 1000 | 345 |
| 32 | ETH | 2 | 3 | 1200 (12x) | 20 | 1000 | ? |
| 48 | SOL | 2 | 3 | 1000 (10x) | 20 | 1000 | ? |
| 64 | MON | 5 | 0 | 300 (3x) | 20 | 100 | ? |
| 256 | ZEC | 3 | 3 | 300 (3x) | 20 | 100 | ? |
| 272 | LIT | 5 | 1 | 300 | 20 | 100 | ? |
| 320 | PUMP | 6 | 0 | 500 | 20 | 100 | ? |

`initial_margin` semantics: docs say "1000 = 10% (10x max)" and "maintenance 2000 = 5%", i.e. value = max leverage in
hundredths. Desk validates `100 <= lv <= config.initial_margin`. **[doc]** types.md MarketConfig, **[desk]** `OrderRequest.swift`.
All BTC market `min_posting_amount`/`min_settle_amount` were `"0"`; `recycle_fee: "100000"` (0.1 AUSD) charged when a resting order is posted [?exact semantics].

## 2. `GET /v1/pub/context` (public, no auth)

Shape (types.md `Context` + extra keys seen live):

```ts
interface Context {
  chain: { ver: number; chain_id: number; name?: string; block_explorer_urls?: string[];
           gas: { at: {b:number;t:number}; h: number; max: string; p95: string; p50: string; min: string; base: string } };
  instances: Array<{ ver: number; id: number; address: string; collateral_token_id: number;
    min_account_open_amount: string; min_deposit_amount: string; min_withdraw_amount: string;
    max_account_equity?: string; max_account_trigger_orders: number }>;
  tokens: Array<{ ver: number; id: number; address: string; symbol: string; name: string; decimals: number;
    display_precision: number; usd_index?: string }>;
  markets: Array<{
    ver: number; id: number; instance_id: number; perpetual_id: number; symbol: string; name: string;
    size_units: string; icon: string; funding_interval_sec: number; funding_interval_blocks: number;
    order_ttl_blocks: number; order_retry_blocks: number;
    order_max_market_slippage_bps: number; order_max_neg_pnl_collat_bps: number; points_boost_bps?: number;
    config: { at: {b:number;t:number}; is_open: boolean; price_decimals: number; size_decimals: number;
      min_posting_amount: string; min_settle_amount: string; initial_margin: number; maintenance_margin: number;
      maker_fee: number; taker_fee: number; maker_fees?: number[]; taker_fees?: number[];   // micros, index = Account.ft
      recycle_fee: string; funding_sum_scaling_exp: number; contract_version?: number[] };
    state: MarketState;   // see §6
    funding: { at: {b:number;t:number}; feb: number; rate: number; idx: number; ppl: number; sum: number; div: number };
  }>;
  // seen live, not in types.md:
  features?: Record<string, string>;      // e.g. apiKeysEnabled: "on", tpSlOrdersUseIoc: "on"
  geo_block?: string[];                   // ISO-3166 alpha-2
  rewards?: unknown; competitions?: unknown[]; incentive_tokens?: unknown[];
}
```

Collateral lookup **[doc]** examples/typescript/fetch_smart_contract_info.ts:
`inst = ctx.instances[0]; token = ctx.tokens.find(t => t.id === inst.collateral_token_id)`.

## 3. Account setup on-chain (wallet transactions)

Minimal ABIs saved: `docs/research/abi/PerplExchange.min.json` (extracted from PerplFoundation/dex-sdk
`crates/sdk/abi/dex/Exchange.json`, REVISION `rc_v1.1.7-203-g0e5902dd`, plus errors from `Errors.abi.json`),
`docs/research/abi/ERC20.min.json`, `docs/research/abi/AgoraFaucet.min.json`.

| Function | Selector | Notes |
|---|---|---|
| `AUSD.approve(address spender,uint256 amount)` | `0x095ea7b3` | spender = Exchange |
| `createAccount(uint256 amountCNS) returns (uint256 accountId)` | `0xcab13915` | amount >= `min_account_open_amount`; pulls AUSD via transferFrom; reverts `AccountExists` if already created, `InsufficentAmountToOpenAccount` if too small |
| `allowOrderForwarding(bool allow)` | `0x7962f910` | required for API trading; emits `OrderForwardingUpdated(accountId, allowed)`; no getter, read `fw` from WS/REST |
| `depositCollateral(uint256 amountCNS)` | `0xbad4a01f` | top-up, needs prior approve; >= `min_deposit_amount` [?enforced on-chain]; emits `CollateralDeposit(accountId, amountCNS, balanceCNS)` |
| `withdrawCollateral(uint256 amountCNS)` | `0x6112fe2e` | wallet only, never via API key |
| `increasePositionCollateral(uint256 perpId,uint256 amountCNS)` | `0xf769f0d3` | or API order type 6 |
| `getAccountByAddr(address) view returns (AccountInfo)` | | **reverts** (`AccountDoesNotExist`) if none [doc]; tuple `{accountId, balanceCNS, lockedBalanceCNS, frozen(uint8), accountAddr, positions{bank1..4}}` |
| `getMinAccountOpenCNS() view` | | on-chain cross-check of the minimum |

Units: `*CNS` = collateral native scale (AUSD 6 dp), `*PNS` = price in market price decimals, `*LNS` = lots in size
decimals, `*Hdths` = hundredths. **[mirror]** `web/content/docs/indexer.md`.

Monad gas: Monad charges `gas_limit * price`, not gas used, so do not pad gas estimates heavily (Desk pads 7.5%). **[desk]** `web-app.md`; Monad fee model [ours, well known].

```ts
// viem 2.x; ABIs from docs/research/abi
import { createPublicClient, http, encodeFunctionData, type Address } from 'viem';
import { monadTestnet } from 'viem/chains';                 // id 10143, rpc https://testnet-rpc.monad.xyz
import exchangeAbi from './abi/PerplExchange.min.json';
import erc20Abi from './abi/ERC20.min.json';

const EXCHANGE = '0x1964c32f0be608e7d29302aff5e61268e72080cc' as Address;
const AUSD     = '0xa9012a055bd4e0edff8ce09f960291c09d5322dc' as Address;
const pub = createPublicClient({ chain: monadTestnet, transport: http() });

export async function getAccountId(owner: Address): Promise<bigint | null> {
  try {
    const info = await pub.readContract({ address: EXCHANGE, abi: exchangeAbi, functionName: 'getAccountByAddr', args: [owner] }) as { accountId: bigint };
    return info.accountId > 0n ? info.accountId : null;
  } catch { return null; }               // reverts AccountDoesNotExist when no account
}

// Calldata for the embedded wallet (Privy useSendTransaction or server sendTransaction), in order:
export const txApprove  = (amountCNS: bigint) => ({ to: AUSD,     data: encodeFunctionData({ abi: erc20Abi,    functionName: 'approve',              args: [EXCHANGE, amountCNS] }) });
export const txCreate   = (amountCNS: bigint) => ({ to: EXCHANGE, data: encodeFunctionData({ abi: exchangeAbi, functionName: 'createAccount',        args: [amountCNS] }) });
export const txForward  = ()                  => ({ to: EXCHANGE, data: encodeFunctionData({ abi: exchangeAbi, functionName: 'allowOrderForwarding', args: [true] }) });
export const txDeposit  = (amountCNS: bigint) => ({ to: EXCHANGE, data: encodeFunctionData({ abi: exchangeAbi, functionName: 'depositCollateral',    args: [amountCNS] }) });
// Wait for each receipt before the next (approve must be mined before createAccount).
```

Setup sequence **[doc]+[desk]**: (1) fund wallet with MON (gas) and >= 100 AUSD; (2) `approve(Exchange, amt)`;
(3) `createAccount(amt)`; (4) `allowOrderForwarding(true)`; (5) enroll / paste API key (§4); (6) open trading WS,
check `fw === true` on the account.

## 4. API keys (Ed25519) and request signing

Key material: Ed25519 32-byte private key (`PERPL_API_KEY_SECRET`, hex), opaque token `api_key` (`X-API-Key`).
Scopes: `scope_mask` 1 = read, 2 = trade (implies read), 3 = both. API keys can never withdraw/transfer out.
Max 16 active keys per profile. Optional `expires_at` (ms), `ip_cidrs` (max 4). **[doc]** integrations.md, authentication.md.

### 4.1 REST signing [doc] authentication.md
Canonical string = 6 lines joined by `\n`: `chain_id`, `METHOD`, `request-target` (path + query exactly as sent,
starting `/v1/...`, **without** the `/api` prefix), `timestamp_ms`, `nonce` (random 16 bytes, base64url no padding),
`hex(sha256(body))` (sha256 of `""` for empty body). Signature = `base64url(ed25519(canonical))`, no padding.
Headers: `X-API-Key`, `X-API-Timestamp`, `X-API-Nonce`, `X-API-Signature`. Timestamp window ±30 s; nonce single-use.

### 4.2 Trading WS sign-in frame `mt: 29` [doc]
Canonical = 4 lines: `chain_id`, literal `trading-ws-signin`, `timestamp_ms`, `nonce`. Must be the first frame, within
10 s of open on testnet (5 s mainnet), else close `1008 idle timeout`. Auth failure closes `3401`.

```json
{"mt":29,"chain_id":10143,"api_key":"<token>","timestamp":"1789000000000","nonce":"AQIDBAUGBwgJCgsMDQ4PEA","signature":"<base64url sig>"}
```

Dependency-free Node implementation (node:crypto). Verified by us against Desk's test vectors
(`DeskKit/Tests/DeskPerplTests/CanonicalVectors.json`): seed `e6ab0994…0f79`, ts `1789000000000`, nonce
`AQIDBAUGBwgJCgsMDQ4PEA` → sign-in signature `q9ciQP8zxUUJ17a1SW24jOFrLIAanp0rky-cpmYRygB5Bo0-upNR2Oj_IjXehgBcWeQ7bOQUuPSq7qCawIOOCg`;
GET `/v1/trading/account-history` → `NJ1bDXm2bouoHttoLS6jgvdgFXE28xy8QAAJKVW6YLIn-LQrd5OggW4pI28W1vmJ_K-YraqX3zHHUjWdCQaHCg`. Use these as unit tests.

```ts
import { createPrivateKey, createPublicKey, sign, createHash, randomBytes, type KeyObject } from 'node:crypto';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
export function ed25519FromHex(secretHex: string): KeyObject {
  const seed = Buffer.from(secretHex.replace(/^0x/, ''), 'hex');         // 32 bytes
  if (seed.length !== 32) throw new Error('Perpl API secret must be 32 bytes hex');
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}
export const publicKeyHex = (k: KeyObject) =>
  '0x' + createPublicKey(k).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const b64url = (b: Buffer) => b.toString('base64url');                  // Node emits no padding
const edSign = (k: KeyObject, text: string) => b64url(sign(null, Buffer.from(text, 'utf8'), k));

export function signInFrame(chainId: number, apiKey: string, k: KeyObject) {
  const timestamp = Date.now().toString();
  const nonce = b64url(randomBytes(16));
  const signature = edSign(k, [chainId, 'trading-ws-signin', timestamp, nonce].join('\n'));
  return { mt: 29, chain_id: chainId, api_key: apiKey, timestamp, nonce, signature };
}

export async function perplFetch(base: string, chainId: number, apiKey: string, k: KeyObject,
                                 method: 'GET' | 'POST', target: string, body = '') {
  const timestamp = Date.now().toString();
  const nonce = b64url(randomBytes(16));
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const sig = edSign(k, [chainId, method, target, timestamp, nonce, bodyHash].join('\n'));
  return fetch(base + target, {                                        // base = https://testnet.perpl.xyz/api
    method,
    headers: { 'X-API-Key': apiKey, 'X-API-Timestamp': timestamp, 'X-API-Nonce': nonce, 'X-API-Signature': sig,
               ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body } : {}),                                         // send the exact string you hashed
  });
}
```

### 4.3 Programmatic enrollment [doc] integrations.md
1. `POST /v1/api-key/payload` body `{chain_id, address, public_key: "0x"+hex32, scope_mask: 3, label, expires_at?, ip_cidrs?}`
   → `{typed_data, mac}`.
2. Wallet signs `typed_data` (EIP-712, sign exactly as returned; drop `EIP712Domain` from `types`; domain `chainId`
   arrives as a **hex string**, convert with `Number()` for viem **[desk]** `reference/perpl/spike.mjs`).
3. PoP: Ed25519 signature over the raw 32-byte EIP-712 digest (`hashTypedData(...)`), `0x`-hex.
4. `POST /v1/api-key/enroll` body `{chain_id, address, typed_data, mac, signature: "0x…", pop_signature: "0x…"}` →
   `{api_key: ApiKeyInfo}`; token = `res.api_key.api_key`. 409 = pubkey already registered, 423 = 16-key limit, 404 = target profile not found.

Origin rule: docs say the `Origin` must be whitelisted by Perpl, browser or server. Desk enrolls through a server
relay that forwards only the body and `X-API-*` headers (no `Origin` set by Node fetch) and reports working
enrollment on mainnet **[desk]** `web/api/v1.mjs`, `docs/web-app.md`. So server-side enrollment without an `Origin`
header *may* work **[?]**. Plan: try server-side (no Origin) first; fallback is the user creating the key at
`https://testnet.perpl.xyz/apikeys` and pasting token + secret.

```ts
import { hashTypedData, type Hex } from 'viem';
// typed = payload.typed_data
const { EIP712Domain: _d, ...types } = typed.types;
const domain = { ...typed.domain, chainId: Number(typed.domain.chainId) };
const td = { domain, types, primaryType: typed.primaryType, message: typed.message } as const;
// walletSignature: Privy useSignTypedData / server eth_signTypedData_v4 over td
const digest = hashTypedData(td as any);                               // 0x + 64 hex
const pop = '0x' + sign(null, Buffer.from(digest.slice(2), 'hex'), k).toString('hex');
```

## 5. Trading WebSocket `wss://testnet.perpl.xyz/ws/v1/trading`

### 5.1 Message types [doc] websocket.md
1 Ping (C→S `{mt:1,t:<ms>}`), 2 Pong, 3 StatusResponse, 19 WalletSnapshot, 20 WalletUpdate, 21 AccountUpdate,
22 OrderRequest (C→S), 23 OrdersSnapshot, 24 OrdersUpdate, 25 FillsUpdate, 26 PositionsSnapshot, 27 PositionsUpdate,
28 AccountStatsUpdate, 29 ApiKeySignIn (C→S), 100 Heartbeat. Header fields: `mt`, `sid?`, `sn?`, `cid?`, `ses?`.
After sign-in you receive 19, 23, 26 in that order.

Limits (testnet): 60 requests/min per connection (pings count), 4 connections per **wallet** (shared by all keys and
browser sessions). Exceed → close `1008`. Keep-alive ping every 30 s on trading. **[doc]**

Close codes: 1008 (rate / connections / ping timeout / idle timeout), 1011 `failed to process` (unknown `mkt`, `acc`
not owned by wallet, unparseable frame — e.g. negative `mnp`; **no mt:3 is sent**), 1013 send-buffer overflow (read
faster), 1001 server going away (reconnect immediately), 3401 auth failure, 1006 network loss. Reconnect backoff
`[1000,2000,4000,8000,16000,32000,60000]` ms. **[doc]** README.md

### 5.2 WalletSnapshot `mt:19` / AccountUpdate `mt:21`
```ts
interface Wallet  { mt: 19; sn: number; at: {b:number;t:number}; addr: string; n: number; fl: number;
                    as?: Account[]; sts?: AccountStats[] }
interface Account { mt?: number; in: number; id: number; fr: boolean; fw: boolean; ft: number;
                    lfr: number;   // last forwarded rq — may arrive as string, parse defensively [desk]
                    b: string; lb: string; h?: AccountEvent[] }      // b/lb: AUSD in 6 dp, decimal strings
```
- `as` (compact) — Desk also accepts legacy `accounts` key. **[desk]** `SocketFrames.swift`.
- Seed heartbeat tracking: `lastSn = snapshot.sn`.
- Re-read `fw` and `ft` on every `mt:21` (they can change any time). If `fw === false`, block trading and prompt the user to run `allowOrderForwarding(true)`.

### 5.3 Heartbeat `mt:100`
`{mt:100, sn:number, h:number}` — `h` = latest head block. Require `sn === lastSn + 1`; on gap close and reconnect
(state may be missed), then reconcile with snapshots. **[doc]**

### 5.4 OrderRequest `mt:22` (all fields) [doc] websocket.md / types.md OrderSpec

| field | type | meaning / units |
|---|---|---|
| `mt` | 22 | |
| `sn` | uint, **non-zero, unique per frame** | echoed as `cid` on `mt:3`; omitted from `mt:3` if 0 |
| `rq` | uint64 | request id = idempotency key per account; new orders need `rq > lfr`; `rq = max(local, lfr) + 1` |
| `mkt` | uint32 | market id (BTC 16 …) |
| `acc` | uint64 | account id (from `as[].id` with `in == market.instance_id`) |
| `oid?` | uint64 | order to cancel/change |
| `t` | 1 OpenLong, 2 OpenShort, 3 CloseLong, 4 CloseShort, 5 Cancel, 6 IncreasePositionCollateral, 7 Change | |
| `p?` | uint | limit price scaled by `price_decimals`; `0` = market |
| `s` | uint | size scaled by `size_decimals`; `0` for cancel |
| `a?` | string | amount (CNS), type 6 only |
| `ms?` | uint bps | max market-order slippage; `0`/omitted = market default; must be `<= order_max_market_slippage_bps` [desk] |
| `mnp?` | uint 0..65535 bps | max negative-PnL collateralization; **omit** for market default (`order_max_neg_pnl_collat_bps`) |
| `tif?` | block | good-till block (GTC if unset) |
| `fl` | 0 GTC, 1 PostOnly, 2 FillOrKill, 4 ImmediateOrCancel | bit flags |
| `tp?` / `tpc?` | trigger price / 1 GTELast, 2 LTELast, 3 GTEMark, 4 LTEMark | trigger orders (SL/TP); needs `tpc` if `tp>0` |
| `tr?` / `lp?` | rq / position id | link trigger to request / position |
| `lv` | uint | leverage hundredths (500 = 5x), `100 <= lv <= initial_margin` |
| `lb` | block | last execution block; **send 0** (see §0.5) |
| `bf?` | uint | builder fee per 100k, builder-bound keys only — omit |

Hermes market order (what Desk ships, **[desk]** `OrderBuilder.market`, `web-app.md`):
```json
{"mt":22,"sn":17,"rq":1004,"mkt":16,"acc":4321,"t":1,"p":0,"s":100,"fl":4,"lv":300,"lb":0,"ms":50}
```
= open long 0.001 BTC (size_decimals 5 → 100), IOC market, 3x, 50 bps max slippage.
Close (reduce-only, clamped to position size): `t: 3|4, p: 0, s: <position size>, fl: 4, lv: 100, lb: 0, ms: 50`
(docs example also passes `lp: <position id>` — optional [?]). Cancel: `{t:5, oid, s:0, fl:0, lv:0|100, lb:0}`.

Validation before send **[doc]**: `s > 0`; market `config.is_open`; `lv` within market; `p > 0` for limit; `mnp`
range; socket OPEN. Unknown `mkt` or foreign `acc` kills the socket (1011) — validate against context first.

### 5.5 StatusResponse `mt:3` (one per `mt:22`)
```json
{"mt":3,"sid":100,"sn":991,"cid":17,"status":{"code":0,"error":""}}
```
`code 0` = accepted for forwarding only. `400` bad request (`order already expired`, `last exec block already expired`,
`last exec block too high`, `trigger price condition is not specified`, `invalid order type`,
`builder fee not permitted for this api key`, `max negative pnl collateralization out of range`), `403` read-scoped key
(`api key lacks trade scope`). Non-zero ⇒ no `mt:24` will follow ⇒ terminal failure. Desk also tolerates legacy
flat `{code, error, sr}` at root — parse both. **[doc]**, **[desk]**

### 5.6 OrdersUpdate `mt:24` / OrdersSnapshot `mt:23`
`{mt:24, at:{b,t}, d: Order[]}`. **Correlate by `rq` (+`acc`)**, not by `sn` **[desk]** audit follow-up.
```ts
interface Order { at: BlockTxLogTimestamp; c: BlockTxTimestamp; rq: number; mkt: number; acc: number;
  oid: number; scid: number; st: OrderStatus; sr: number; fr?: number; t: number; r?: boolean;
  p?: number; os: number; fp: number; fs: number; f: string; bfa?: string; tif?: number; fl: number;
  tp?: number; tpc?: number; lp?: number; mm: number; lv: number }
// BlockTxLogTimestamp = {b?, t? (ms), tx?, txid? (tx hash), l?}
```
`st` (OrderStatus): 0 Unspecified, 1 Pending, 2 Open, 3 PartiallyFilled, 4 Filled, 5 Canceled, 6 Expired, 7 Failed,
8 Untriggered, 9 Triggered, 10 Executed. `r: true` ⇒ drop from open orders. `fp` = weighted avg fill price (scaled),
`fs` = filled size, `os` = original size, `f` = gross fee (AUSD 6 dp string). `at.txid` = Monad tx hash (use for the
"transaction hashes" requirement).

Dedup rule **[doc]**: per `rq`, the first non-failure status (`st` 2–5, 8, 9, 10; Desk also counts 6) is definitive;
if only failures (`st:7`) arrive, take the first. Ignore late failures of an `rq` you already retried with a new `rq`.
Note an IOC that partially fills then cancels ⇒ check `fs` vs `os`, and `sr: 16` (ImmediateOrCancelExecuted).

Key `sr` (OrderStatusReason) values for UX: 1 AmountExceedsAvailableBalance, 2 AccountFrozen, 13 CrossesBook,
14 ExceedsLastExecutionBlock, 15 ForwardingReverted, 16 ImmediateOrCancelExecuted, 17 ImmediateOrderUnderMinimum,
22 MakerOrderFilled, 23 MakerOrderSettlementFailed, 32 OrderDescIdTooLow, 34 OrderForwardingNotAllowed,
35 OrderPlaced, 36 OrderPostFailed, 39 PostOrderUnderMinimum, 40 PriceOutOfRange, 42 SizeOutOfRange,
43 TakerOrderFilled, 44 TakerOrderSettlementFailed, 46 UnmatchedLotRemainsInFillOrKill, 52 WrongMarketForOrder,
61 ValueExceedsMaximum. Full table 0–69 in api-docs `types.md` (copy it verbatim into code).
`fr` (OrderFailureReason, only with sr 23/36/44): 1 InsufficientBalance, 2 InsufficientCollateralIncrease,
3 InsufficientCollateralInvert, 4 NoPositionToClose, 5 PerpetualSolvency, 6 NegativePositionValue,
7 ReferencePriceStale, 8 ExceedsMaxNegPnlCollat, 9 Other.

### 5.7 FillsUpdate `mt:25`
`{mt:25, at, d: Fill[]}`; `Fill = {at: BlockTxLogTimestamp, mkt, acc, oid, t, l: 1 maker|2 taker, p?, s, f: string, bfa?}`.
No `rq` on fills ⇒ map `oid → rq` from `mt:24`. Fee rate = `taker_fees[ft] ?? taker_fee` micros; fee = notional × micros / 1e6.

### 5.8 Positions `mt:26` / `mt:27`
`Position = {at, mkt, acc, pid, rq, oid, st (1 Open,2 Closed,3 Liquidated,4 Deleveraged,5 Unwound,6 Failed),
sr (13 Closed,14 Decreased,15 Deleveraged,17 Increased,18 Inverted,19 Liquidated,21 Opened,22 Unwound),
sd (1 Long, 2 Short), c: string (collateral), ep (entry price scaled), epr?, s (size), fee: string, cfee?: string,
efs, lv, dpnl?: string (realized delta PnL), fnd?: string (funding PnL), xp? (exit price), xfs, ots, e?: Position[] }`.
Realized PnL per close event: `dpnl + fnd - fee` (fee covers entry share + `cfee`). **[doc]** types.md "Fees on a position".

### 5.9 rq / retry state machine (implement exactly) [doc]
- On every (re)connect: `counter = max(counter, account.lfr)`; next `rq = ++counter`. Persist `counter` per account in DB.
- Send with `sn = ++frameCounter` (never 0), remember `{sn → rq}`, `{rq → alertId}`.
- `mt:3 code != 0` ⇒ failed (no retry unless cause fixed).
- `mt:24 sr:32` (DescIdTooLow) ⇒ retry **once** with a fresh `rq` after re-reading `lfr`.
- No status yet and `lb` not expired ⇒ may resend the **same** `rq` (at-most-once guaranteed).
- With `lb: 0` the server window is `order_ttl_blocks` (20 blocks on testnet; Monad ~0.4 s/block ⇒ ~8 s) [ours].
  Treat "no `mt:24` after head ≥ sentHead + ttl + margin, with no reconnect in between" as expired ⇒ new `rq` allowed.
  If a reconnect happened, first reconcile via `GET /v1/trading/orders` and `/v1/trading/order-history` by `rq`.
- Socket close with orders in flight ⇒ outcome unknown; reconcile, never assume dropped.

```ts
type Pending = { rq: number; sn: number; alertId: string; sentAt: number; sentHead: number; done: boolean };
function onStatus(m: any, bySn: Map<number, Pending>) {             // mt:3
  const p = bySn.get(m.cid ?? m.sn); if (!p) return;
  const code = m.status?.code ?? m.code;
  if (code !== 0) { p.done = true; /* mark alert FAILED: m.status?.error ?? m.error */ }
  else { /* mark SENT/FORWARDED */ }
}
function onOrders(m: any, byRq: Map<number, Pending>) {             // mt:24
  for (const o of m.d) {
    const p = byRq.get(o.rq); if (!p || p.done) continue;
    if (o.st === 7) { /* first failure: record sr/fr; keep listening briefly for a non-failure? docs: only if ALL are failures take first */ p.done = true; }
    else if ([2,3,4,5,6,8,9,10].includes(o.st)) { p.done = true; /* record fp, fs, os, f, at.txid, at.t */ }
  }
}
```

## 6. Market data (public) — mark/last price

WS `wss://testnet.perpl.xyz/ws/v1/market-data`, no auth, no pings needed (pings count toward 10 req/min).
16 subscriptions per connection. Subscribe:
```json
{"mt":5,"subs":[{"stream":"market-state@10143","subscribe":true},{"stream":"heartbeat@10143","subscribe":true}]}
```
Response `{mt:6, subs:[{stream, sid?, status?:{code:0|404|429, error?}}]}` (check each entry). Streams:
`heartbeat@<chain>`, `gas-stats@<chain>`, `market-config@<chain>` (mt 8), `market-state@<chain>` (mt 9),
`funding@<chain>` (mt 10), `candles@<mkt>*<res_s>` (mt 11/12), `order-book@<mkt>` (mt 15/16, `o:0` = remove level),
`trades@<mkt>` (mt 17/18). **[doc]**

`MarketStateUpdate = {mt:9, d: Record<marketId, MarketState>}`;
`MarketState = {at, orl (oracle), mrk (mark), lst (last), mid, bid, ask, prv (24h ago), dv, dva: string, oi, tvl: string}` — prices scaled by `price_decimals`.

REST alternatives (public): `GET /v1/market-data/ticker` (all markets, `{mt:9, sn:<block>, d:{[id]:MarketState}}`;
503 until warm), `GET /v1/market-data/:id/ticker`, `GET /v1/market-data/:id/book?levels=1..100`
(`{mt:15, sn, at, bid[], ask[]}`), `GET /v1/market-data/:id/candles/:res/:fromMs-:toMs` (max 1024),
`GET /v1/market-data/:id/funding/:from-:to`. Head block over HTTP: `sn` of ticker or any trading-state response.

Scaling helpers **[doc]** types.md:
```ts
const toScaled = (x: number, dec: number) => Math.round(x * 10 ** dec);
const fromScaled = (n: number, dec: number) => n / 10 ** dec;
// size from notional: s = toScaled(notionalUsd / markHuman, size_decimals); reject if s === 0
// AUSD amounts (b, lb, f, c, dpnl): BigInt(str) / 1e6
```

## 7. REST endpoints (signed with API key unless noted)

| Method/path | Scope | Returns |
|---|---|---|
| `GET /v1/pub/context` | public | Context (§2) |
| `GET /v1/trading/wallet` | read | `{mt:19, sn, at, addr, n, fl, as: Account[], sts: AccountStats[]}`; **404 if no exchange account** |
| `GET /v1/trading/orders` | read | `{mt:23, sn, at, d: Order[]}` open + untriggered |
| `GET /v1/trading/positions` | read | `{mt:26, sn, at, d: Position[]}` |
| `GET /v1/trading/fills?count=&page=` | read | `{d: Fill[], np}` newest first, count ≤ 100 |
| `GET /v1/trading/order-history?count=&page=` | read | `{d: Order[], np}` |
| `GET /v1/trading/position-history?count=&page=` | read | `{d: Position[], np}` |
| `GET /v1/trading/account-history?count=&page=` | read | `{d: AccountEvent[], np}` (et: 1 Deposit, 2 Withdrawal, 4 Settlement, 8 Funding, …) |
| `GET /v1/trading/portfolio/{equity|pnl}/{all|day|week|2weeks|month}` | read | `{at, chart:[{t, v}]}` |
| `POST /v1/trading/orders` | trade | body `{sn?, d: OrderSpec[] (1–100)}` → `{mt:31, cid?, status:{code}, statuses:[{code,error?}]}` (positional) |

No server-side filtering by market/date; paginate with `np` until empty. HTTP 503 = warming up, retry. 429 = back off.
`POST /v1/trading/orders` is a valid fallback transport for one-shot orders (same rq/lb semantics; per-order
codes 0/400/403/429/503). AccountStats `{td, tw, tv, tf, tbf?, trp, wr (bps), tt}`.

## 8. Fees reference
Rates in micros (1e-6): BTC testnet base taker 345 (3.45 bps), maker 45; tiers `taker_fees[ft]`. Fee charged on every
size-changing fill; `f` on orders/fills is gross. Liquidations not charged. **[doc]** README "Fees & fee tiers", [desk] context.

## 9. Competitor patterns worth copying
- Desk (`frankolien/desk`): API-key enrollment spike `reference/perpl/spike.mjs`; Swift order builder/tracker
  (`DeskKit/Sources/DeskPerpl/OrderRequest.swift`, `OrderTracker.swift`, `SocketFrames.swift`); test vectors
  `DeskKit/Tests/DeskPerplTests/CanonicalVectors.json`; captured contexts `Context-testnet.json`/`Context-mainnet.json`.
- Mirror (`Jagadeeshftw/mirror`): trades on-chain via its own contract + `execOrderV2`, not the WS API; useful only for
  testnet addresses and full Exchange ABI (`shared/abi/PerplExchange.json`). Perpl staff (Discord, 7 Oct) told them
  on-chain orders + API reads count for the API bounty **[mirror]** `docs/bounties/perpl-api.md`.

## Open uncertainties
1. Whether `lb = head + ttl` is really rejected on testnet today (Desk says yes on v235; docs say allowed). Use `lb: 0`.
2. Whether server-side `/v1/api-key/*` without an `Origin` header is accepted on testnet (Desk evidence is mainnet, via relay). Ask Perpl Discord; keep paste-in fallback.
3. Whether testnet trading endpoints return 451 to US IPs like mainnet. Deploy backend in an EU region regardless.
4. Live testnet context may have changed since ~13 Sep 2026 (collateral, min open 100 AUSD, markets, geo_block). Read at runtime; log it on boot.
5. Agora faucet AUSD amount per `requestFunds` and whether it is still funded; Mirror noted "no public mint" and relied on Perpl-funded pool.
6. `depositCollateral` minimum enforced on-chain vs only in UI (`min_deposit_amount` 10 AUSD).
7. Exact meaning of `ms` when `p: 0` (bps vs mark or vs best price) and whether `ms` omitted = `order_max_market_slippage_bps`.
8. Whether `lp` is required on Close orders (Desk omits it; docs example includes it).
9. `lfr`/amounts JSON types (number vs string) vary; parse defensively.
10. Whether `mt:100` heartbeats are sent on the trading socket at every block (docs imply yes) — needed for head tracking; else poll ticker `sn`.
11. Builder code registration not investigated (optional; contact Perpl).
