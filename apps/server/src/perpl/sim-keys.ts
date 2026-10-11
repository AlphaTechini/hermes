import { randomBytes } from "node:crypto";
import { Ed25519Signer } from "@hermes/perpl";

/** Starting balance of every simulated Perpl account, AUSD. */
export const SIM_START_BALANCE_AUSD = 10_000;

export interface SimCredentials {
  accountId: string;
  /** The `X-API-Key` token. */
  apiKeyPublic: string;
  /** Ed25519 seed, hex. */
  apiKeyPrivate: string;
}

/**
 * Brand new simulated API credentials: a fresh Ed25519 key pair and a made-up `X-API-Key` token. Nothing is enrolled
 * anywhere yet: the registry enrolls the public key with the in-process simulator when it connects, so the same
 * credentials keep working across server restarts (the simulator itself keeps no state on disk).
 */
export function generateSimCredentials(accountId: number): SimCredentials {
  const { seedHex } = Ed25519Signer.generate();
  return {
    accountId: String(accountId),
    apiKeyPublic: "pk_sim_" + randomBytes(12).toString("base64url"),
    apiKeyPrivate: seedHex,
  };
}
