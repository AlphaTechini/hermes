import { createContext, useContext } from "react";
import type { WalletActionRequest } from "@hermes/shared";

export type AuthMode = "privy" | "dev";

export interface AuthUser {
  email: string | null;
  walletAddress: string | null;
}

/**
 * A transaction for the user's embedded wallet. In Privy mode the wallet signs it in the browser
 * (`useSendTransaction`). In DEV mode there is no browser wallet, so `devAction` tells the server which
 * wallet action to run instead (`POST /api/wallet/actions`); the raw fields are ignored.
 */
export interface WalletTx {
  to?: `0x${string}`;
  data?: `0x${string}`;
  value?: bigint | number | `0x${string}`;
  chainId?: number;
  /** Shown in the Privy confirmation dialog. */
  description?: string;
  /** DEV mode only. Required there, ignored with Privy. */
  devAction?: WalletActionRequest;
}

export interface WalletTxResult {
  hash: string;
  /** DEV mode: the server's simulated or real wallet action id. */
  actionId?: string;
}

/** EIP-712 payload without `EIP712Domain` in `types` (the server prepares it). */
export interface TypedDataInput {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface AuthContextValue {
  ready: boolean;
  authenticated: boolean;
  user: AuthUser | null;
  login: () => void;
  logout: () => Promise<void>;
  mode: AuthMode;
  wallet: {
    address: string | null;
    ready: boolean;
    sendTransaction: (tx: WalletTx) => Promise<WalletTxResult>;
    /** EIP-712 signature from the embedded wallet. DEV mode has no wallet and rejects. */
    signTypedData: (typedData: TypedDataInput) => Promise<string>;
  };
  /** Privy `useSigners().addSigners`; DEV mode resolves without doing anything. */
  addSigners: (args: { address: string; signers: { signerId: string; policyIds: string[] }[] }) => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuthContext(): AuthContextValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth must be used inside <AuthProvider>");
  return v;
}

/** `{ ready, authenticated, user: { email, walletAddress }, login, logout, mode }` */
export function useAuth() {
  const { ready, authenticated, user, login, logout, mode } = useAuthContext();
  return { ready, authenticated, user, login, logout, mode };
}

/** True when API queries may run (signed in). Used by every query hook. */
export function useAuthEnabled(): boolean {
  const v = useContext(AuthContext);
  return Boolean(v?.ready && v.authenticated);
}
