import { lazy, Suspense, type ReactNode } from "react";
import { DevAuthProvider } from "./dev-provider";

const PrivyAuthProvider = lazy(() => import("./privy-provider"));

/** Privy mode when VITE_PRIVY_APP_ID is set at build time, otherwise DEV mode. */
export const PRIVY_APP_ID: string = (import.meta.env.VITE_PRIVY_APP_ID ?? "").trim();
export const AUTH_MODE = PRIVY_APP_ID ? ("privy" as const) : ("dev" as const);

/**
 * Chooses the auth implementation at runtime. Both provide the same context, so `useAuth`, `useEmbeddedWallet` and
 * `useAddHermesSigner` behave identically for screens. Must sit inside QueryClientProvider.
 * The Privy SDK is a separate chunk and is not downloaded in DEV mode.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  if (!PRIVY_APP_ID) return <DevAuthProvider>{children}</DevAuthProvider>;
  return (
    <Suspense fallback={<div className="grid min-h-dvh place-items-center bg-canvas text-muted">Loading</div>}>
      <PrivyAuthProvider appId={PRIVY_APP_ID}>{children}</PrivyAuthProvider>
    </Suspense>
  );
}

export { useAuth, useAuthContext } from "./context";
export { useEmbeddedWallet, useAddHermesSigner } from "./hooks";
