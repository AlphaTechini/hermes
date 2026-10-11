import {
  type PolicyDemoRequest,
  type PolicyDemoResponse,
  type PolicySummaryDTO,
  type PrivyWalletDTO,
  type SignerConfigDTO,
  type WalletActionDTO,
  type WalletActionRequest,
} from "@hermes/shared";
import { formatUnits } from "viem";
import { demoWalletAddress } from "../auth/verifier";
import type { Config } from "../config";
import type { Db } from "../db/connection";
import type { Repos, UserRow } from "../db/repos";
import type { EventBus } from "../events/bus";
import { HermesError } from "../errors";
import { AUSD_DECIMALS, AmountRequiredError, buildPolicyDemoTx, buildWalletTx, type BuiltTx } from "./abi";
import { evaluatePolicy, specFromConfig, type HermesPolicySpec } from "./policy";
import { createWalletRepos, type PrivyWalletRow, type WalletActionRow, type WalletRepos } from "./repo";
import { PolicyDeniedError, type WalletService } from "./types";

export interface WalletModuleDeps {
  config: Config;
  db: Db;
  repos: Repos;
  bus: EventBus;
  service: WalletService;
  log?: { warn(o: unknown, m?: string): void; error(o: unknown, m?: string): void };
  /** How long POST /api/wallet/actions waits for the receipt before answering "submitted". */
  receiptWaitMs?: number;
  now?: () => number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    t.unref();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Orchestrates the Privy wallet features: signer registration, server-signed wallet actions (under the policy),
 * the policy-denial demo, persistence and SSE events. Works identically over the real and the dev wallet service.
 */
export class WalletModule {
  readonly spec: HermesPolicySpec;
  readonly walletRepos: WalletRepos;
  private readonly service: WalletService;
  private readonly abort = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly receiptWaitMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: WalletModuleDeps) {
    this.service = deps.service;
    this.spec = specFromConfig(deps.config.privyWallet);
    this.walletRepos = createWalletRepos(deps.db);
    this.receiptWaitMs = deps.receiptWaitMs ?? 8_000;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async close(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled([...this.inflight]);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    const done = () => this.inflight.delete(p);
    p.then(done, done);
    return p;
  }

  // --- DTO mapping ------------------------------------------------------------

  policySummary(): PolicySummaryDTO {
    return {
      chainId: this.spec.chainId,
      exchange: this.spec.exchange,
      collateralToken: this.spec.ausd,
      faucet: this.spec.faucet,
      approveCapAusd: formatUnits(this.spec.approveCapBase, AUSD_DECIMALS),
      expiresAt: this.spec.expiresAt,
    };
  }

  signerConfig(): SignerConfigDTO {
    return this.service.signerConfig(this.policySummary());
  }

  private walletDto(w: PrivyWalletRow): PrivyWalletDTO {
    return { walletId: w.walletId, address: w.address, signerAddedAt: w.signerAddedAt, policyId: w.policyId, simulated: w.simulated };
  }

  private actionDto(a: WalletActionRow): WalletActionDTO {
    return {
      id: a.id,
      kind: a.kind,
      to: a.toAddress,
      data: a.data,
      value: a.value,
      status: a.status,
      txHash: a.txHash,
      error: a.error,
      description: a.description,
      simulated: a.simulated,
      createdAt: a.createdAt,
    };
  }

  private publish(userId: string, row: WalletActionRow | undefined): WalletActionDTO {
    if (!row) throw new HermesError(500, "internal_error", "wallet action vanished");
    const dto = this.actionDto(row);
    this.deps.bus.publish(userId, { type: "wallet_action", action: dto });
    return dto;
  }

  // --- wallet / signer ---------------------------------------------------------

  getWallet(userId: string): PrivyWalletDTO | null {
    const w = this.walletRepos.wallets.get(userId);
    return w ? this.walletDto(w) : null;
  }

  /** The client says it added the Hermes signer; confirm with Privy, then persist. */
  async registerSigner(user: UserRow, address: string): Promise<PrivyWalletDTO> {
    const v = await this.service.verifySigner(user, address);
    if (!v.signerAdded) {
      throw new HermesError(409, "signer_not_found", "Privy does not list the Hermes signer on that wallet yet. Call addSigners() first and retry.");
    }
    const row = this.walletRepos.wallets.upsert({
      userId: user.id,
      walletId: v.walletId,
      address: v.address,
      signerAddedAt: this.walletRepos.wallets.get(user.id)?.signerAddedAt ?? Date.now(),
      policyId: v.policyId,
      simulated: this.service.simulated,
    });
    if (!user.walletAddress) this.deps.repos.users.setWallet(user.id, v.address);
    return this.walletDto(row);
  }

  private async requireWallet(user: UserRow): Promise<PrivyWalletRow> {
    const existing = this.walletRepos.wallets.get(user.id);
    if (existing?.signerAddedAt) return existing;
    if (this.service.mode === "dev") {
      // Dev convenience: there is no Privy to ask, so the simulated signer is registered on first use.
      await this.registerSigner(user, user.walletAddress ?? demoWalletAddress());
      return this.walletRepos.wallets.get(user.id) as PrivyWalletRow;
    }
    throw new HermesError(
      409,
      "signer_not_registered",
      "Add the Hermes signer to your wallet first (useSigners().addSigners) and call POST /api/privy/signer-registered.",
    );
  }

  // --- actions ---------------------------------------------------------------

  list(userId: string, limit: number): WalletActionDTO[] {
    return this.walletRepos.actions.list(userId, limit).map((a) => this.actionDto(a));
  }

  async runAction(user: UserRow, req: WalletActionRequest): Promise<WalletActionDTO> {
    const wallet = await this.requireWallet(user);
    let tx: BuiltTx;
    try {
      tx = buildWalletTx(
        req.kind,
        { ...this.deps.config.privyWallet, exchange: this.spec.exchange, ausd: this.spec.ausd, faucet: this.spec.faucet, walletAddress: wallet.address },
        req.amount,
      );
    } catch (err) {
      if (err instanceof AmountRequiredError) throw new HermesError(400, "validation_error", err.message);
      throw err;
    }

    // Pre-flight with the local mirror: obviously-forbidden requests never reach Privy.
    const pre = evaluatePolicy({ chainId: tx.chainId, to: tx.to, value: tx.value, data: tx.data }, this.spec, this.now());
    if (!pre.allowed) {
      const row = this.walletRepos.actions.insert({
        ...this.newRow(user.id, req.kind, tx, "denied_by_policy"),
        error: `Hermes pre-flight: ${pre.reason}`,
      });
      this.publish(user.id, row);
      throw new HermesError(422, "policy_denied", `Hermes pre-flight: ${pre.reason}`);
    }
    return this.execute(user, wallet, req.kind, tx);
  }

  /** Bounty proof: a transaction the policy MUST refuse. Skips the pre-flight so Privy itself does the refusing. */
  async policyDemo(user: UserRow, req: PolicyDemoRequest): Promise<PolicyDemoResponse> {
    const wallet = await this.requireWallet(user);
    const tx = buildPolicyDemoTx({ ausd: this.spec.ausd }, req.variant);
    const action = await this.execute(user, wallet, "policy_demo", tx);
    const blocked = action.status === "denied_by_policy";
    if (!blocked && action.status !== "failed") {
      this.deps.log?.error({ actionId: action.id }, "POLICY DEMO WAS NOT BLOCKED: check the Hermes policy rules in Privy");
    }
    return { blocked, action, enforcedBy: blocked ? this.service.enforcer : null };
  }

  private newRow(userId: string, kind: WalletActionRow["kind"], tx: BuiltTx, status: WalletActionRow["status"]) {
    return {
      userId,
      kind,
      toAddress: tx.to,
      data: tx.data,
      value: tx.value.toString(),
      description: tx.description,
      status,
      simulated: this.service.simulated,
    };
  }

  private async execute(user: UserRow, wallet: PrivyWalletRow, kind: WalletActionRow["kind"], tx: BuiltTx): Promise<WalletActionDTO> {
    const repo = this.walletRepos.actions;
    const row = repo.insert(this.newRow(user.id, kind, tx, "submitted"));
    this.publish(user.id, row);
    try {
      const { hash } = await this.service.send(wallet.walletId, tx);
      this.publish(user.id, repo.update(row.id, { txHash: hash }));
      const settle = this.track(
        this.service.waitForReceipt(hash, this.abort.signal).then((outcome) => {
          if (outcome === "timeout") return; // stays "submitted"
          this.publish(
            user.id,
            repo.update(row.id, outcome === "confirmed" ? { status: "confirmed" } : { status: "failed", error: "Transaction reverted on chain" }),
          );
        }),
      );
      await Promise.race([settle, sleep(this.receiptWaitMs, this.abort.signal)]);
    } catch (err) {
      if (err instanceof PolicyDeniedError) {
        this.publish(user.id, repo.update(row.id, { status: "denied_by_policy", error: err.reason }));
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.publish(user.id, repo.update(row.id, { status: "failed", error: message }));
        if (!(err instanceof HermesError)) this.deps.log?.warn({ err }, "wallet action failed");
      }
    }
    return this.actionDto(repo.get(row.id) as WalletActionRow);
  }
}
