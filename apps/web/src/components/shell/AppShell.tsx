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
import { RouteErrorBoundary } from "./ErrorBoundary";
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
  // The server's own number, the one the risk gate evaluates: realised + unrealised today, and how much of the stop is used.
  const used = a?.lossStopUsedUsd ?? (a ? Math.max(0, -(a.realizedPnlTodayUsd + a.unrealizedPnlUsd)) : 0);
  const stopHit = Boolean(l && l.dailyLossStopUsd > 0 && used >= l.dailyLossStopUsd);
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
  const sidebarRef = useRef<HTMLElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const navigated = useRef(false);
  useStreamConnection(enabled);

  const open = useCallback(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setNavOpen(true);
  }, []);
  const close = useCallback(() => setNavOpen(false), []);

  useEffect(() => {
    if (document.body.classList.contains("nav-open")) navigated.current = true;
    setNavOpen(false);
  }, [pathname]);
  useEffect(() => {
    document.body.classList.toggle("nav-open", navOpen);
    return () => document.body.classList.remove("nav-open");
  }, [navOpen]);

  // Mobile nav drawer (< 768): focus moves into it, Tab stays inside, Escape closes, focus goes back to the opener.
  useEffect(() => {
    if (!navOpen) return;
    const side = sidebarRef.current;
    const focusables = () => Array.from(side?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? []).filter((el) => el.offsetParent !== null);
    (side?.querySelector<HTMLElement>('.nav-item[aria-current="page"]') ?? focusables()[0])?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
      } else if (e.key === "Tab") {
        const items = focusables();
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        if (!side?.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Closed by choosing a page: focus the new page. Closed otherwise: give focus back to what opened the drawer.
      const back = navigated.current ? document.getElementById("main") : opener.current;
      navigated.current = false;
      opener.current = null;
      if (back && document.contains(back)) back.focus({ preventScroll: true });
    };
  }, [navOpen, close]);

  const stale = enabled && stream.state === "offline";

  return (
    <div className="app">
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>
        Skip to content
      </a>
      <Sidebar ref={sidebarRef} onClose={close} />
      <div className="nav-scrim" onClick={close} />
      <div className="main">
        <TopBar onOpenNav={open} />
        <SystemBanners />
        <main className={stale ? "content is-stale" : "content"} id="main" tabIndex={-1}>
          <RouteErrorBoundary>
            <Outlet />
          </RouteErrorBoundary>
        </main>
      </div>
      <StreamToasts />
    </div>
  );
}
