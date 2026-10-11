/**
 * Live updates. `POST /api/stream-ticket`, then `EventSource GET /api/stream?ticket=...`.
 *
 * - Every StreamEvent patches or invalidates the react-query caches (see {@link applyStreamEvent}), so screens
 *   never poll: they read hooks from `lib/queries.ts` and re-render when the stream lands.
 * - Reconnects with a fresh ticket and exponential backoff (1 s up to 15 s, with jitter).
 * - `useStreamStatus()` drives the TopBar connection indicator; `useStreamEvents(cb)` lets a component react to
 *   raw events (toasts, value flashes).
 *
 * The shell calls `useStreamConnection()` once while authenticated. Screens do not need to.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { QueryClient, InfiniteData } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import type { AccountSummary, AlertDetail, AlertListResponse, AlertRecord, Approval, PerplConnectionDTO, PerplHealthDTO, PerplLinkStatus, StreamEvent, StreamTicket } from "@hermes/shared";
import { API_BASE, post } from "./api";
import { qk } from "./queries";

export type StreamState = "idle" | "connecting" | "live" | "reconnecting" | "offline";

export interface StreamStatus {
  state: StreamState;
  /** Consecutive failed connection attempts since the last `ready`. */
  attempt: number;
  /** Epoch ms of the last event or `ready`. */
  lastEventAt: number | null;
  /** Last Perpl link status pushed by the server (`perpl` event), if any. */
  perpl: PerplLinkStatus | null;
}

const EVENT_TYPES: StreamEvent["type"][] = ["ready", "alert", "order", "fill", "positions", "approval", "perpl", "perpl_status", "account", "wallet_action"];
/** After this many failed attempts the TopBar shows "Offline" (before that: "Reconnecting"). */
export const OFFLINE_AFTER_ATTEMPTS = 3;

// --- tiny store ----------------------------------------------------------------------

let status: StreamStatus = { state: "idle", attempt: 0, lastEventAt: null, perpl: null };
const statusListeners = new Set<() => void>();
function setStatus(patch: Partial<StreamStatus>) {
  status = { ...status, ...patch };
  statusListeners.forEach((l) => l());
}
const subscribeStatus = (cb: () => void) => {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
};

/** Connection state of the live stream. `state === "live"` once the server said `ready`. */
export function useStreamStatus(): StreamStatus {
  return useSyncExternalStore(subscribeStatus, () => status, () => status);
}

// Perpl link health (`perpl_status` events): connected, heartbeat age, latency, head block. Null until the first event.
let perplHealth: PerplHealthDTO | null = null;
const healthListeners = new Set<() => void>();
const subscribeHealth = (cb: () => void) => {
  healthListeners.add(cb);
  return () => healthListeners.delete(cb);
};
/** Latest `perpl_status` health pushed over the stream, or `null` before the first one. */
export function usePerplHealth(): PerplHealthDTO | null {
  return useSyncExternalStore(subscribeHealth, () => perplHealth, () => perplHealth);
}

const eventListeners = new Set<(e: StreamEvent) => void>();
/** Subscribe to every raw stream event (the callback may change between renders). */
export function useStreamEvents(cb: (e: StreamEvent) => void): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    const l = (e: StreamEvent) => ref.current(e);
    eventListeners.add(l);
    return () => void eventListeners.delete(l);
  }, []);
}

// --- cache updates -------------------------------------------------------------------

type AlertsData = AlertListResponse | InfiniteData<AlertListResponse>;

function matchesFilters(a: AlertRecord, key: readonly unknown[]): boolean {
  const p = (key[2] ?? {}) as { strategyId?: string; status?: string };
  if (p.strategyId && p.strategyId !== a.strategyId) return false;
  if (p.status && p.status !== a.status) return false;
  return true;
}

/** Replace in place when the row exists (rows never re-sort once rendered); otherwise add it at the top. */
function upsertAlert(data: AlertsData | undefined, alert: AlertRecord, key: readonly unknown[]): AlertsData | undefined {
  if (!data) return data;
  const upsertPage = (page: AlertListResponse, first: boolean): AlertListResponse => {
    const i = page.items.findIndex((x) => x.id === alert.id);
    if (i >= 0) {
      const items = page.items.slice();
      items[i] = alert;
      return { ...page, items };
    }
    if (first && matchesFilters(alert, key)) return { ...page, items: [alert, ...page.items] };
    return page;
  };
  if ("pages" in data) {
    const exists = data.pages.some((p) => p.items.some((x) => x.id === alert.id));
    return { ...data, pages: data.pages.map((p, idx) => upsertPage(p, idx === 0 && !exists)) };
  }
  return upsertPage(data, true);
}

const FILL_STATUSES = new Set(["filled", "partially_filled"]);

/** Exported for tests. Applies one server event to the query cache. */
export function applyStreamEvent(qc: QueryClient, ev: StreamEvent): void {
  switch (ev.type) {
    case "ready":
      return;
    case "alert": {
      const alert = ev.alert;
      for (const q of qc.getQueryCache().findAll({ queryKey: qk.alerts.all })) {
        if (q.queryKey[1] !== "list") continue;
        qc.setQueryData<AlertsData>(q.queryKey, (old) => upsertAlert(old, alert, q.queryKey));
        const p = (q.queryKey[2] ?? {}) as { status?: string };
        if (p.status) void qc.invalidateQueries({ queryKey: q.queryKey, exact: true });
      }
      qc.setQueryData<AlertDetail>(qk.alerts.detail(alert.id), (old) => (old ? { ...old, ...alert } : old));
      void qc.invalidateQueries({ queryKey: qk.strategies.list });
      if (alert.status === "pending_approval" || alert.status === "expired" || alert.status === "blocked") void qc.invalidateQueries({ queryKey: qk.approvals.all });
      if (FILL_STATUSES.has(alert.status)) {
        void qc.invalidateQueries({ queryKey: ["fills"] });
        void qc.invalidateQueries({ queryKey: qk.positions });
        void qc.invalidateQueries({ queryKey: qk.account });
        void qc.invalidateQueries({ queryKey: qk.reports.all });
      }
      return;
    }
    case "order":
      void qc.invalidateQueries({ queryKey: ["orders"] });
      if (ev.order.alertId) void qc.invalidateQueries({ queryKey: qk.alerts.detail(ev.order.alertId), exact: true });
      return;
    case "fill":
      void qc.invalidateQueries({ queryKey: ["fills"] });
      void qc.invalidateQueries({ queryKey: qk.positions });
      void qc.invalidateQueries({ queryKey: qk.account });
      if (ev.fill.alertId) void qc.invalidateQueries({ queryKey: qk.alerts.detail(ev.fill.alertId), exact: true });
      return;
    case "positions":
      qc.setQueryData(qk.positions, ev.positions);
      void qc.invalidateQueries({ queryKey: qk.account });
      return;
    case "approval": {
      const a: Approval = ev.approval;
      void qc.invalidateQueries({ queryKey: qk.approvals.all });
      qc.setQueryData<AlertDetail>(qk.alerts.detail(a.alertId), (old) => (old ? { ...old, approval: a } : old));
      return;
    }
    case "perpl":
      qc.setQueryData<PerplConnectionDTO>(qk.perpl, (old) => (old ? { ...old, status: ev.status } : old));
      void qc.invalidateQueries({ queryKey: qk.account });
      return;
    case "perpl_status":
      perplHealth = ev.health;
      healthListeners.forEach((l) => l());
      qc.setQueryData<PerplConnectionDTO>(qk.perpl, (old) => (old ? { ...old, status: ev.health.status, health: ev.health } : old));
      return;
    case "account":
      qc.setQueryData<AccountSummary>(qk.account, ev.account);
      return;
    case "wallet_action":
      void qc.invalidateQueries({ queryKey: qk.wallet.actions });
      return;
  }
}

// --- connection ----------------------------------------------------------------------

export interface StreamController {
  stop(): void;
}

export const backoffMs = (attempt: number, rand: () => number = Math.random): number => {
  const base = Math.min(15_000, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + rand() * 0.4));
};

/** Opens the stream and keeps it open until `stop()`. One controller per app. */
export function startStream(qc: QueryClient): StreamController {
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let everLive = false;

  const schedule = () => {
    if (stopped) return;
    const attempt = status.attempt + 1;
    setStatus({ attempt, state: attempt >= OFFLINE_AFTER_ATTEMPTS ? "offline" : "reconnecting" });
    timer = setTimeout(connect, backoffMs(attempt));
  };

  const connect = async () => {
    if (stopped) return;
    if (status.state === "idle") setStatus({ state: "connecting" });
    let ticket: StreamTicket;
    try {
      ticket = await post<StreamTicket>("/api/stream-ticket");
    } catch {
      schedule();
      return;
    }
    if (stopped) return;
    const source = new EventSource(`${API_BASE}/api/stream?ticket=${encodeURIComponent(ticket.ticket)}`);
    es = source;
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (m) => {
        let ev: StreamEvent;
        try {
          ev = JSON.parse((m as MessageEvent<string>).data) as StreamEvent;
        } catch {
          return;
        }
        if (ev.type === "ready") {
          const reconnected = everLive;
          everLive = true;
          setStatus({ state: "live", attempt: 0, lastEventAt: Date.now() });
          // Anything that happened while we were away: refetch what is on screen.
          if (reconnected) void qc.invalidateQueries();
        } else {
          setStatus({ lastEventAt: Date.now(), ...(ev.type === "perpl" ? { perpl: ev.status } : {}) });
        }
        applyStreamEvent(qc, ev);
        eventListeners.forEach((l) => l(ev));
      });
    }
    source.onerror = () => {
      // EventSource would retry with the same (possibly expired) ticket. Close and fetch a new one instead.
      source.close();
      if (es === source) es = null;
      schedule();
    };
  };

  void connect();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      es?.close();
      es = null;
      setStatus({ state: "idle", attempt: 0 });
    },
  };
}

/** Mount once (the AppShell does). Starts the stream when `enabled` and stops it on unmount or logout. */
export function useStreamConnection(enabled: boolean): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const c = startStream(qc);
    return () => c.stop();
  }, [enabled, qc]);
}
