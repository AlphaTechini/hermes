import { z } from "zod";

/**
 * Privy wallet DTOs: the Hermes server signer on the user's embedded wallet, the actions it performs
 * under the Privy policy, and the deliberate policy-denial demo.
 */

/** Monad testnet. The only chain the Hermes Privy policy allows. */
export const MONAD_TESTNET_CHAIN_ID = 10143;
export const MONAD_TESTNET_CAIP2 = "eip155:10143";

export const WALLET_ACTION_KINDS = [
  "approve_collateral",
  "create_account",
  "allow_forwarding",
  "deposit",
  "faucet",
  /** Deliberately forbidden transaction used to prove the policy blocks it. */
  "policy_demo",
] as const;
export const WalletActionKind = z.enum(WALLET_ACTION_KINDS);
export type WalletActionKind = z.infer<typeof WalletActionKind>;

export const WALLET_ACTION_STATUSES = ["submitted", "confirmed", "failed", "denied_by_policy"] as const;
export const WalletActionStatus = z.enum(WALLET_ACTION_STATUSES);
export type WalletActionStatus = z.infer<typeof WalletActionStatus>;

/** AUSD amounts are human units ("100", "12.5"), at most 6 decimals. */
const AusdAmount = z
  .union([z.number(), z.string()])
  .transform((v) => String(v).trim())
  .pipe(z.string().regex(/^\d+(\.\d{1,6})?$/, "must be a positive decimal with at most 6 decimals"))
  .refine((v) => Number(v) > 0, "must be greater than 0");

export const WalletActionRequest = z.object({
  /** Setup and funding actions the server may perform through its Privy signer. */
  kind: z.enum(["approve_collateral", "create_account", "allow_forwarding", "deposit", "faucet"]),
  /** AUSD (human units). Required for create_account and deposit; approve_collateral defaults to the policy cap. */
  amount: AusdAmount.optional(),
});
export type WalletActionRequest = z.infer<typeof WalletActionRequest>;

export const PolicyDemoRequest = z.object({
  /** native_transfer: send 0.001 MON to an arbitrary address. approve_other_spender: approve AUSD to a non-Exchange spender. */
  variant: z.enum(["native_transfer", "approve_other_spender"]).default("native_transfer"),
});
export type PolicyDemoRequest = z.infer<typeof PolicyDemoRequest>;

export const SignerRegisteredRequest = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address"),
});
export type SignerRegisteredRequest = z.infer<typeof SignerRegisteredRequest>;

export interface PolicySummaryDTO {
  chainId: number;
  exchange: string;
  collateralToken: string;
  faucet: string;
  /** Max AUSD `approve` amount, human units. */
  approveCapAusd: string;
  /** Unix seconds after which Privy refuses everything, or null for no time bound. */
  expiresAt: number | null;
}

/** What the frontend passes to `useSigners().addSigners({ address, signers: [{ signerId, policyIds }] })`. */
export interface SignerConfigDTO {
  mode: "privy" | "dev";
  /** False when the server has no Privy key quorum / policy configured (wallet actions are unavailable). */
  configured: boolean;
  keyQuorumId: string | null;
  policyIds: string[];
  policy: PolicySummaryDTO;
}

export interface PrivyWalletDTO {
  walletId: string;
  address: string;
  /** Null until the user has added the Hermes signer. */
  signerAddedAt: number | null;
  policyId: string | null;
  simulated: boolean;
}

export interface WalletActionDTO {
  id: string;
  kind: WalletActionKind;
  to: string;
  data: string;
  /** Native value in wei, decimal string. */
  value: string;
  status: WalletActionStatus;
  txHash: string | null;
  /** Failure or policy-denial reason (Privy's own message when Privy refused). */
  error: string | null;
  /** Human summary, e.g. "Approve 100 AUSD to the Perpl Exchange". */
  description: string;
  /** True when the simulated dev wallet produced the result. */
  simulated: boolean;
  createdAt: number;
}

export interface PolicyDemoResponse {
  /** True when the transaction was refused by the policy (the expected outcome). */
  blocked: boolean;
  action: WalletActionDTO;
  /** Who refused it: Privy's policy engine, or the local mirror in dev mode. */
  enforcedBy: "privy" | "local_policy_mirror" | null;
}
