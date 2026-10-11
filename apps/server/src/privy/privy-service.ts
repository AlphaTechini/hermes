import { createPrivateKey, createPublicKey } from "node:crypto";
import { MONAD_TESTNET_CAIP2, type PolicySummaryDTO, type SignerConfigDTO } from "@hermes/shared";
import type { PrivyClient } from "@privy-io/node";
import { createPublicClient, http } from "viem";
import { monadTestnet } from "viem/chains";
import type { Config } from "../config";
import { HermesError } from "../errors";
import type { TxRequest } from "./abi";
import { PolicyDeniedError, type ReceiptOutcome, type SignerVerification, type WalletService } from "./types";

/** The slice of {@link PrivyClient} Hermes uses; tests substitute a fake. */
export type PrivyLike = Pick<PrivyClient, "users" | "wallets" | "keyQuorums">;

const stripPrefix = (k: string) => k.trim().replace(/^wallet-auth:/, "");

/** Derive the base64 SPKI public key from a base64 PKCS8 P-256 private key (throws if it is not one). */
export function publicKeyOf(privateKeyBase64: string): string {
  const priv = createPrivateKey({ key: Buffer.from(stripPrefix(privateKeyBase64), "base64"), format: "der", type: "pkcs8" });
  if (priv.asymmetricKeyType !== "ec" || priv.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("PRIVY_AUTHORIZATION_PRIVATE_KEY must be a P-256 (prime256v1) key");
  }
  return createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64");
}

const errText = (err: unknown): string => {
  const e = err as { message?: string; error?: unknown };
  let body = "";
  if (e?.error !== undefined) {
    try {
      body = typeof e.error === "string" ? e.error : JSON.stringify(e.error);
    } catch {
      /* ignore */
    }
  }
  return [e?.message, body].filter(Boolean).join(" | ") || String(err);
};

/**
 * Decide whether a Privy API error is a policy refusal. UNVERIFIED against the live API (privy.md open uncertainty 4):
 * we treat a 4xx whose message/body mentions "polic" (policy / policy_violation) as a denial.
 */
export function classifyPrivyError(err: unknown): { denied: boolean; message: string } {
  const message = errText(err);
  const status = (err as { status?: number })?.status;
  const denied = typeof status === "number" && status >= 400 && status < 500 && /polic/i.test(message);
  return { denied, message };
}

export interface PrivyServiceOptions {
  config: Config;
  client: PrivyLike;
  /** Test seam: resolve a tx hash to an outcome. Defaults to polling the Monad RPC with viem. */
  receipt?: (hash: string) => Promise<ReceiptOutcome>;
  log?: { warn(o: unknown, m?: string): void; info(o: unknown, m?: string): void };
}

/** Real Privy: the Hermes server signs from the user's embedded wallet through its key quorum, under the policy. */
export class PrivyService implements WalletService {
  readonly mode = "privy" as const;
  readonly simulated = false;
  readonly enforcer = "privy" as const;
  private readonly cfg: Config["privyWallet"];
  private readonly authKey: string | undefined;
  private readonly publicClient;

  constructor(private readonly opts: PrivyServiceOptions) {
    this.cfg = opts.config.privyWallet;
    this.authKey = this.cfg.authorizationPrivateKey ? stripPrefix(this.cfg.authorizationPrivateKey) : undefined;
    if (this.authKey) publicKeyOf(this.authKey); // fail fast on a malformed key
    this.publicClient = createPublicClient({ chain: monadTestnet, transport: http(opts.config.monadRpcUrl) });
  }

  get configured(): boolean {
    return Boolean(this.authKey && this.cfg.keyQuorumId && this.cfg.policyId);
  }

  /** Best-effort boot check: the key we hold must be a member of the configured key quorum. Never throws. */
  async init(): Promise<void> {
    if (!this.configured) return;
    try {
      const quorum = await this.opts.client.keyQuorums().get(this.cfg.keyQuorumId as string);
      const mine = publicKeyOf(this.authKey as string);
      const norm = (s: string) => s.replace(/\s+/g, "");
      if (!quorum.authorization_keys.some((k) => norm(k.public_key) === norm(mine))) {
        this.opts.log?.warn({ keyQuorumId: this.cfg.keyQuorumId }, "PRIVY_AUTHORIZATION_PRIVATE_KEY is not a member of PRIVY_KEY_QUORUM_ID: Privy will reject signer requests");
      } else {
        this.opts.log?.info({ keyQuorumId: this.cfg.keyQuorumId }, "Privy server signer key verified against key quorum");
      }
    } catch (err) {
      this.opts.log?.warn({ err: errText(err) }, "could not verify the Privy key quorum at boot");
    }
  }

  private requireConfigured(): { authKey: string; keyQuorumId: string; policyId: string } {
    if (!this.authKey || !this.cfg.keyQuorumId || !this.cfg.policyId) {
      throw new HermesError(
        503,
        "privy_signer_not_configured",
        "The Hermes Privy signer is not configured. Run `pnpm --filter @hermes/server privy:bootstrap` and set PRIVY_AUTHORIZATION_PRIVATE_KEY, PRIVY_KEY_QUORUM_ID and PRIVY_POLICY_ID.",
      );
    }
    return { authKey: this.authKey, keyQuorumId: this.cfg.keyQuorumId, policyId: this.cfg.policyId };
  }

  signerConfig(policy: PolicySummaryDTO): SignerConfigDTO {
    return {
      mode: "privy",
      configured: this.configured,
      keyQuorumId: this.cfg.keyQuorumId ?? null,
      policyIds: this.cfg.policyId ? [this.cfg.policyId] : [],
      policy,
    };
  }

  async verifySigner(user: { privyDid: string }, address: string): Promise<SignerVerification> {
    const { keyQuorumId, policyId } = this.requireConfigured();
    const want = address.toLowerCase();

    // 1. The address must be an embedded Ethereum wallet of THIS Privy user (never trust the client's address).
    const privyUser = await this.opts.client.users()._get(user.privyDid);
    const owned = privyUser.linked_accounts.some(
      (a) => a.type === "wallet" && "chain_type" in a && a.chain_type === "ethereum" && a.address.toLowerCase() === want && "connector_type" in a && a.connector_type === "embedded",
    );
    if (!owned) throw new HermesError(403, "wallet_not_owned", "That address is not an embedded wallet of the signed-in user");

    // 2. The wallet must list the Hermes key quorum as an additional signer, restricted by the Hermes policy.
    const wallet = await this.opts.client.wallets().getWalletByAddress({ address });
    const signer = wallet.additional_signers.find((s) => s.signer_id === keyQuorumId);
    const overrides = signer?.override_policy_ids ?? [];
    const policyAttached = overrides.includes(policyId);
    if (signer && !policyAttached) {
      // A signer without our policy would be unrestricted: refuse to treat it as registered.
      throw new HermesError(409, "policy_not_attached", "The Hermes signer is on the wallet but without the Hermes policy. Remove it and add it again with the policy.");
    }
    return { walletId: wallet.id, address: wallet.address, signerAdded: Boolean(signer), policyId: policyAttached ? policyId : null };
  }

  async send(walletId: string, tx: TxRequest): Promise<{ hash: string }> {
    const { authKey } = this.requireConfigured();
    try {
      const res = await this.opts.client.wallets().ethereum().sendTransaction(walletId, {
        caip2: MONAD_TESTNET_CAIP2,
        params: {
          transaction: { to: tx.to, data: tx.data, value: `0x${tx.value.toString(16)}`, chain_id: tx.chainId },
        },
        authorization_context: { authorization_private_keys: [authKey] },
      });
      return { hash: res.hash };
    } catch (err) {
      const c = classifyPrivyError(err);
      if (c.denied) throw new PolicyDeniedError(c.message, "privy");
      throw new HermesError(502, "privy_error", `Privy refused or failed the request: ${c.message}`);
    }
  }

  async waitForReceipt(hash: string, signal: AbortSignal): Promise<ReceiptOutcome> {
    const poll = this.opts.receipt
      ? this.opts.receipt(hash)
      : this.publicClient
          .waitForTransactionReceipt({ hash: hash as `0x${string}`, timeout: 90_000 })
          .then((r): ReceiptOutcome => (r.status === "success" ? "confirmed" : "failed"))
          .catch((): ReceiptOutcome => "timeout");
    if (signal.aborted) return "timeout";
    return Promise.race([
      poll,
      new Promise<ReceiptOutcome>((resolve) => signal.addEventListener("abort", () => resolve("timeout"), { once: true })),
    ]);
  }
}
