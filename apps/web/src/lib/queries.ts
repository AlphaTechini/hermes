/**
 * react-query hooks for every Hermes endpoint, plus the central query keys.
 *
 * Rules for screen code:
 *  - Read with the `use*` query hooks, write with the `use*` mutation hooks. Mutations invalidate what they touch.
 *  - Live updates arrive through `lib/stream.ts`, which patches/invalidates the same keys. Never poll.
 *  - Query hooks are disabled until `useAuth().authenticated` is true.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  AccountSummary,
  AlertDetail,
  AlertListResponse,
  AlertRecord,
  AlertStatus,
  Approval,
  ApprovalStatus,
  CreateStrategyRequest,
  Fill,
  IngestResponse,
  LimitsResponse,
  MarketDTO,
  Order,
  PerplConnectionDTO,
  PolicyDemoRequest,
  PolicyDemoResponse,
  Position,
  PrivyWalletDTO,
  PutPerplConnectionRequest,
  RegisterWalletRequest,
  ReportCard,
  ReportRange,
  RiskLimits,
  SignerConfigDTO,
  SignerRegisteredRequest,
  StrategyDTO,
  StrategySecretDTO,
  TestAlertRequest,
  UpdateStrategyRequest,
  UserDTO,
  WalletActionDTO,
  WalletActionRequest,
} from "@hermes/shared";
import { useAuthEnabled } from "../auth/context";
import { del, get, patch, post, put } from "./api";

// --- keys ----------------------------------------------------------------------------

export interface AlertsParams {
  strategyId?: string;
  status?: AlertStatus;
  limit?: number;
}

/**
 * The server DTOs are still moving. A list endpoint that answers with `{ items: [...] }`, `null` or an error-shaped
 * object must never take a screen down with `x.reduce is not a function`: lists are normalised once, here, so the
 * query cache only ever holds arrays.
 */
export function asList<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  const items = (value as { items?: unknown } | null | undefined)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}

function asAlertList(value: unknown): AlertListResponse {
  const v = (value ?? {}) as Partial<AlertListResponse>;
  return { items: asList<AlertRecord>(value), nextCursor: typeof v.nextCursor === "string" ? v.nextCursor : null };
}

export const qk = {
  me: ["me"] as const,
  limits: ["limits"] as const,
  strategies: {
    all: ["strategies"] as const,
    list: ["strategies", "list"] as const,
    detail: (id: string) => ["strategies", "detail", id] as const,
  },
  alerts: {
    all: ["alerts"] as const,
    list: (p: AlertsParams = {}) => ["alerts", "list", p] as const,
    detail: (id: string) => ["alerts", "detail", id] as const,
  },
  orders: (limit?: number) => ["orders", limit ?? "default"] as const,
  fills: (limit?: number) => ["fills", limit ?? "default"] as const,
  positions: ["positions"] as const,
  markets: ["markets"] as const,
  account: ["account"] as const,
  approvals: {
    all: ["approvals"] as const,
    list: (status?: ApprovalStatus) => ["approvals", "list", status ?? "all"] as const,
  },
  perpl: ["perpl", "connection"] as const,
  reports: {
    all: ["reports"] as const,
    one: (strategyId: string, range: ReportRange) => ["reports", strategyId, range] as const,
  },
  wallet: {
    privy: ["wallet", "privy"] as const,
    actions: ["wallet", "actions"] as const,
    signerConfig: ["wallet", "signer-config"] as const,
  },
} as const;

// --- session -------------------------------------------------------------------------

export const useMe = () => {
  const enabled = useAuthEnabled();
  return useQuery({ queryKey: qk.me, queryFn: () => get<UserDTO>("/api/me"), enabled });
};

/** True when Perpl runs in the simulator: transaction hashes are not on any chain, so they must not link to the explorer. */
export const useSimulatedPerpl = (): boolean => useMe().data?.perplMode === "sim";

/** Store the embedded wallet address (and email) on the server user. */
export const useRegisterWallet = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RegisterWalletRequest) => post<UserDTO>("/api/me/wallet", body),
    onSuccess: (u) => qc.setQueryData(qk.me, u),
  });
};

// --- limits --------------------------------------------------------------------------

export const useLimits = () => {
  const enabled = useAuthEnabled();
  return useQuery({ queryKey: qk.limits, queryFn: () => get<LimitsResponse>("/api/limits"), enabled });
};

export const useUpdateLimits = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (limits: RiskLimits) => put<LimitsResponse>("/api/limits", limits),
    onSuccess: (l) => {
      qc.setQueryData(qk.limits, l);
    },
  });
};

/** Convenience for the Trading master toggle: PUT the current limits with `paused` flipped. */
export const useSetPaused = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (paused: boolean) => {
      const current = qc.getQueryData<LimitsResponse>(qk.limits) ?? (await get<LimitsResponse>("/api/limits"));
      return put<LimitsResponse>("/api/limits", { ...current, paused });
    },
    onMutate: async (paused) => {
      await qc.cancelQueries({ queryKey: qk.limits });
      const prev = qc.getQueryData<LimitsResponse>(qk.limits);
      if (prev) qc.setQueryData(qk.limits, { ...prev, paused });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.limits, ctx.prev);
    },
    onSuccess: (l) => qc.setQueryData(qk.limits, l),
  });
};

// --- strategies ----------------------------------------------------------------------

export const useStrategies = () => {
  const enabled = useAuthEnabled();
  return useQuery({ queryKey: qk.strategies.list, queryFn: async () => asList<StrategyDTO>(await get<StrategyDTO[]>("/api/strategies")), enabled });
};

export const useStrategy = (id: string | undefined) => {
  const enabled = useAuthEnabled();
  return useQuery({
    queryKey: qk.strategies.detail(id ?? ""),
    queryFn: () => get<StrategyDTO>(`/api/strategies/${id}`),
    enabled: enabled && Boolean(id),
  });
};

/** Resolves with the plaintext secret once (`secret`, `templatesWithSecret`). */
export const useCreateStrategy = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateStrategyRequest) => post<StrategySecretDTO>("/api/strategies", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.strategies.all }),
  });
};

export const useUpdateStrategy = (id: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateStrategyRequest) => patch<StrategyDTO>(`/api/strategies/${id}`, body),
    onSuccess: (s) => {
      qc.setQueryData(qk.strategies.detail(id), s);
      qc.invalidateQueries({ queryKey: qk.strategies.list });
    },
  });
};

/** For list rows where the id is only known at call time (the enable toggle): `mutate({ id, patch })`. */
export const useToggleStrategy = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => patch<StrategyDTO>(`/api/strategies/${id}`, { enabled }),
    onMutate: async ({ id, enabled }) => {
      await qc.cancelQueries({ queryKey: qk.strategies.list });
      const prev = qc.getQueryData<StrategyDTO[]>(qk.strategies.list);
      if (prev) qc.setQueryData(qk.strategies.list, prev.map((s) => (s.id === id ? { ...s, enabled } : s)));
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.strategies.list, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.strategies.all }),
  });
};

export const useDeleteStrategy = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => del<{ ok: true }>(`/api/strategies/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.strategies.all }),
  });
};

/**
 * Reveals the real secret (`GET /api/strategies/:id/secret`). A mutation on purpose: the plaintext secret
 * never sits in the query cache. Keep the result in component state and drop it on unmount.
 */
export const useRevealSecret = () => useMutation({ mutationFn: (id: string) => get<StrategySecretDTO>(`/api/strategies/${id}/secret`) });

export const useRotateSecret = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post<StrategySecretDTO>(`/api/strategies/${id}/rotate-secret`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.strategies.all }),
  });
};

/** POSTs a real test alert through the whole pipeline. Resolves with `{ alertId, body }` (secret redacted). */
export const useSendTestAlert = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & TestAlertRequest) => post<IngestResponse>(`/api/strategies/${id}/test-alert`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.alerts.all }),
  });
};

// --- alerts --------------------------------------------------------------------------

export const useAlerts = (params: AlertsParams = {}) => {
  const enabled = useAuthEnabled();
  return useQuery({
    queryKey: qk.alerts.list(params),
    queryFn: async () => asAlertList(await get<AlertListResponse>("/api/alerts", { strategyId: params.strategyId, status: params.status, limit: params.limit ?? 50 })),
    enabled,
  });
};

/** Cursor pagination for "View all": `data.pages.flatMap(p => p.items)`, `fetchNextPage()`. */
export const useAlertsInfinite = (params: AlertsParams = {}) => {
  const enabled = useAuthEnabled();
  return useInfiniteQuery({
    queryKey: [...qk.alerts.list(params), "infinite"] as const,
    queryFn: async ({ pageParam }) =>
      asAlertList(await get<AlertListResponse>("/api/alerts", { strategyId: params.strategyId, status: params.status, limit: params.limit ?? 50, cursor: pageParam })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
};

export const useAlert = (id: string | undefined) => {
  const enabled = useAuthEnabled();
  return useQuery({
    queryKey: qk.alerts.detail(id ?? ""),
    queryFn: () => get<AlertDetail>(`/api/alerts/${id}`),
    enabled: enabled && Boolean(id),
  });
};

// --- orders, fills, positions, account ------------------------------------------------

export const useOrders = (limit = 100) => {
  const enabled = useAuthEnabled();
  return useQuery({ queryKey: qk.orders(limit), queryFn: async () => asList<Order>(await get<Order[]>("/api/orders", { limit })), enabled });
};

export const useFills = (limit = 100) => {
  const enabled = useAuthEnabled();
  return useQuery({ queryKey: qk.fills(limit), queryFn: async () => asList<Fill>(await get<Fill[]>("/api/fills", { limit })), enabled });
};

export const usePositions = () => {
  const enabled = useAuthEnabled();
  return useQuery({ queryKey: qk.positions, queryFn: async () => asList<Position>(await get<Position[]>("/api/positions")), enabled });
};

/**
 * Perpl markets with their current mark price (`GET /api/markets`). A mark is a market value: it does not depend on
 * holding a position. `markPrice` is null only when Perpl has no price right now. Marks are not on the stream, so this
 * refetches every 5 s while a screen that shows one is mounted.
 */
export const useMarkets = () => {
  const enabled = useAuthEnabled();
  return useQuery({
    queryKey: qk.markets,
    queryFn: async () => asList<MarketDTO>(await get<MarketDTO[]>("/api/markets")),
    enabled,
    staleTime: 4_000,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
};

export const useAccount = () => {
  const enabled = useAuthEnabled();
  return useQuery({ queryKey: qk.account, queryFn: () => get<AccountSummary>("/api/account"), enabled });
};

// --- approvals -----------------------------------------------------------------------

export const useApprovals = (status?: ApprovalStatus) => {
  const enabled = useAuthEnabled();
  return useQuery({
    queryKey: qk.approvals.list(status),
    queryFn: async () => asList<Approval>(await get<Approval[]>("/api/approvals", { status })),
    enabled,
  });
};

/** Number of pending approvals (sidebar badge). Shares the cache of `useApprovals("pending")`. */
export const usePendingApprovalCount = (): number => useApprovals("pending").data?.length ?? 0;

export const useApprove = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post<Approval>(`/api/approvals/${id}/approve`),
    onSuccess: () => invalidateAfterDecision(qc),
  });
};

export const useReject = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post<Approval>(`/api/approvals/${id}/reject`),
    onSuccess: () => invalidateAfterDecision(qc),
  });
};

function invalidateAfterDecision(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: qk.approvals.all });
  qc.invalidateQueries({ queryKey: qk.alerts.all });
}

// --- Perpl connection ----------------------------------------------------------------

export const usePerplConnection = () => {
  const enabled = useAuthEnabled();
  return useQuery({ queryKey: qk.perpl, queryFn: () => get<PerplConnectionDTO>("/api/perpl/connection"), enabled });
};

export const usePutPerplConnection = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PutPerplConnectionRequest) => put<PerplConnectionDTO>("/api/perpl/connection", body),
    onSuccess: (c) => {
      qc.setQueryData(qk.perpl, c);
      qc.invalidateQueries({ queryKey: qk.account });
    },
  });
};

export const useDeletePerplConnection = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => del<PerplConnectionDTO>("/api/perpl/connection"),
    onSuccess: (c) => {
      qc.setQueryData(qk.perpl, c);
      qc.invalidateQueries({ queryKey: qk.account });
    },
  });
};

// --- reports -------------------------------------------------------------------------

export const useReport = (strategyId: string | undefined, range: ReportRange = "30d") => {
  const enabled = useAuthEnabled();
  return useQuery({
    queryKey: qk.reports.one(strategyId ?? "", range),
    queryFn: () => get<ReportCard>(`/api/reports/${strategyId}`, { range }),
    enabled: enabled && Boolean(strategyId),
  });
};

// --- Privy wallet --------------------------------------------------------------------

export const useSignerConfig = () => {
  const enabled = useAuthEnabled();
  return useQuery({ queryKey: qk.wallet.signerConfig, queryFn: () => get<SignerConfigDTO>("/api/privy/signer-config"), enabled, staleTime: 5 * 60_000 });
};

/** Stored Privy wallet and signer status, or `null` before the wallet is registered. */
export const usePrivyWallet = () => {
  const enabled = useAuthEnabled();
  return useQuery({ queryKey: qk.wallet.privy, queryFn: () => get<PrivyWalletDTO | null>("/api/privy/wallet"), enabled });
};

export const useSignerRegistered = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SignerRegisteredRequest) => post<PrivyWalletDTO>("/api/privy/signer-registered", body),
    onSuccess: (w) => qc.setQueryData(qk.wallet.privy, w),
  });
};

export const useWalletActions = (limit = 50) => {
  const enabled = useAuthEnabled();
  return useQuery({ queryKey: qk.wallet.actions, queryFn: async () => asList<WalletActionDTO>(await get<WalletActionDTO[]>("/api/wallet/actions", { limit })), enabled });
};

/** Server-signed wallet action under the Privy policy (approve_collateral, create_account, allow_forwarding, deposit, faucet). */
export const useRunWalletAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: WalletActionRequest) => post<WalletActionDTO>("/api/wallet/actions", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.wallet.actions }),
  });
};

/** Sends a deliberately forbidden transaction; the policy must refuse it. */
export const usePolicyDemo = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PolicyDemoRequest = { variant: "native_transfer" }) => post<PolicyDemoResponse>("/api/wallet/policy-demo", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.wallet.actions }),
  });
};
