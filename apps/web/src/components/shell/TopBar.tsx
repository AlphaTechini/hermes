import { CirclePause, Menu, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { PerplConnectionDTO, PerplHealthDTO } from "@hermes/shared";
import { get } from "../../lib/api";
import { formatBlock, formatMs, formatSignedUsd, formatUsd, pnlTone } from "../../lib/format";
import { qk, useAccount, useLimits, useSetPaused } from "../../lib/queries";
import { OFFLINE_AFTER_ATTEMPTS, usePerplHealth, useStreamStatus } from "../../lib/stream";
import { useTheme } from "../../lib/theme";
import { cn } from "../../lib/cn";
import { useAuthEnabled } from "../../auth/context";
import { Button, IconButton } from "../ui/Button";
import { Meter } from "../ui/Meter";
import { Skeleton } from "../ui/Skeleton";
import { ConfirmModal } from "../ui/Overlay";
import { Popover } from "../ui/Popover";
import { Toggle } from "../ui/Toggle";
import { Mark } from "./Mark";
import { useToast } from "../ui/Toast";
import { errorMessage } from "../../lib/api";

/** `hm-flash-up` / `hm-flash-down` for one tick when a live number changes (DESIGN.md section 6.3). Never animates digits. */
function useFlash(value: number | null | undefined): string | undefined {
  const prev = useRef<number | null>(null);
  const [cls, setCls] = useState<string | undefined>();
  useEffect(() => {
    if (value === null || value === undefined) return;
    const before = prev.current;
    prev.current = value;
    if (before === null || before === value) return;
    setCls(undefined);
    const raf = requestAnimationFrame(() => setCls(value > before ? "hm-flash-up" : "hm-flash-down"));
    const t = setTimeout(() => setCls(undefined), 950);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [value]);
  return cls;
}

/** Hermes API round trip in ms, measured on the Perpl connection poll. */
function useApiRtt(enabled: boolean) {
  const [rtt, setRtt] = useState<number | null>(null);
  const q = useQuery({
    queryKey: [...qk.perpl, "rtt"],
    queryFn: async () => {
      const t0 = performance.now();
      const c = await get<PerplConnectionDTO>("/api/perpl/connection");
      setRtt(Math.round(performance.now() - t0));
      return c;
    },
    enabled,
    refetchInterval: 20_000,
    staleTime: 10_000,
  });
  return { rtt, conn: q.data };
}

const STREAM_WORD: Record<string, string> = { live: "Live", connecting: "Connecting", reconnecting: "Reconnecting", offline: "Offline", idle: "Not started" };
const LINK_WORD: Record<string, string> = { connected: "Connected", reconnecting: "Reconnecting", disconnected: "Disconnected", not_configured: "Not set up" };
const SOURCE_WORD: Record<string, string> = { order: "from your recent orders", probe: "timed request to Perpl" };

/** `now` under 2 s, else `4.2 s ago`, `1m ago`. */
function heartbeatText(ageMs: number | null | undefined): string {
  if (ageMs === null || ageMs === undefined) return "n/a";
  if (ageMs < 2000) return "now";
  if (ageMs < 60_000) return `${(ageMs / 1000).toFixed(1)} s ago`;
  return `${Math.floor(ageMs / 60_000)}m ago`;
}

function ConnectionPill({ rtt, perpl, health }: { rtt: number | null; perpl: PerplConnectionDTO | undefined; health: PerplHealthDTO | null }) {
  const stream = useStreamStatus();
  const ref = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const leave = useRef<ReturnType<typeof setTimeout> | null>(null);

  const link = health ?? perpl ?? null;
  // Round trip to Perpl (not to Hermes). Never fall back to the Hermes API round trip for the pill.
  const latency = health?.latencyMs ?? null;
  let tone: "positive" | "warning" | "negative" | "faint" = "positive";
  let label = "Perpl";
  let sub = latency !== null ? `${Math.round(latency)} ms` : "";
  let live = false;
  if (stream.state === "offline") {
    tone = "negative";
    label = "Offline";
    sub = "";
  } else if (stream.state === "reconnecting") {
    tone = "warning";
    label = "Reconnecting";
    sub = `${stream.attempt}/${OFFLINE_AFTER_ATTEMPTS}`;
    live = true;
  } else if (link) {
    if (link.status === "reconnecting") (tone = "warning", (live = true), (sub = "reconnecting"));
    else if (link.status === "disconnected") (tone = "negative", (sub = "disconnected"));
    else if (link.status === "not_configured") (tone = "faint", (sub = "not set up"));
  }

  const show = () => {
    if (leave.current) clearTimeout(leave.current);
    setOpen(true);
  };
  const hide = () => {
    leave.current = setTimeout(() => setOpen(false), 120);
  };
  useEffect(() => () => void (leave.current && clearTimeout(leave.current)), []);

  const mode = health?.mode ?? perpl?.mode;
  const account = health?.accountId ?? perpl?.accountId ?? null;
  const source = health?.latencySource ? SOURCE_WORD[health.latencySource] : null;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="tb-item tb-conn"
        style={{ order: 1, ...(tone === "warning" ? { borderColor: "var(--warning-border)" } : null) }}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        title={latency !== null && source ? `Round trip to Perpl, ${source}` : undefined}
      >
        <span className="hm-dot" data-tone={tone === "faint" ? undefined : tone} data-live={live ? "true" : undefined} />
        <span className="v" style={{ fontFamily: "var(--font-ui)" }}>
          {label}
        </span>
        {sub && <span className="s">{sub}</span>}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref}>
        <div className="conn-pop" onMouseEnter={show} onMouseLeave={hide}>
          <div className="r"><span className="l">Live stream (Hermes)</span><span className="v">{STREAM_WORD[stream.state] ?? "n/a"}</span></div>
          <div className="r"><span className="l">Perpl trading socket</span><span className="v">{link ? (LINK_WORD[link.status] ?? "n/a") : "n/a"}</span></div>
          <div className="r"><span className="l">Perpl mode</span><span className="v">{mode === "sim" ? "Simulated" : mode === "live" ? "Testnet" : "n/a"}</span></div>
          <div className="r"><span className="l">Round trip to Perpl</span><span className="v" title={source ?? undefined}>{latency !== null ? formatMs(latency) : "n/a"}</span></div>
          {source && <div className="r"><span className="l">Measured</span><span className="v" style={{ fontFamily: "var(--font-ui)" }}>{source}</span></div>}
          <div className="r"><span className="l">Last heartbeat</span><span className="v">{heartbeatText(health?.heartbeatAgeMs)}</span></div>
          <div className="r"><span className="l">Block time</span><span className="v">{health?.blockTimeMs != null ? `${Math.round(health.blockTimeMs)} ms` : "n/a"}</span></div>
          <div className="r"><span className="l">Reconnects</span><span className="v">{health ? health.reconnects : "n/a"}</span></div>
          <div className="r"><span className="l">Hermes API round trip</span><span className="v">{rtt !== null ? formatMs(rtt) : "n/a"}</span></div>
          <div className="r"><span className="l">Account</span><span className="v">{account ? `#${account}` : "n/a"}</span></div>
          {health?.lastError && <div className="r"><span className="l">Last error</span><span className="v" style={{ fontFamily: "var(--font-ui)" }}>{health.lastError}</span></div>}
        </div>
      </Popover>
    </>
  );
}

/** True for `ms` after mount. Lets a value that has not arrived yet show a skeleton first, then give up and hide. */
function useGrace(ms: number): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(t);
  }, [ms]);
  return on;
}

/**
 * Head block from the Perpl heartbeat (sim and live), with its age and the measured block time. No data yet: a skeleton
 * for up to 5 s, then the item is hidden (`n/a` would mean "unknown", and here it just means "not connected").
 */
function HeadItem({ health }: { health: PerplHealthDTO | null }) {
  const grace = useGrace(5000);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // The age is measured from when this tab first saw that block number.
  const seen = useRef<{ n: number; at: number } | null>(null);
  const number = health?.headBlock ?? null;
  if (number !== null && seen.current?.n !== number) seen.current = { n: number, at: Date.now() };
  const age = number !== null && seen.current ? Math.max(0, (now - seen.current.at) / 1000) : null;
  if (number === null && !(grace && health === null)) return null;
  const blockTime = health?.blockTimeMs != null ? `Block time about ${Math.round(health.blockTimeMs)} ms` : "Latest block";
  return (
    <>
      <span className="vdiv tb-hide-sm" style={{ order: 2 }} />
      <div className="tb-item tb-hide-sm tb-hide-md" style={{ order: 2 }} title={blockTime}>
        <span className="l">Head</span>
        {number === null ? <Skeleton w={48} h={12} /> : <span className="v">{formatBlock(number)}</span>}
        {age !== null && <span className="s">{age < 10 ? age.toFixed(1) : Math.round(age)}s</span>}
      </div>
    </>
  );
}

const FAINT = { color: "var(--text-faint)" } as const;

/** A TopBar value: skeleton while the first read is in flight, faint `n/a` when it failed, the value otherwise. */
function Val({ loading, failed, children, className }: { loading: boolean; failed: boolean; children: ReactNode; className?: string }) {
  if (loading) return <Skeleton w={48} h={12} />;
  if (failed) return <span className="v" style={FAINT}>n/a</span>;
  return <span className={className ? cn("v", className) : "v"}>{children}</span>;
}

/**
 * Status strip: Perpl connection pill, Head block, Equity, Today PnL, Loss stop meter, then the Trading master toggle
 * (bound to `limits.paused`) and the theme toggle. Below 768px it grows a second row with a 3-column strip.
 */
export function TopBar({ onOpenNav }: { onOpenNav: () => void }) {
  const enabled = useAuthEnabled();
  const { theme, toggle } = useTheme();
  const { rtt, conn } = useApiRtt(enabled);
  const health = usePerplHealth() ?? conn?.health ?? null;
  const account = useAccount();
  const limits = useLimits();
  const setPaused = useSetPaused();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);

  const acc = account.data;
  const accLoading = account.isLoading;
  const accFailed = account.isError && !acc;
  // The server's own numbers: today PnL is realised + unrealised, the same figure the daily loss stop is checked against.
  const today = acc ? (acc.todayPnlUsd ?? acc.realizedPnlTodayUsd + acc.unrealizedPnlUsd) : null;
  const stop = acc?.lossStopUsd ?? limits.data?.dailyLossStopUsd ?? null;
  const used = acc?.lossStopUsedUsd ?? (today !== null ? Math.max(0, -today) : null);
  const stopLoading = accLoading || (limits.isLoading && stop === null);
  const paused = limits.data?.paused ?? false;
  const equityFlash = useFlash(acc?.equityUsd);
  const todayFlash = useFlash(today);
  const tone = pnlTone(today);
  const todayParts =
    acc && acc.todayRealizedUsd !== undefined && acc.todayUnrealizedUsd !== undefined
      ? `Realised ${formatSignedUsd(acc.todayRealizedUsd)}, unrealised ${formatSignedUsd(acc.todayUnrealizedUsd)}. Resets 00:00 UTC.`
      : undefined;

  const pause = (next: boolean) =>
    setPaused.mutate(next, {
      onSuccess: () => {
        setConfirm(false);
        if (next) toast.warning("Trading paused", "Alerts are logged and blocked. Open positions stay open.");
        else toast.positive("Trading resumed", "New alerts can place orders again.");
      },
      onError: (e) => toast.negative("Could not change trading", errorMessage(e), { actions: [{ label: "Try again", onClick: () => pause(next) }] }),
    });

  return (
    <header className="topbar">
      <div className="tb-row1">
        <Button variant="ghost" className="tb-menu" icon={Menu} aria-label="Open navigation" onClick={onOpenNav} style={{ order: 0, width: 32, padding: 0 }} />
        <Link className="brand tb-brand" to="/" style={{ order: 0 }} aria-label="Hermes">
          <Mark />
        </Link>
        <ConnectionPill rtt={rtt} perpl={conn} health={health} />
        <div className="tb-right" style={{ order: 3 }}>
          <Toggle
            tone="positive"
            label={<span className="hide-sm">Trading</span>}
            labelSide="left"
            checked={!paused}
            disabled={!limits.data || setPaused.isPending}
            aria-label="Trading on"
            title="Pause trading stops Hermes from sending any new order. Open positions stay open."
            onCheckedChange={(on) => (on ? pause(false) : setConfirm(true))}
          />
          <span className="vdiv hide-sm" />
          <IconButton size="sm" icon={theme === "light" ? Moon : Sun} label="Switch theme" onClick={toggle} />
        </div>
      </div>
      <div className="tb-strip">
        <HeadItem health={health} />
        <span className="vdiv tb-hide-md tb-hide-sm" style={{ order: 2 }} />
        <div className="tb-item" style={{ order: 2 }}>
          <span className="l">Equity</span>
          <Val loading={accLoading} failed={accFailed} className={equityFlash}>
            {formatUsd(acc?.equityUsd)}
          </Val>
        </div>
        <span className="vdiv" style={{ order: 2 }} />
        <div className="tb-item" style={{ order: 2 }} title={todayParts}>
          <span className="l">Today</span>
          <Val loading={accLoading} failed={accFailed} className={cn(todayFlash, tone === "positive" && "pos", tone === "negative" && "neg")}>
            {formatSignedUsd(today)}
          </Val>
        </div>
        <span className="vdiv" style={{ order: 2 }} />
        <div className="tb-item" style={{ order: 2 }} title={stop !== null && stop > 0 ? `Daily loss stop: Hermes blocks new orders once today's loss reaches ${formatUsd(stop, { decimals: 0 })}. Resets 00:00 UTC.` : undefined}>
          <span className="l">Loss stop</span>
          {stopLoading ? (
            <Skeleton w={96} h={12} />
          ) : accFailed || stop === null || used === null ? (
            <span className="v" style={FAINT}>n/a</span>
          ) : stop === 0 ? (
            <span className="v" style={FAINT}>Off</span>
          ) : (
            <span className="tb-stop">
              <Meter value={used} max={stop} aria-label="Daily loss used" />
              <span className="v">
                {formatUsd(used, { decimals: 0 })} <span className="s">/ {formatUsd(stop, { decimals: 0 })}</span>
              </span>
            </span>
          )}
        </div>
      </div>
      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Pause trading?"
        confirmLabel="Pause trading"
        confirmIcon={CirclePause}
        variant="danger"
        loading={setPaused.isPending}
        loadingLabel="Pausing"
        onConfirm={() => pause(true)}
      >
        Hermes stops sending new orders from every strategy. Alerts still arrive and are logged as blocked. Open positions stay open.
      </ConfirmModal>
    </header>
  );
}
