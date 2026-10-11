import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PrivyWalletDTO, SignerConfigDTO } from "@hermes/shared";
import { get, post } from "../lib/api";
import { qk } from "../lib/queries";
import { useAuthContext } from "./context";

export { useAuth } from "./context";

/**
 * The user's embedded wallet.
 *
 *   const { address, ready, sendTransaction } = useEmbeddedWallet();
 *   const { hash } = await sendTransaction({ ...tx, devAction: { kind: "approve_collateral" } });
 *
 * Privy mode: `sendTransaction` is Privy's `useSendTransaction` (the user confirms in the Privy dialog, gas is
 * paid in MON, no sponsorship). DEV mode: it calls `POST /api/wallet/actions` with `tx.devAction` instead.
 */
export function useEmbeddedWallet() {
  return useAuthContext().wallet;
}

/**
 * Add the Hermes server as a restricted signer on the embedded wallet, then tell the server.
 * Privy: `GET /api/privy/signer-config` -> `useSigners().addSigners(...)` -> `POST /api/privy/signer-registered`.
 * DEV: only `POST /api/privy/signer-registered`. Resolves with the stored wallet.
 */
export function useAddHermesSigner() {
  const ctx = useAuthContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<PrivyWalletDTO> => {
      const address = ctx.wallet.address;
      if (!address) throw new Error("Your wallet is not ready yet.");
      if (ctx.mode === "privy") {
        const cfg = await qc.fetchQuery({ queryKey: qk.wallet.signerConfig, queryFn: () => get<SignerConfigDTO>("/api/privy/signer-config"), staleTime: 60_000 });
        if (!cfg.configured || !cfg.keyQuorumId) throw new Error("The Hermes server signer is not configured on the server.");
        try {
          await ctx.addSigners({ address, signers: [{ signerId: cfg.keyQuorumId, policyIds: cfg.policyIds }] });
        } catch (e) {
          // Re-adding an existing signer is fine: the server verifies the real state below.
          if (!/already/i.test(e instanceof Error ? e.message : String(e))) throw e;
        }
      }
      return post<PrivyWalletDTO>("/api/privy/signer-registered", { address });
    },
    onSuccess: (w) => qc.setQueryData(qk.wallet.privy, w),
  });
}
