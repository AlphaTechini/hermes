import type { Config } from "../config";
import { decrypt } from "../crypto";
import type { Repos } from "../db/repos";

export interface PerplCredentials {
  accountId: string;
  apiKeyPublic: string;
  /** Decrypted trade-only Ed25519 private key. Keep in memory only. */
  apiKeyPrivate: string;
  /** Highest `rq` we ever used for this account; seed the next one from max(this, Perpl `lfr`). */
  lastRq: number;
}

/** For the Perpl client provider: load a user's stored credentials, or undefined if not connected. */
export function loadPerplCredentials(repos: Repos, config: Config, userId: string): PerplCredentials | undefined {
  const row = repos.connections.get(userId);
  if (!row) return undefined;
  return {
    accountId: row.accountId,
    apiKeyPublic: row.apiKeyPublic,
    apiKeyPrivate: decrypt(row.apiKeyPrivateEnc, config.masterKey),
    lastRq: row.lastRq,
  };
}
