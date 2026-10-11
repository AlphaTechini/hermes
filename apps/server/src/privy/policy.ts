/**
 * THE HERMES PRIVY POLICY: single source of truth, in two forms that must stay in sync.
 *
 *  1. {@link buildPolicyCreateParams}: the rule set sent to Privy (`privy.policies().create`) by the bootstrap script.
 *     Privy enforces it inside its TEE for every request signed by the Hermes server key quorum.
 *  2. {@link evaluatePolicy}: a local mirror used (a) by the dev-mode wallet, (b) as a pre-flight check in privy
 *     mode so obviously-forbidden transactions are rejected with a clear reason before calling Privy.
 *     The policy demo skips the pre-flight on purpose, to prove that Privy itself refuses.
 *
 * SYNTAX STATUS (docs.privy.io was unreachable when this was written; see docs/research/privy.md):
 *  - VERIFIED against @privy-io/node 0.35.0 type definitions: rule/condition shapes, `field_source` values
 *    `ethereum_transaction` (fields to | value | chain_id), `ethereum_calldata` (field: string + abi),
 *    `system` (field current_unix_timestamp, seconds), operators eq | lte | in, `value: string | string[]`.
 *  - UNVERIFIED against the live API (confirm on the first bootstrap run):
 *      * the `ethereum_calldata` field naming `"<function>.<param>"` (here `approve.spender`, `approve.amount`),
 *      * whether address comparisons are case-insensitive (we hedge by listing both EIP-55 and lowercase with `in`),
 *      * whether decimal strings are accepted for `value`/`chain_id` (the example in privy.md uses them),
 *      * the exact error Privy returns when a rule denies a request (see classifyPrivyError in privy-service.ts).
 *    If a rule is rejected at creation time, only THIS file needs to change.
 *  - Privy policies are default-deny: a request that matches no ALLOW rule is refused.
 */
import { MONAD_TESTNET_CHAIN_ID } from "@hermes/shared";
import { decodeFunctionData, formatUnits, getAddress, type Hex } from "viem";
import type { PrivyClient } from "@privy-io/node";
import { AUSD_DECIMALS, erc20ApproveAbi, type TxRequest } from "./abi";

export type PolicyCreateParams = Parameters<ReturnType<PrivyClient["policies"]>["create"]>[0];

export interface HermesPolicySpec {
  chainId: number;
  /** Lowercase 0x addresses. */
  exchange: string;
  ausd: string;
  faucet: string;
  /** Max `approve` amount, AUSD base units (6 decimals). */
  approveCapBase: bigint;
  /** Unix seconds; every rule stops matching afterwards. Null = no time bound. */
  expiresAt: number | null;
}

export function specFromConfig(c: {
  exchangeAddress: string;
  ausdAddress: string;
  faucetAddress: string;
  approveCapBase: bigint;
  policyExpiresAt: number | null;
}): HermesPolicySpec {
  return {
    chainId: MONAD_TESTNET_CHAIN_ID,
    exchange: c.exchangeAddress.toLowerCase(),
    ausd: c.ausdAddress.toLowerCase(),
    faucet: c.faucetAddress.toLowerCase(),
    approveCapBase: c.approveCapBase,
    expiresAt: c.policyExpiresAt,
  };
}

// ---------------------------------------------------------------------------
// 1. The rules sent to Privy
// ---------------------------------------------------------------------------

/** Both spellings, because address-case handling in the policy engine is unverified. */
const addressVariants = (a: string): string[] => [...new Set([getAddress(a), a.toLowerCase()])];

export function buildPolicyCreateParams(spec: HermesPolicySpec, ownerKeyQuorumId: string, name = "Hermes: Perpl wallet actions"): PolicyCreateParams {
  const tx = (field: "chain_id" | "to" | "value", operator: "eq" | "in", value: string | string[]) =>
    ({ field_source: "ethereum_transaction", field, operator, value }) as const;
  const common = [
    tx("chain_id", "eq", String(spec.chainId)),
    tx("value", "eq", "0"), // no native MON can ever leave the wallet
    ...(spec.expiresAt !== null
      ? ([{ field_source: "system", field: "current_unix_timestamp", operator: "lte", value: String(spec.expiresAt) }] as const)
      : []),
  ];
  const calldata = (field: string, operator: "eq" | "in" | "lte", value: string | string[]) =>
    ({ field_source: "ethereum_calldata", field, operator, value, abi: erc20ApproveAbi }) as const;

  return {
    version: "1.0",
    name,
    chain_type: "ethereum",
    owner_id: ownerKeyQuorumId, // the Hermes key quorum can later amend/delete this policy
    rules: [
      {
        name: "Perpl Exchange: createAccount / depositCollateral / allowOrderForwarding",
        method: "eth_sendTransaction",
        action: "ALLOW",
        conditions: [...common, tx("to", "in", addressVariants(spec.exchange))],
      },
      {
        name: "AUSD: approve(Exchange, amount <= cap) only",
        method: "eth_sendTransaction",
        action: "ALLOW",
        conditions: [
          ...common,
          tx("to", "in", addressVariants(spec.ausd)),
          calldata("approve.spender", "in", addressVariants(spec.exchange)),
          calldata("approve.amount", "lte", spec.approveCapBase.toString()),
        ],
      },
      {
        name: "Agora faucet: requestFunds",
        method: "eth_sendTransaction",
        action: "ALLOW",
        conditions: [...common, tx("to", "in", addressVariants(spec.faucet))],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 2. The local mirror
// ---------------------------------------------------------------------------

export type PolicyDenyCode =
  | "wrong_chain"
  | "expired"
  | "native_value"
  | "unknown_target"
  | "ausd_not_approve"
  | "ausd_wrong_spender"
  | "ausd_over_cap";

export type PolicyDecision = { allowed: true; rule: string } | { allowed: false; code: PolicyDenyCode; reason: string };

export type PolicyTxInput = Omit<TxRequest, "to" | "data" | "chainId"> & {
  chainId: number | undefined;
  to: string | undefined;
  data?: Hex | string | undefined;
};

const deny = (code: PolicyDenyCode, reason: string): PolicyDecision => ({ allowed: false, code, reason });

/** Mirror of the rules in {@link buildPolicyCreateParams}. `nowSec` is injectable for tests. */
export function evaluatePolicy(tx: PolicyTxInput, spec: HermesPolicySpec, nowSec: number = Math.floor(Date.now() / 1000)): PolicyDecision {
  if (tx.chainId !== spec.chainId) {
    return deny("wrong_chain", `chain_id ${tx.chainId ?? "unset"} is not allowed (only ${spec.chainId}, Monad testnet)`);
  }
  if (spec.expiresAt !== null && nowSec > spec.expiresAt) {
    return deny("expired", `the policy expired at ${new Date(spec.expiresAt * 1000).toISOString()}`);
  }
  if (tx.value !== 0n) {
    return deny("native_value", `native value must be 0 (got ${formatUnits(tx.value, 18)} MON)`);
  }
  const to = tx.to?.toLowerCase();
  if (to === spec.exchange) return { allowed: true, rule: "Perpl Exchange" };
  if (to === spec.faucet) return { allowed: true, rule: "Agora faucet" };
  if (to === spec.ausd) {
    let decoded: { spender: string; amount: bigint };
    try {
      const d = decodeFunctionData({ abi: erc20ApproveAbi, data: (tx.data ?? "0x") as Hex });
      decoded = { spender: d.args[0], amount: d.args[1] };
    } catch {
      return deny("ausd_not_approve", "only approve(spender, amount) may be called on the AUSD token");
    }
    if (decoded.spender.toLowerCase() !== spec.exchange) {
      return deny("ausd_wrong_spender", `AUSD approve spender ${decoded.spender} is not the Perpl Exchange (${spec.exchange})`);
    }
    if (decoded.amount > spec.approveCapBase) {
      return deny(
        "ausd_over_cap",
        `AUSD approve amount ${formatUnits(decoded.amount, AUSD_DECIMALS)} exceeds the cap of ${formatUnits(spec.approveCapBase, AUSD_DECIMALS)}`,
      );
    }
    return { allowed: true, rule: "AUSD approve to Exchange" };
  }
  return deny("unknown_target", `target ${tx.to ?? "(none)"} is not the Perpl Exchange, the AUSD token or the Agora faucet`);
}
