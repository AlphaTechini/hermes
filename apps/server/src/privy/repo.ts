import { randomUUID } from "node:crypto";
import type { WalletActionKind, WalletActionStatus } from "@hermes/shared";
import type { Db } from "../db/connection";

export interface PrivyWalletRow {
  userId: string;
  walletId: string;
  address: string;
  signerAddedAt: number | null;
  policyId: string | null;
  simulated: boolean;
  createdAt: number;
}

export interface WalletActionRow {
  id: string;
  userId: string;
  kind: WalletActionKind;
  toAddress: string;
  data: string;
  /** Wei, decimal string. */
  value: string;
  description: string;
  status: WalletActionStatus;
  txHash: string | null;
  error: string | null;
  simulated: boolean;
  createdAt: number;
}

type Raw = Record<string, unknown>;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const toWallet = (r: Raw): PrivyWalletRow => ({
  userId: String(r.user_id),
  walletId: String(r.wallet_id),
  address: String(r.address),
  signerAddedAt: r.signer_added_at === null ? null : Number(r.signer_added_at),
  policyId: str(r.policy_id),
  simulated: Number(r.simulated) === 1,
  createdAt: Number(r.created_at),
});

const toAction = (r: Raw): WalletActionRow => ({
  id: String(r.id),
  userId: String(r.user_id),
  kind: String(r.kind) as WalletActionKind,
  toAddress: String(r.to_address),
  data: String(r.data),
  value: String(r.value),
  description: String(r.description),
  status: String(r.status) as WalletActionStatus,
  txHash: str(r.tx_hash),
  error: str(r.error),
  simulated: Number(r.simulated) === 1,
  createdAt: Number(r.created_at),
});

export function createWalletRepos(db: Db) {
  const qGetWallet = db.prepare("SELECT * FROM privy_wallets WHERE user_id = ?");
  const qUpsertWallet = db.prepare(`
    INSERT INTO privy_wallets (user_id, wallet_id, address, signer_added_at, policy_id, simulated, created_at)
    VALUES (@user_id, @wallet_id, @address, @signer_added_at, @policy_id, @simulated, @created_at)
    ON CONFLICT(user_id) DO UPDATE SET wallet_id = excluded.wallet_id, address = excluded.address,
      signer_added_at = excluded.signer_added_at, policy_id = excluded.policy_id, simulated = excluded.simulated`);
  const qInsertAction = db.prepare(`
    INSERT INTO wallet_actions (id, user_id, kind, to_address, data, value, description, status, tx_hash, error, simulated, created_at)
    VALUES (@id, @user_id, @kind, @to_address, @data, @value, @description, @status, @tx_hash, @error, @simulated, @created_at)`);
  const qGetAction = db.prepare("SELECT * FROM wallet_actions WHERE id = ?");
  const qListActions = db.prepare("SELECT * FROM wallet_actions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?");

  return {
    wallets: {
      get(userId: string): PrivyWalletRow | undefined {
        const r = qGetWallet.get(userId) as Raw | undefined;
        return r ? toWallet(r) : undefined;
      },
      upsert(w: Omit<PrivyWalletRow, "createdAt"> & { createdAt?: number }): PrivyWalletRow {
        qUpsertWallet.run({
          user_id: w.userId,
          wallet_id: w.walletId,
          address: w.address,
          signer_added_at: w.signerAddedAt,
          policy_id: w.policyId,
          simulated: w.simulated ? 1 : 0,
          created_at: w.createdAt ?? Date.now(),
        });
        return toWallet(qGetWallet.get(w.userId) as Raw);
      },
    },
    actions: {
      insert(a: Omit<WalletActionRow, "id" | "createdAt" | "txHash" | "error"> & Partial<Pick<WalletActionRow, "id" | "createdAt" | "txHash" | "error">>): WalletActionRow {
        const id = a.id ?? `wa_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        qInsertAction.run({
          id,
          user_id: a.userId,
          kind: a.kind,
          to_address: a.toAddress,
          data: a.data,
          value: a.value,
          description: a.description,
          status: a.status,
          tx_hash: a.txHash ?? null,
          error: a.error ?? null,
          simulated: a.simulated ? 1 : 0,
          created_at: a.createdAt ?? Date.now(),
        });
        return toAction(qGetAction.get(id) as Raw);
      },
      update(id: string, patch: { status?: WalletActionStatus; txHash?: string | null; error?: string | null }): WalletActionRow | undefined {
        const sets: string[] = [];
        const params: Record<string, unknown> = { id };
        if (patch.status !== undefined) {
          sets.push("status = @status");
          params.status = patch.status;
        }
        if (patch.txHash !== undefined) {
          sets.push("tx_hash = @tx_hash");
          params.tx_hash = patch.txHash;
        }
        if (patch.error !== undefined) {
          sets.push("error = @error");
          params.error = patch.error;
        }
        if (sets.length) db.prepare(`UPDATE wallet_actions SET ${sets.join(", ")} WHERE id = @id`).run(params);
        const r = qGetAction.get(id) as Raw | undefined;
        return r ? toAction(r) : undefined;
      },
      get(id: string): WalletActionRow | undefined {
        const r = qGetAction.get(id) as Raw | undefined;
        return r ? toAction(r) : undefined;
      },
      list(userId: string, limit: number): WalletActionRow[] {
        return (qListActions.all(userId, limit) as Raw[]).map(toAction);
      },
    },
  };
}

export type WalletRepos = ReturnType<typeof createWalletRepos>;
