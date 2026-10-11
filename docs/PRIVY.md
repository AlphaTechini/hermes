# How Hermes uses Privy

Privy is not only the login screen. Hermes uses it as the wallet layer: Privy creates and holds the user's wallet, signs
the user's Perpl account setup in the browser, and signs funding transactions for the Hermes server under a spending
policy that Privy itself enforces. All calls below are real `@privy-io/react-auth` / `@privy-io/node` APIs.

| # | What | Who signs | Privy API |
|---|------|-----------|-----------|
| 1 | Email sign-in, embedded wallet created on Monad testnet | the user | `PrivyProvider` (`loginMethods: ['email']`, `embeddedWallets.ethereum.createOnLogin`), server: `utils().auth().verifyAccessToken` |
| 2 | Perpl account setup: `approve`, `createAccount`, `allowOrderForwarding` | the user's embedded wallet, in the browser | `useSendTransaction()` |
| 3 | Hermes server becomes a restricted signer of that wallet | the user (one prompt) | `useSigners().addSigners({ address, signers: [{ signerId, policyIds }] })`; server confirms with `users()._get` and `wallets().getWalletByAddress` |
| 4 | Top-ups and setup steps sent by the server, no prompt | the Hermes server key, inside the policy | `wallets().ethereum().sendTransaction(walletId, { caip2: 'eip155:10143', params: { transaction }, authorization_context })` |
| 5 | A forbidden transaction is refused | Privy's policy engine | same call; Privy answers with a policy error, Hermes records `denied_by_policy` |

## The Hermes policy

Created once by `pnpm --filter @hermes/server privy:bootstrap` (`policies().create`, rules in `apps/server/src/privy/policy.ts`)
and attached to each wallet as the override policy of the Hermes signer. Privy policies are default-deny, so anything not
listed is refused:

- chain id 10143 (Monad testnet) only;
- native value must be 0 (no MON can leave the wallet);
- `to` must be the Perpl Exchange, the AUSD token or the Agora faucet;
- on the AUSD token only `approve(spender, amount)` with `spender` = the Perpl Exchange and `amount` <= `PRIVY_APPROVE_CAP`
  (default 10,000 AUSD);
- everything stops matching after the expiry time (`current_unix_timestamp <= PRIVY_POLICY_EXPIRES_AT`).

The Hermes server key is a P-256 authorization key (`generateP256KeyPair`) inside a key quorum (`keyQuorums().create`).
Its private key lives only in the server environment (`PRIVY_AUTHORIZATION_PRIVATE_KEY`). A leaked key still cannot do more
than the policy allows, and the user can remove the signer at any time.

## Setup (once per deployment)

1. In the Privy dashboard enable email login and copy the app id and secret into `apps/server/.env`.
2. `pnpm --filter @hermes/server privy:bootstrap` prints `PRIVY_AUTHORIZATION_PRIVATE_KEY`, `PRIVY_KEY_QUORUM_ID`,
   `PRIVY_POLICY_ID`, `PRIVY_POLICY_EXPIRES_AT` (server) and the two `VITE_PRIVY_*` ids (web). Nothing is written to disk.

## Endpoints (all need the user's Privy access token)

| Endpoint | Purpose |
|---|---|
| `GET /api/privy/signer-config` | `{ keyQuorumId, policyIds, policy }` for `addSigners` |
| `POST /api/privy/signer-registered` `{ address }` | after `addSigners`: the server asks Privy that the address is the user's embedded wallet and that the Hermes signer **with the Hermes policy** is on it, then stores wallet id and status |
| `POST /api/wallet/actions` `{ kind, amount? }` | `approve_collateral`, `create_account`, `allow_forwarding`, `deposit`, `faucet`; calldata built server-side, sent through Privy, recorded, streamed over SSE |
| `GET /api/wallet/actions` | history with status `submitted`, `confirmed`, `failed` or `denied_by_policy` |
| `POST /api/wallet/policy-demo` | deliberately sends 0.001 MON to an arbitrary address (or `{ "variant": "approve_other_spender" }`). The Hermes pre-flight check is skipped, so Privy itself must refuse. This is the "one transaction blocked by a policy" proof |

Requests that the local mirror (`evaluatePolicy`) already knows are forbidden (for example an approve above the cap) are
rejected with a clear reason before Privy is called. Without Privy credentials (`AUTH_MODE=dev`) the wallet is simulated: fake
transaction hashes, but the same policy is evaluated locally, so the policy demo still shows a realistic denial.

## What is verified

Types and method names were checked against `@privy-io/node` 0.35.0. The Privy dashboard docs were unreachable while
building, so the following must be confirmed on the first live run (they are isolated in `policy.ts` and
`privy-service.ts`): the `ethereum_calldata` field names (`approve.spender`, `approve.amount`), address case handling in
conditions, and the exact error Privy returns for a policy denial.
