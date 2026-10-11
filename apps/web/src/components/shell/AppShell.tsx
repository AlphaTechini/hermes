import { CirclePause, OctagonX, WifiOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useAuth, useAuthEnabled } from "../../auth/context";
import { alertOutcome, alertSide } from "../../lib/alert-view";
import { formatMs, formatPrice, formatUsd } from "../../lib/format";
import { useAccount, useLimits, usePerplConnection, useSetPaused } from "../../lib/queries";
import { useStreamConnection, useStreamEvents, useStreamStatus } from "../../lib/stream";
import { Banner } from "../ui/Feedback";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

/** Banners that affect every page: paused, loss stop reached, live updates lost, Perpl socket dropped, setup unfinished. */
function SystemBanners() {
  const enabled = useAuthEnabled();
  const limits = useLimits();
  const account = useAccount();
  const perpl = usePerplConnection();
  const stream = useStreamStatus();
  const setPaused = useSetPaused();
  const { mode } = useAuth();

  if (!enabled) return null;
  const l = limits.data;
  const a = account.data;
  const today = a ? a.realizedPnlTodayUsd + a.unrealizedPnlUsd : 0;
  const stopHit = Boolean(l && l.dailyLossStopUsd > 0 && -today >= l.dailyLossStopUsd);
  const p = perpl.data;

  return (
    <>
      {stream.state === "offline" && (
        <Banner tone="negative" icon={WifiOff}>
          <b>Live updates stopped.</b> Reconnecting.
        </Banner>
      )}
      {p?.configured && (p.status === "disconnected" || p.status === "reconnecting") && stream.state !== "offline" && (
        <Banner icon={WifiOff} action={<Link className="btn btn-ghost btn-sm" to="/wallet">Details</Link>}>
          <b>Perpl trading socket dropped.</b> Reconnecting. New alerts wait up to 10 s, then fail with a reason.
        </Banner>
      )}
      {l?.paused && (
        <Banner icon={CirclePause} action={<Button size="sm" variant="secondary" loading={setPaused.isPending} onClick={() => setPaused.mutate(false)}>Resume</Button>}>
          <b>Trading is paused.</b> Alerts are logged and blocked.
        </Banner>
      )}
      {stopHit && (
        <Banner icon={OctagonX}>
          <b>Daily loss stop reached.</b> New orders are blocked until 00:00 UTC. Closing orders still go through.
        </Banner>
      )}
      {p && !p.configured && (
        <Banner action={<Link className="btn btn-secondary btn-sm" to="/onboarding">{mode === "dev" ? "Continue setup" : "Finish setup"}</Link>}>
          <b>Finish setup.</b> Connect your Perpl account to start trading.
        </Banner>
      )}
    </>
  );
}

/** Fill, block and approval toasts. Only when the tab is not on Live, so they never duplicate the stream. */
function StreamToasts() {
  const toast = useToast();
  const { pathname } = useLocation();
  const path = useRef(pathname);
  path.current = pathname;
  const seen = useRef(new Set<string>());

  useStreamEvents((ev) => {
    if (ev.type === "alert") {
      const a = ev.alert;
      if (path.current.startsWith("/live")) return;
      const key = `${a.id}:${a.status}`;
      if (seen.current.has(key)) return;
      const out = alertOutcome(a);
      const side = alertSide(a);
      const sideWord = side === "long" ? "Long" : side === "short" ? "Short" : side === "close-long" ? "Close long" : side === "close-short" ? "Close short" : "Close";
      const what = `${sideWord} ${a.market ?? ""}`.trim();
      if (out.kind === "filled" || out.kind === "partly_filled") {
        seen.current.add(key);
        const fill = a.avgFillPrice !== null ? `${formatPrice(a.avgFillPrice, a.market)}` : "";
        toast.positive(`${out.kind === "filled" ? "Filled" : "Partly filled"} ${what}`, [fill, a.latencyMs !== null ? formatMs(a.latencyMs) : ""].filter(Boolean).join(" · "), {
          actions: [{ label: "View alert", to: `/alerts/${a.id}` }],
        });
      } else if (out.kind === "blocked") {
        seen.current.add(key);
        toast.warning(`Blocked ${what}`, out.why, { actions: [{ label: "View alert", to: `/alerts/${a.id}` }] });
      }
    } else if (ev.type === "approval" && ev.approval.status === "pending") {
      const ap = ev.approval;
      const key = `approval:${ap.id}`;
      if (seen.current.has(key)) return;
      seen.current.add(key);
      const side = ap.side === "short" ? "Short" : ap.side === "long" ? "Long" : "";
      const sec = Math.max(0, Math.round((ap.expiresAt - Date.now()) / 1000));
      toast.accent("Approval needed", `${side} ${ap.market ?? ""} · ${ap.notionalUsd !== null ? formatUsd(ap.notionalUsd, { summary: true }) : "n/a"} · expires in ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`, {
        actions: [{ label: "Review", to: "/approvals" }],
        duration: 8000,
      });
    }
  });
  return null;
}

/**
 * The authenticated frame: sidebar, sticky top bar, system banners, then the page (<Outlet />) in `main.content`
 * (max 1440, padding 24/24/48, 20 gap). Starts the live stream and the global toasts.
 */
export function AppShell() {
  const enabled = useAuthEnabled();
  const { pathname } = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const stream = useStreamStatus();
  useStreamConnection(enabled);

  useEffect(() => setNavOpen(false), [pathname]);
  useEffect(() => {
    document.body.classList.toggle("nav-open", navOpen);
    return () => document.body.classList.remove("nav-open");
  }, [navOpen]);
  const close = useCallback(() => setNavOpen(false), []);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navOpen, close]);

  const stale = enabled && stream.state === "offline";

  return (
    <div className="app">
      <Sidebar />
      <div className="nav-scrim" onClick={close} />
      <div className="main">
        <TopBar onOpenNav={() => setNavOpen(true)} />
        <SystemBanners />
        <main className={stale ? "content is-stale" : "content"} id="main">
          <Outlet />
        </main>
      </div>
      <StreamToasts />
    </div>
  );
}
