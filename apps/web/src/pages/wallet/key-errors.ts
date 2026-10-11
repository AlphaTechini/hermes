import { errorMessage, isApiError } from "../../lib/api";

/** Server error codes of `PUT /api/perpl/connection` that have their own copy. */
export const KEY_ERROR_CODES = [
  "perpl_invalid_key_format",
  "perpl_key_rejected",
  "perpl_account_not_found",
  "perpl_forwarding_disabled",
  "perpl_geo_blocked",
  "perpl_unreachable",
  "perpl_timeout",
  "perpl_account_frozen",
] as const;
export type KeyErrorCode = (typeof KEY_ERROR_CODES)[number];

export interface KeyErrorCopy {
  /** The code from the server, or "" when the failure had none. */
  code: string;
  /** What happened. One sentence. */
  title: string;
  /** What to do next. */
  body: string;
  tone: "negative" | "warning";
  /** The one control the callout may offer. */
  action?: "allow_forwarding" | "back_to_account";
  /** Which form field the failure points at. */
  field?: "privateKey" | "keyId" | "accountId";
  /** The Advanced account ID field should be open so the trader can fix it. */
  openAccountId?: boolean;
}

/**
 * Plain-language copy for each failure of the key step: what happened first, then what to do (DESIGN 12). The server's
 * own sentence is for logs and support, so it is not shown for the codes below, except as the last-resort fallback.
 * `accountSupplied` is true when the trader typed an account ID (changes what "account not found" means).
 */
export function describeKeyError(error: unknown, opts: { accountSupplied?: boolean } = {}): KeyErrorCopy {
  const code = isApiError(error) ? error.code : "";
  switch (code) {
    case "perpl_invalid_key_format":
      return {
        code,
        title: "That private key is not in the right format.",
        body: "Copy it again from Perpl exactly as shown, with no spaces or line breaks, and paste it into the private key field.",
        tone: "negative",
        field: "privateKey",
      };
    case "perpl_key_rejected":
      return {
        code,
        title: "Perpl rejected this key.",
        body: "Check that you pasted both the key ID and the private key from the same key, and that it has not expired or been revoked. If you are unsure, create a new key with the Trade scope.",
        tone: "negative",
      };
    case "perpl_account_not_found":
      return opts.accountSupplied
        ? {
            code,
            title: "Perpl has no account with that ID for this key.",
            body: "Check the number in Advanced: account ID, or clear it and Hermes will look the account up from your wallet.",
            tone: "negative",
            field: "accountId",
            openAccountId: true,
          }
        : {
            code,
            title: "Hermes could not find a Perpl account for this wallet.",
            body: "Open your Perpl account first, then verify the key again. If you already have one, enter its number under Advanced: account ID.",
            tone: "negative",
            action: "back_to_account",
            openAccountId: true,
          };
    case "perpl_forwarding_disabled":
      return {
        code,
        title: "Order forwarding is off on your Perpl account.",
        body: "A trade-only key cannot place orders until it is on. Turn it on with a transaction from your wallet, then verify the key again.",
        tone: "warning",
        action: "allow_forwarding",
      };
    case "perpl_account_frozen":
      return {
        code,
        title: "Your Perpl account is frozen.",
        body: "Perpl does not accept orders for a frozen account. Contact Perpl support, then verify the key again.",
        tone: "negative",
      };
    case "perpl_geo_blocked":
      return {
        code,
        title: "Perpl is not available from where Hermes runs.",
        body: "Perpl blocks some regions, and this is not a problem with your key. Run the Hermes server in a region Perpl allows, then try again.",
        tone: "warning",
      };
    case "perpl_unreachable":
      return {
        code,
        title: "Hermes could not reach Perpl.",
        body: "Your key was not saved. This is usually brief, so try again in a minute.",
        tone: "negative",
      };
    case "perpl_timeout":
      return {
        code,
        title: "Perpl did not answer in time.",
        body: "Your key was not saved. Try again. If it keeps happening, Perpl may be slow right now.",
        tone: "negative",
      };
    default: {
      const msg = errorMessage(error).trim();
      return {
        code,
        title: "Could not verify this key.",
        body: `${/[.!?]$/.test(msg) ? msg : `${msg}.`} Your key was not saved.`,
        tone: "negative",
      };
    }
  }
}
