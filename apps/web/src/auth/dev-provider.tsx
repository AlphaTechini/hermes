import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UserDTO, WalletActionDTO, WalletActionRequest } from "@hermes/shared";
import { get, post, setAccessTokenGetter } from "../lib/api";
import { qk } from "../lib/queries";
import { AuthContext, type AuthContextValue, type WalletTx } from "./context";

const KEY = "hermes-dev-session";

function readFlag(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * DEV mode (no VITE_PRIVY_APP_ID). The server runs with AUTH_MODE=dev and treats every request as the demo user, so
 * "signing in" is only a local flag that unlocks the app. No token is sent.
 */
export function DevAuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [authenticated, setAuthenticated] = useState<boolean>(readFlag);
  setAccessTokenGetter(null);

  const me = useQuery({ queryKey: qk.me, queryFn: () => get<UserDTO>("/api/me"), enabled: authenticated });

  const login = useCallback(() => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* session just will not survive a reload */
    }
    setAuthenticated(true);
  }, []);

  const logout = useCallback(async () => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    setAuthenticated(false);
    qc.clear();
  }, [qc]);

  const address = me.data?.walletAddress ?? null;

  const sendTransaction = useCallback(async (tx: WalletTx) => {
    const req: WalletActionRequest | undefined = tx.devAction;
    if (!req) throw new Error("DEV mode has no browser wallet. Pass `devAction` ({ kind, amount }) so the server runs the action.");
    const action = await post<WalletActionDTO>("/api/wallet/actions", req);
    void qc.invalidateQueries({ queryKey: qk.wallet.actions });
    if (action.status === "denied_by_policy" || action.status === "failed") throw new Error(action.error ?? "The wallet action failed.");
    return { hash: action.txHash ?? "", actionId: action.id };
  }, [qc]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ready: true,
      authenticated,
      user: authenticated ? { email: me.data?.email ?? null, walletAddress: address } : null,
      login,
      logout,
      mode: "dev",
      wallet: { address: authenticated ? address : null, ready: authenticated && Boolean(address), sendTransaction },
      addSigners: async () => {},
    }),
    [authenticated, me.data?.email, address, login, logout, sendTransaction],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
