import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatEther, formatUnits, getAddress, parseAbi } from "viem";
import type { PerplConnectionDTO, WalletActionDTO, WalletActionKind } from "@hermes/shared";
import { post } from "../../lib/api";
import { publicClient, useHeadBlock } from "../../lib/chain";
import { qk } from "../../lib/queries";
import { useStreamEvents } from "../../lib/stream";

const erc20 = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);
const AUSD_DECIMALS = 6;

/** Fallback when the signer config has not loaded: the AUSD token on Monad testnet (from the prototype). */
export const AUSD_FALLBACK = "0xa9012a055bd4e0edff8ce09f960291c09d5322dc";

export interface WalletBalances {
  /** MON, or null when the RPC did not answer. */
  mon: number | null;
  /** AUSD, or null when the RPC did not answer. */
  ausd: number | null;
}

/**
 * MON and AUSD balances of the embedded wallet, read with the viem public client. They are re-read when a new head block
 * arrives (the chain hook already tracks it) and when one of your wallet actions settles. Unreachable RPC gives `null`
 * values so the screen shows `n/a` instead of failing.
 */
export function useWalletBalances(address: string | null | undefined, ausdAddress: string | null | undefined) {
  const qc = useQueryClient();
  const head = useHeadBlock();
  const block = head.data?.number ?? null;

  useStreamEvents((e) => {
    if (e.type === "wallet_action" && e.action.status === "confirmed") void qc.invalidateQueries({ queryKey: ["wallet", "balances"] });
  });

  return useQuery({
    queryKey: ["wallet", "balances", address ?? "", ausdAddress ?? "", block],
    enabled: Boolean(address),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 10_000,
    queryFn: async (): Promise<WalletBalances> => {
      const owner = getAddress(address as string);
      const [mon, ausd] = await Promise.allSettled([
        publicClient.getBalance({ address: owner }),
        publicClient.readContract({ address: getAddress(ausdAddress ?? AUSD_FALLBACK), abi: erc20, functionName: "balanceOf", args: [owner] }),
      ]);
      return {
        mon: mon.status === "fulfilled" ? Number(formatEther(mon.value)) : null,
        ausd: ausd.status === "fulfilled" ? Number(formatUnits(ausd.value, AUSD_DECIMALS)) : null,
      };
    },
  });
}

/** `POST /api/perpl/sim/connect` (sim mode only): connects a funded simulated Perpl account. */
export function useSimConnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post<PerplConnectionDTO>("/api/perpl/sim/connect"),
    onSuccess: (c) => {
      qc.setQueryData(qk.perpl, c);
      void qc.invalidateQueries({ queryKey: qk.account });
      void qc.invalidateQueries({ queryKey: qk.positions });
    },
  });
}

/** Newest action of a kind (the list is newest first). */
export const latestAction = (actions: WalletActionDTO[] | undefined, kind: WalletActionKind): WalletActionDTO | undefined => actions?.find((a) => a.kind === kind);

export const PERPL_API_KEYS_URL = "https://testnet.perpl.xyz/apikeys";
export const MON_FAUCET_URL = "https://faucet.monad.xyz";
/** Minimum first deposit for a new Perpl account, in AUSD (set by Perpl). */
export const MIN_DEPOSIT_AUSD = 100;
