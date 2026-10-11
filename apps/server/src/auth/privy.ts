import { PrivyClient } from "@privy-io/node";
import { AuthError, type AuthVerifier } from "./verifier";

/**
 * Privy access-token verification using `@privy-io/node` (the successor of the now-deprecated
 * `@privy-io/server-auth`; its `verifyAuthToken` is replaced by `client.utils().auth().verifyAccessToken`).
 * `claims.user_id` is the Privy DID ("did:privy:...").
 */
export class PrivyVerifier implements AuthVerifier {
  private readonly client: PrivyClient;

  constructor(appId: string, appSecret: string) {
    this.client = new PrivyClient({ appId, appSecret });
  }

  async verify(token: string): Promise<{ privyDid: string }> {
    try {
      const claims = await this.client.utils().auth().verifyAccessToken(token);
      return { privyDid: claims.user_id };
    } catch {
      throw new AuthError();
    }
  }
}
