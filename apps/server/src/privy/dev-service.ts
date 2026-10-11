import { createHash, randomBytes } from "node:crypto";
import type { PolicySummaryDTO, SignerConfigDTO } from "@hermes/shared";
import type { TxRequest } from "./abi";
import { evaluatePolicy, type HermesPolicySpec } from "./policy";
import { PolicyDeniedError, type ReceiptOutcome, type SignerVerification, type WalletService } from "./types";

export interface DevWalletOptions {
  spec: HermesPolicySpec;
  /** Simulated block time before a tx is "confirmed". */
  confirmDelayMs?: number;
  now?: () => number;
}

/**
 * AUTH_MODE=dev wallet: same interface as {@link PrivyService}, no network. Outcomes are simulated (fake tx hashes),
 * but the policy is evaluated for real by the local mirror, so a forbidden transaction is denied just like Privy would.
 */
export class DevWalletService implements WalletService {
  readonly mode = "dev" as const;
  readonly simulated = true;
  readonly enforcer = "local_policy_mirror" as const;
  private readonly confirmDelayMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: DevWalletOptions) {
    this.confirmDelayMs = opts.confirmDelayMs ?? 400;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  signerConfig(policy: PolicySummaryDTO): SignerConfigDTO {
    return { mode: "dev", configured: true, keyQuorumId: "dev-key-quorum", policyIds: ["dev-policy"], policy };
  }

  async verifySigner(_user: { privyDid: string }, address: string): Promise<SignerVerification> {
    const id = createHash("sha256").update(address.toLowerCase()).digest("hex").slice(0, 24);
    return { walletId: `dev_wallet_${id}`, address, signerAdded: true, policyId: "dev-policy" };
  }

  async send(_walletId: string, tx: TxRequest): Promise<{ hash: string }> {
    const d = evaluatePolicy({ chainId: tx.chainId, to: tx.to, value: tx.value, data: tx.data }, this.opts.spec, this.now());
    if (!d.allowed) {
      throw new PolicyDeniedError(`Simulated Privy policy engine refused the request: ${d.reason}`, "local_policy_mirror");
    }
    return { hash: `0x${randomBytes(32).toString("hex")}` };
  }

  waitForReceipt(_hash: string, signal: AbortSignal): Promise<ReceiptOutcome> {
    if (signal.aborted) return Promise.resolve("timeout");
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve("confirmed"), this.confirmDelayMs);
      t.unref();
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve("timeout");
        },
        { once: true },
      );
    });
  }
}
