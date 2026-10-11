import {
  KeyParseError,
  PerplAuthError,
  PerplGeoBlockedError,
  PerplHttpError,
  PerplNetworkError,
  PerplSocketError,
} from "@hermes/perpl";
import type { PerplContextDTO, PerplHealthDTO } from "@hermes/shared";
import { HermesError } from "../errors";
import type { PerplClientProvider } from "./types";

/** A user's stored (or about to be stored) Perpl API credentials, decrypted. In memory only. */
export interface PerplCredentialsInput {
  accountId: string;
  apiKeyPublic: string;
  apiKeyPrivate: string;
}

/**
 * What the HTTP layer needs beyond {@link PerplClientProvider}: link health for the connection DTO / TopBar, key
 * validation before a PUT is saved, and the simulator one-click connect. All optional so a plain test provider works.
 */
export interface PerplRuntime extends PerplClientProvider {
  /** Current link health, or undefined when the user has no stored connection. */
  health?(userId: string): PerplHealthDTO | undefined;
  /**
   * Connect with the given credentials and make sure the account is usable. Throws {@link HermesError} with a clear
   * code when it is not, and saves nothing. On success the connected client is kept for the next `refresh(userId)`.
   */
  validate?(userId: string, creds: PerplCredentialsInput): Promise<void>;
  /** Simulator only: generate a key pair, enroll it, create a funded account and return it ready to be saved. */
  provisionSim?(userId: string): PerplCredentialsInput & { collateralUsd: number };
  /** Perpl's `pub/context` (the simulator's in sim mode) for onboarding. */
  context?(): Promise<PerplContextDTO>;
  /** Find the account id of an API key (and wallet) when the user did not enter one. Throws `perpl_account_not_found`. */
  lookupAccount?(userId: string, key: { apiKeyPublic: string; apiKeyPrivate: string }, walletAddress: string | null): Promise<string>;
}

export type PerplErrorCode =
  | "perpl_invalid_key_format"
  | "perpl_key_rejected"
  | "perpl_geo_blocked"
  | "perpl_account_not_found"
  | "perpl_forwarding_disabled"
  | "perpl_unreachable"
  | "perpl_timeout"
  | "perpl_error";

export interface ClassifiedPerplError {
  code: PerplErrorCode;
  /** HTTP status to use when this fails a PUT /api/perpl/connection. */
  httpStatus: number;
  message: string;
  /** A retry cannot help until the user changes something. */
  permanent: boolean;
}

/** Turn whatever the Perpl client threw into a stable code and a sentence a user can act on. */
export function classifyPerplError(err: unknown): ClassifiedPerplError {
  if (err instanceof HermesError) {
    return { code: err.code as PerplErrorCode, httpStatus: err.status, message: err.message, permanent: true };
  }
  if (err instanceof KeyParseError) {
    return {
      code: "perpl_invalid_key_format",
      httpStatus: 400,
      message: `The API secret is not a valid Ed25519 private key (${err.message}). Paste the key exactly as Perpl shows it.`,
      permanent: true,
    };
  }
  if (err instanceof PerplGeoBlockedError) {
    return {
      code: "perpl_geo_blocked",
      httpStatus: 451,
      message:
        "Perpl answered HTTP 451: this server's region or IP is geo-blocked by Perpl. Run the Hermes backend in an allowed region (for example an EU one).",
      permanent: false,
    };
  }
  if (err instanceof PerplSocketError && (err.code === 3401 || /3401|sign-in/i.test(err.message))) {
    return {
      code: "perpl_key_rejected",
      httpStatus: 400,
      message: "Perpl rejected the API key (sign-in failed with 3401). Check the key and the secret, and that the key has not been revoked.",
      permanent: true,
    };
  }
  if (err instanceof PerplHttpError) {
    if (err.status === 401 || err.status === 403) {
      return { code: "perpl_key_rejected", httpStatus: 400, message: `Perpl rejected the API key (HTTP ${err.status}).`, permanent: true };
    }
    if (err.status === 404) {
      return {
        code: "perpl_account_not_found",
        httpStatus: 400,
        message: "Perpl has no exchange account for this wallet yet. Create the account (approve, createAccount) before connecting.",
        permanent: true,
      };
    }
    return { code: "perpl_error", httpStatus: 502, message: `Perpl answered HTTP ${err.status}: ${err.message}`, permanent: false };
  }
  if (err instanceof PerplNetworkError) {
    return { code: "perpl_unreachable", httpStatus: 502, message: `Could not reach Perpl: ${err.message}`, permanent: false };
  }
  if (err instanceof PerplAuthError) {
    return { code: "perpl_key_rejected", httpStatus: 400, message: err.message, permanent: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/timed? ?out/i.test(message)) {
    return { code: "perpl_timeout", httpStatus: 504, message: `Perpl did not answer in time: ${message}`, permanent: false };
  }
  return { code: "perpl_error", httpStatus: 502, message: `Could not connect to Perpl: ${message}`, permanent: false };
}

export function toHermesError(c: ClassifiedPerplError): HermesError {
  return new HermesError(c.httpStatus, c.code, c.message);
}
