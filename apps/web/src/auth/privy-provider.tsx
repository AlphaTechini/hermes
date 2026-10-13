import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { PrivyProvider, usePrivy, useSendTransaction, useSignTypedData, useSigners, useWallets } from "@privy-io/react-auth";
import { useQueryClient } from "@tanstack/react-query";
import { monadTestnet } from "viem/chains";
import type { UserDTO } from "@hermes/shared";
import { post, setAccessTokenGetter } from "../lib/api";
import { qk } from "../lib/queries";
import { useTheme } from "../lib/theme";
import { AuthContext, type AuthContextValue, type TypedDataInput, type WalletTx } from "./context";

// The Hermes mark (see MARK in design/prototype/prototype.js), as a data URI for the Privy dialog header.
const LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22"><rect width="22" height="22" rx="6" fill="#eceef0"/><path d="M6.5 5.75v10.5M12.25 5.75v10.5M6.5 11h9.25M13.5 8.25 16.25 11l-2.75 2.75" fill="none" stroke="#0b0c0e" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  );

/** Privy mode: email login, embedded Ethereum wallet created on login, Monad testnet. Lazy-loaded by AuthProvider. */
export default function PrivyAuthProvider({ appId, children }: { appId: string; children: ReactNode }) {
  const { theme } = useTheme();
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email"],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" }, showWalletUIs: true },
        supportedChains: [monadTestnet],
        defaultChain: monadTestnet,
        appearance: {
          theme,
          accentColor: theme === "dark" ? "#4d8eff" : "#2563eb",
          logo: LOGO,
          walletChainType: "ethereum-only",
        },
      }}
    >
      <PrivyBridge>{children}</PrivyBridge>
    </PrivyProvider>
  );
}

const toHex = (v: bigint | number | `0x${string}` | undefined): `0x${string}` | undefined =>
  v === undefined ? undefined : typeof v === "string" ? v : (`0x${BigInt(v).toString(16)}` as `0x${string}`);

function PrivyBridge({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { sendTransaction: privySend } = useSendTransaction();
  const { addSigners } = useSigners();
  const { signTypedData: privySignTypedData } = useSignTypedData();

  // Set during render (idempotent) so child effects that fire queries already have the token getter.
  setAccessTokenGetter(getAccessToken);

  const address = useMemo(() => {
    const embedded = wallets.find((w) => w.walletClientType === "privy");
    return embedded?.address ?? user?.wallet?.address ?? null;
  }, [wallets, user]);
  const email = user?.email?.address ?? null;

  // Tell the Hermes server about the wallet once, so it shows in /api/me.
  useEffect(() => {
    if (!authenticated || !address) return;
    let cancelled = false;
    post<UserDTO>("/api/me/wallet", { address, ...(email ? { email } : {}) })
      .then((u) => {
        if (!cancelled) qc.setQueryData(qk.me, u);
      })
      .catch(() => {
        /* non-fatal: retried on the next mount */
      });
    return () => {
      cancelled = true;
    };
  }, [authenticated, address, email, qc]);

  const doLogout = useCallback(async () => {
    await logout();
    qc.clear();
  }, [logout, qc]);

  const sendTransaction = useCallback(
    async (tx: WalletTx) => {
      if (!address) throw new Error("Your wallet is not ready yet.");
      const { hash } = await privySend(
        { to: tx.to, data: tx.data, value: toHex(tx.value), chainId: tx.chainId ?? monadTestnet.id },
        { address, uiOptions: { showWalletUIs: true, ...(tx.description ? { description: tx.description } : {}) } },
      );
      return { hash };
    },
    [address, privySend],
  );

  const signTypedData = useCallback(
    async (typedData: TypedDataInput) => {
      if (!address) throw new Error("Your wallet is not ready yet.");
      // Privy types `domain.salt` as ArrayBuffer; Perpl sends a 0x bytes32 string, which the signer accepts as is.
      const { signature } = await privySignTypedData(typedData as Parameters<typeof privySignTypedData>[0], {
        address,
        uiOptions: { title: "Create your Perpl API key", description: "Lets Hermes trade on your Perpl account. It can never withdraw." },
      });
      return signature;
    },
    [address, privySignTypedData],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      ready,
      authenticated,
      user: authenticated ? { email, walletAddress: address } : null,
      login: () => login(),
      logout: doLogout,
      mode: "privy",
      wallet: { address, ready: walletsReady && Boolean(address), sendTransaction, signTypedData },
      addSigners: async (args) => {
        await addSigners(args);
      },
    }),
    [ready, authenticated, email, address, login, doLogout, walletsReady, sendTransaction, signTypedData, addSigners],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
