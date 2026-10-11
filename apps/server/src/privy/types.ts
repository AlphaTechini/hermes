import type { PolicySummaryDTO, SignerConfigDTO } from "@hermes/shared";
import type { TxRequest } from "./abi";

/** A transaction the wallet policy refused. `source` says who enforced it. */
export class PolicyDeniedError extends Error {
  constructor(
    readonly reason: string,
    readonly source: "privy" | "local_policy_mirror",
  ) {
    super(reason);
    this.name = "PolicyDeniedError";
  }
}

export type ReceiptOutcome = "confirmed" | "failed" | "timeout";

export interface SignerVerification {
  walletId: string;
  address: string;
  /** The Hermes key quorum is an additional signer of the wallet, with the Hermes policy as its override. */
  signerAdded: boolean;
  policyId: string | null;
}

export interface WalletService {
  readonly mode: "privy" | "dev";
  /** True when results are simulated (no real chain / Privy). */
  readonly simulated: boolean;
  /** Who refuses a forbidden transaction. */
  readonly enforcer: "privy" | "local_policy_mirror";
  signerConfig(policy: PolicySummaryDTO): SignerConfigDTO;
  /** Confirm with Privy that `address` is the user's embedded wallet and that the Hermes signer + policy are attached. */
  verifySigner(user: { privyDid: string }, address: string): Promise<SignerVerification>;
  /** Sign and broadcast via the Hermes server signer. Throws {@link PolicyDeniedError} when the policy refuses. */
  send(walletId: string, tx: TxRequest): Promise<{ hash: string }>;
  waitForReceipt(hash: string, signal: AbortSignal): Promise<ReceiptOutcome>;
}
