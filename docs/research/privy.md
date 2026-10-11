# Privy integration research

Researched 11 Oct 2026. `docs.privy.io` was unreachable from the sandbox (curl and WebFetch both failed DNS), so facts
come from: the published npm packages' `.d.ts` files (authoritative for signatures), Privy's official examples repo
`github.com/privy-io/examples` @ 7 Oct 2026 (`privy-react-starter`, `privy-node-starter`, `privy-vanilla-starter`),
and WebSearch snippets of docs.privy.io pages. **[dts]** = read from package types, **[ex]** = official example,
**[web]** = search snippet of docs.privy.io, **[?]** = unverified.

## 1. Packages (verified with `npm view`, 11 Oct 2026)

| Package | Version | Use |
|---|---|---|
| `@privy-io/react-auth` | **3.48.1** (9 Oct 2026) | Frontend. peer: `react ^18 || ^19`, `react-dom`; Solana/permissionless peers are optional |
| `@privy-io/node` | **0.35.0** (21 Sep 2026) | Backend: token verification, wallets, policies, key quorums, intents. Node 20+ |
| `@privy-io/server-auth` | 1.32.5 | **Deprecated** on npm: "use @privy-io/node instead". Do not use |
| `@privy-io/js-sdk-core` | 0.78.2 | Vanilla JS core (what react-auth wraps) |
| `viem` | 2.57.4 latest (react-auth pins 2.56.5) | chain def, encoding |

Vite needs Node polyfills for react-auth: official starter uses `vite-plugin-node-polyfills` (`plugins: [react(), nodePolyfills()]`). **[ex]** `privy-react-starter/vite.config.ts`.

## 2. Frontend: email login + auto embedded EVM wallet on Monad testnet

`viem/chains` already exports `monadTestnet` (id 10143, rpc `https://testnet-rpc.monad.xyz`, MON 18 dp,
explorer `https://testnet.monadexplorer.com`, multicall3) — no `defineChain` needed. **[dts]** viem `chains/definitions/monadTestnet.ts`.

Config fields verified in `@privy-io/react-auth` `PrivyClientConfig` **[dts]**: `loginMethods?: Array<'email'|'wallet'|…>`,
`supportedChains?: Chain[]`, `defaultChain?: Chain`, `embeddedWallets.ethereum.createOnLogin?: 'users-without-wallets'|'all-users'|'off'` (default `'off'`),
`embeddedWallets.showWalletUIs?: boolean`. Embedded wallets default to `defaultChain`.

```tsx
// main.tsx
import { PrivyProvider } from '@privy-io/react-auth';
import { monadTestnet } from 'viem/chains';

createRoot(document.getElementById('root')!).render(
  <PrivyProvider
    appId={import.meta.env.VITE_PRIVY_APP_ID}
    config={{
      loginMethods: ['email'],
      embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' }, showWalletUIs: true },
      supportedChains: [monadTestnet],
      defaultChain: monadTestnet,
      appearance: { walletChainType: 'ethereum-only' },   // starter uses 'ethereum-and-solana'
    }}
  >
    <App />
  </PrivyProvider>,
);
```

Dashboard (manual): enable Email login; add allowed origins (localhost:5173 + deployed domain); optionally enable
"HttpOnly cookies". Copy App ID (public) and App Secret (server only).

Hooks (all exported from `@privy-io/react-auth`) **[dts]**:
```ts
const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy(); // getAccessToken(): Promise<string|null>
const { wallets, ready: walletsReady } = useWallets();                          // ConnectedWallet[]
const embedded = wallets.find(w => w.walletClientType === 'privy');
// ConnectedWallet: address, chainId, switchChain(id: `0x${string}`|number): Promise<void>, getEthereumProvider(): Promise<EIP1193Provider>
// user.linkedAccounts wallet: { id?: string|null /* server wallet id; null until delegated / signer added */, address, chainType, walletClientType, delegated: boolean, ... }
```

## 3. Sending transactions from the embedded wallet (client side)

`useSendTransaction` signature **[dts]** index.d.ts:
```ts
declare function useSendTransaction(callbacks?: PrivyEvents['sendTransaction']): {
  sendTransaction: (input: UnsignedTransactionRequest, options?: {
    sponsor?: boolean; uiOptions?: SendTransactionModalUIOptions; fundWalletConfig?: FundWalletConfig; address?: string;
  }) => Promise<{ hash: `0x${string}` }>;
};
type UnsignedTransactionRequest = { from?; to?; nonce?; gasLimit?; gasPrice?; data?: string | ArrayLike<number>;
  value?: Quantity; chainId?: number; type?; accessList?; maxPriorityFeePerGas?; maxFeePerGas? };
// SendTransactionModalUIOptions: { showWalletUIs?, description?, buttonText?, ... }
```

Perpl account setup from the browser (calldata builders from perpl.md §3):
```ts
import { useSendTransaction } from '@privy-io/react-auth';
import { createPublicClient, http } from 'viem';
import { monadTestnet } from 'viem/chains';
const pub = createPublicClient({ chain: monadTestnet, transport: http() });

const { sendTransaction } = useSendTransaction();
async function setupPerpl(address: `0x${string}`, amountCNS: bigint) {
  for (const tx of [txApprove(amountCNS), txCreate(amountCNS), txForward()]) {
    const { hash } = await sendTransaction({ ...tx, chainId: 10143 },
      { address, uiOptions: { description: 'Perpl account setup', showWalletUIs: true } });
    await pub.waitForTransactionReceipt({ hash });           // sequential: approve must land first
  }
}
```
Do NOT pass `sponsor: true` (gas sponsorship uses paid credits). The wallet needs testnet MON for gas.

Alternative: viem wallet client over the EIP-1193 provider **[ex]** vanilla starter does the same with `privy.embeddedWallet.getEthereumProvider`:
```ts
import { createWalletClient, custom } from 'viem';
await embedded.switchChain(10143);
const wc = createWalletClient({ account: embedded.address as `0x${string}`, chain: monadTestnet, transport: custom(await embedded.getEthereumProvider()) });
await wc.writeContract({ address: EXCHANGE, abi: exchangeAbi, functionName: 'allowOrderForwarding', args: [true] });
```
EIP-712 (Perpl API-key enrollment): `useSignTypedData().signTypedData({domain, types, primaryType, message}, {address}) => Promise<{signature}>` **[dts]**.

## 4. Backend: verify access tokens (@privy-io/node 0.35.0) [dts]

```ts
import { PrivyClient } from '@privy-io/node';
export const privy = new PrivyClient({
  appId: process.env.PRIVY_APP_ID!, appSecret: process.env.PRIVY_APP_SECRET!,
  // optional: jwtVerificationKey: process.env.PRIVY_VERIFICATION_KEY (SPKI from dashboard) to skip JWKS fetch
});

// Fastify preHandler
app.addHook('preHandler', async (req, reply) => {
  if (!req.url.startsWith('/api/')) return;
  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '') || req.cookies?.['privy-token'];
  if (!token) return reply.code(401).send({ error: 'unauthenticated' });
  try {
    const claims = await privy.utils().auth().verifyAccessToken(token);
    // claims: { app_id, issuer, issued_at, expiration, session_id, user_id }   // user_id = "did:privy:..."
    req.privyUserId = claims.user_id;
  } catch { return reply.code(401).send({ error: 'invalid token' }); }
});
```
Exact types: `PrivyAuthUtils.verifyAccessToken(accessToken: string): Promise<VerifyAccessTokenResponse>`;
`verifyAuthToken` is deprecated alias; `verifyIdentityToken(idToken): Promise<User>`. Standalone functional form:
`verifyAccessToken({ access_token, app_id, verification_key })` exported from the package root (`verification_key`: SPKI string, `CryptoKey`, or `createRemoteJWKSet` getter).
Client sends `Authorization: Bearer ${await getAccessToken()}`. Invalid token throws `InvalidAuthTokenError`.

User lookup: `privy.users()._get(userId): APIPromise<User>`, `privy.users().get({ id_token })`, `getByEmailAddress`, `getByWalletAddress`.
Embedded wallet linked account (server `User.linked_accounts[]`): `{ type:'wallet', id: string|null, address, chain_type:'ethereum', connector_type:'embedded', wallet_client_type:'privy', delegated: boolean, ... }`.
Wallet lookup: `privy.wallets().getWalletByAddress({ address })`, `privy.wallets().get(walletId)` → `Wallet { id, address, chain_type, owner_id, policy_ids, additional_signers, ... }`.

## 5. Server-side transactions + policies ("beyond login")

### 5.1 Model (as of late 2026)
- Every wallet has an **owner** (user, P-256 key, or key quorum) and optional **additional signers** (key quorums;
  "session signers" is the deprecated name; React `useSessionSigners` is `@deprecated in favor of useSigners`) **[dts]**.
- **Policies** (`privy.policies().create`) are attached either to the wallet (`policy_ids`, applies to the owner;
  "currently only one policy per wallet") or **per signer** via `additional_signers[].override_policy_ids` (up to one).
  When a signer submits a request, Privy evaluates only that signer's override policy. Enforced inside Privy's TEE. **[dts]** WalletUpdateParams, AdditionalSignerItemInput; **[web]** docs "owners/signers overview", "policy-and-controls".
- So: policies **do** apply to embedded user wallets, through the signer you add to them. This is exactly Hermes'
  case: user's embedded wallet + Hermes server as an additional signer restricted by a policy.

### 5.2 One-time setup (server script)
```ts
import { PrivyClient, generateP256KeyPair } from '@privy-io/node';
// 1. Authorization key for the Hermes server (or create it in Dashboard → Authorization keys; it shows "wallet-auth:..." private key — SDK strips that prefix)
const kp = await generateP256KeyPair();          // { publicKey, privateKey } base64 DER; store privateKey as HERMES_AUTH_KEY (secret)
const quorum = await privy.keyQuorums().create({ public_keys: [kp.publicKey], authorization_threshold: 1, display_name: 'Hermes server' });
// quorum.id => HERMES_SIGNER_ID (also VITE_PRIVY_SIGNER_ID on the client)

// 2. Policy: only Monad testnet, only AUSD + Perpl Exchange, no native value, until a deadline
const EXCHANGE = '0x1964c32f0be608e7d29302aff5e61268e72080cc';
const AUSD = '0xa9012a055bd4e0edff8ce09f960291c09d5322dc';
const ERC20_APPROVE_ABI = [{ type: 'function', name: 'approve', stateMutability: 'nonpayable',
  inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }];
// 1792800000 = 2026-10-24T00:00:00Z; pick "now + N days" at creation
const policy = await privy.policies().create({
  version: '1.0', name: 'Hermes: Perpl deposits only', chain_type: 'ethereum',
  owner_id: quorum.id,                                  // so the server can later edit it
  rules: [
    { name: 'Exchange deposit/create/forwarding', method: 'eth_sendTransaction', action: 'ALLOW', conditions: [
      { field_source: 'ethereum_transaction', field: 'chain_id', operator: 'eq', value: '10143' },
      { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: EXCHANGE },
      { field_source: 'ethereum_transaction', field: 'value', operator: 'eq', value: '0' },
      { field_source: 'system', field: 'current_unix_timestamp', operator: 'lte', value: String(1792800000) }, // time bound (unix s)
    ]},
    { name: 'AUSD approve to Exchange, capped', method: 'eth_sendTransaction', action: 'ALLOW', conditions: [
      { field_source: 'ethereum_transaction', field: 'chain_id', operator: 'eq', value: '10143' },
      { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: AUSD },
      { field_source: 'ethereum_calldata', field: 'approve.spender', operator: 'eq', value: EXCHANGE, abi: ERC20_APPROVE_ABI },
      { field_source: 'ethereum_calldata', field: 'approve.amount', operator: 'lte', value: '500000000', abi: ERC20_APPROVE_ABI }, // 500 AUSD
    ]},
  ],
});
// policy.id => HERMES_POLICY_ID
```
Verified types **[dts]** `resources/policies.d.ts`: `PolicyCreateParams { chain_type, name, rules: {action:'ALLOW'|'DENY', conditions, method, name}[], version:'1.0', owner?, owner_id? }`;
`PolicyMethod` includes `'eth_sendTransaction' | 'eth_signTransaction' | 'eth_signTypedData_v4' | 'personal_sign' | '*' | ...`;
condition sources: `ethereum_transaction` (field `'to'|'value'|'chain_id'`), `ethereum_calldata` (any `field` string + required `abi`),
`ethereum_typed_data_domain`, `ethereum_typed_data_message`, `system` (field `'current_unix_timestamp'`, seconds), plus others;
operators `'eq'|'gt'|'gte'|'lt'|'lte'|'in'|'in_condition_set'|'contains'|'starts_with'|'ends_with'`; `value: string | string[]`.
The `ethereum_calldata` field naming `"<function>.<param>"` is from memory of Privy docs **[?]** — test it.
Restricting the Exchange *function* (createAccount/depositCollateral/allowOrderForwarding but not withdraw): add an
`ethereum_calldata` condition on the Exchange ABI, or keep the simple `to`-allowlist (withdraw only sends funds back to
the user's own wallet, so the risk is low).

### 5.3 Attach Hermes as signer to the user's embedded wallet (client, needs user)
```ts
import { useSigners } from '@privy-io/react-auth';
const { addSigners, removeSigners } = useSigners();
await addSigners({ address: embedded.address, signers: [{ signerId: import.meta.env.VITE_PRIVY_SIGNER_ID, policyIds: [import.meta.env.VITE_PRIVY_POLICY_ID] }] });
// type: addSigners({address: string; signers: {signerId: string; policyIds?: string[]}[]}) => Promise<{user}>   [dts]
```
Server alternative **[ex]** `privy-node-starter/src/handlers/additional_signers/add_treasury.ts`:
```ts
await privy.wallets().update(walletId, {
  additional_signers: [{ signer_id: HERMES_SIGNER_ID, override_policy_ids: [HERMES_POLICY_ID] }],
  authorization_context: { user_jwts: [userAccessToken] },     // the user's Privy access token authorizes it
});
```
After a signer is added the React wallet object gets a non-null `id` (server wallet id) **[dts]** comment on `Wallet.id`.

### 5.4 Server sends a transaction from the user's wallet under the policy [ex] send_usdc.ts, [dts] ethereum.d.ts
```ts
const res = await privy.wallets().ethereum().sendTransaction(walletId, {
  caip2: 'eip155:10143',
  params: { transaction: { to: EXCHANGE, data: depositCalldata, value: '0x0', chain_id: 10143 } },
  authorization_context: { authorization_private_keys: [process.env.HERMES_AUTH_KEY!] },
  // idempotency_key?: string, reference_id?: string
});
// res: { hash: string, transaction_id?: string, reference_id?, ... }
```
A request that breaks the policy is refused by Privy (expect an API error, 4xx) — log it as the "blocked by policy" demo
case (e.g. try `to: someRandomAddress` or `approve` above the cap). Exact error shape **[?]**.
`UnsignedEthereumTransaction` fields: `to, data, value, chain_id, gas_limit, gas_price, max_fee_per_gas, max_priority_fee_per_gas, nonce, type (0|1|2|4), from, authorization_list` (Quantity = hex string or number).
Signing typed data server-side (Perpl key enrollment without user prompt): `privy.wallets().ethereum().signTypedData(walletId, {params:{typed_data}, authorization_context})` — needs a policy rule with method `'eth_signTypedData_v4'` (e.g. `ethereum_typed_data_domain` `name`/`verifyingContract` eq Perpl's values) **[?]** param shape not checked.

### 5.5 Human approval (intents)
`privy.intents()` exists **[dts]**: `rpc(walletId, params)` creates an RPC intent that "must be authorized by the
owner before it can be executed"; statuses `'pending'|'processing'|'executed'|'failed'|'expired'|'rejected'|'dismissed'`;
`intents().list()`. How the end user approves an intent from the React SDK was not verified **[?]**. Recommendation:
implement Hermes' own approval queue (order waits in DB until the user clicks Approve in Hermes UI) for Perpl orders —
those are Ed25519-signed by Hermes, not by Privy, so Privy intents cannot gate them anyway. Use Privy intents only if
time allows, for large deposits.

## 6. What "beyond login" looks like for Hermes (recommended scope)
1. Email login → embedded wallet auto-created on Monad testnet (`createOnLogin`).
2. Embedded wallet signs Perpl setup: `approve`, `createAccount`, `allowOrderForwarding` (client `useSendTransaction`).
3. Embedded wallet signs the Perpl API-key EIP-712 enrollment (client `useSignTypedData`), if Perpl accepts our origin.
4. Hermes server added as signer with a policy (only Exchange/AUSD, chain 10143, value 0, approve cap, time bound) and
   uses it for automatic top-ups (`depositCollateral`) — show one allowed and one policy-blocked tx in the demo.

## 7. Svelte vs React — recommendation: **React + Vite (confirmed)**
- No official Svelte SDK. `@privy-io/js-sdk-core` is the vanilla client and supports embedded wallets
  (`privy.embeddedWallet.getEthereumProvider`, requires mounting Privy's embedded-wallet iframe and building all login UI
  yourself) **[ex]** `privy-vanilla-starter/README.md`, `src/sections/wallet-actions.js`.
- React gets the prebuilt login modal, wallet confirmation UI, `useSigners`, `useSendTransaction`, and every example.
  Svelte would cost a day of glue for no judging benefit. PerplBot's visualizer is Svelte, irrelevant here.

## 8. Env vars
Client: `VITE_PRIVY_APP_ID`, `VITE_PRIVY_SIGNER_ID`, `VITE_PRIVY_POLICY_ID`.
Server: `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_VERIFICATION_KEY` (optional), `HERMES_SIGNER_ID`, `HERMES_AUTH_KEY` (P-256 private, base64 PKCS8), `HERMES_POLICY_ID`.

## Open uncertainties
1. Whether Privy's server-side `sendTransaction` broadcasts on `eip155:10143` (Monad testnet appears in Privy's chain list per details.md; not re-verified). Test first; fallback: server `signTransaction` + broadcast via viem `sendRawTransaction`.
2. Exact `ethereum_calldata` field syntax and whether `abi` must be the full function fragment array.
3. Whether a wallet-level `policy_ids` on a user-owned embedded wallet also restricts the user's own client-side signing (not needed for Hermes).
4. Shape of the error returned when a policy denies a request (status code, message) — capture it in the first test.
5. Whether adding a signer requires "TEE execution" / a specific wallet architecture setting in the dashboard for older apps; new apps should be fine.
6. How users approve Privy intents in the React SDK (not verified; avoid depending on it).
7. Free-tier limits (499 MAU, 50k signatures) from details.md not re-checked; Privy webhooks may be Enterprise-only — poll instead.
8. `createOnLogin: 'users-without-wallets'` prompts creation after login; confirm it is silent when `showWalletUIs` is false.
