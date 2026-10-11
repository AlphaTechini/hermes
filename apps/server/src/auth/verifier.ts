import { createHash } from "node:crypto";

/** Verifies a bearer token and returns the stable external identity (Privy DID). */
export interface AuthVerifier {
  verify(token: string): Promise<{ privyDid: string }>;
}

export class AuthError extends Error {
  constructor(message = "Invalid or expired token") {
    super(message);
    this.name = "AuthError";
  }
}

export const DEMO_PRIVY_DID = "did:privy:hermes-demo-user";
export const DEMO_USER_ID = "usr_demo";

/** Deterministic placeholder wallet for the dev demo user (not a real key). */
export function demoWalletAddress(): string {
  return `0x${createHash("sha256").update("hermes-demo-wallet").digest("hex").slice(0, 40)}`;
}

/** Dev mode: any request (token or not) is the fixed demo user. */
export class DevVerifier implements AuthVerifier {
  async verify(): Promise<{ privyDid: string }> {
    return { privyDid: DEMO_PRIVY_DID };
  }
}
