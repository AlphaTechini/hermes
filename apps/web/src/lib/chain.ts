import { useQuery } from "@tanstack/react-query";
import { createPublicClient, http } from "viem";
import { monadTestnet } from "viem/chains";

/** Read-only viem client for Monad testnet (public RPC). */
export const publicClient = createPublicClient({ chain: monadTestnet, transport: http(undefined, { timeout: 4000, retryCount: 0 }) });

export interface HeadBlock {
  number: number;
  /** Block timestamp, epoch ms. */
  timestampMs: number;
}

/** Latest Monad testnet block, polled every 5 s while the tab is visible. Errors leave `data` undefined (show `n/a`). */
export function useHeadBlock() {
  return useQuery({
    queryKey: ["chain", "head"],
    queryFn: async (): Promise<HeadBlock> => {
      const b = await publicClient.getBlock({ blockTag: "latest" });
      return { number: Number(b.number), timestampMs: Number(b.timestamp) * 1000 };
    },
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 4000,
  });
}
