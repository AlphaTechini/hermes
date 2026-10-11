import { CirclePause, Menu, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { PerplConnectionDTO, PerplHealthDTO } from "@hermes/shared";
import { get } from "../../lib/api";
import { useHeadBlock } from "../../lib/chain";
import { formatBlock, formatMs, formatSignedUsd, formatUsd, orNA, pnlTone } from "../../lib/format";
import { qk, useAccount, useLimits, useSetPaused } from "../../lib/queries";
import { OFFLINE_AFTER_ATTEMPTS, usePerplHealth, useStreamStatus } from "../../lib/stream";
import { useTheme } from "../../lib/theme";
import { cn } from "../../lib/cn";
import { useAuthEnabled } from "../../auth/context";
import { Button, IconButton } from "../ui/Button";
import { Meter } from "../ui/Meter";
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

function ConnectionPill({ rtt, perpl, health }: { rtt: number | null; perpl: PerplConnectionDTO | undefined; health: PerplHealthDTO | null }) {
  const stream = useStreamStatus();
  const ref = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const leave = useRef<ReturnType<typeof setTimeout> | null>(null);

  const streamDown = stream.state === "offline" || stream.state === "reconnecting";
  let tone: "positive" | "warning" | "negative" | "faint" = "positive";
  let label = "Perpl";
  const latency = health?.latencyMs ?? null;
  let sub: string = latency !== null ? `${Math.round(latency)} ms` : rtt !== null ? `${rtt} ms` : "";
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
  } else if (health ?? perpl) {
    const st = (health ?? perpl)!.status;
    if (st === "reconnecting") (tone = "warning", (live = true), (sub = "reconnecting"));
    else if (st === "disconnected") (tone = "negative", (sub = "disconnected"));
    else if (st === "not_configured") (tone = "faint", (sub = "not set up"));
  }

  const show = () => {
    if (leave.current) clearTimeout(leave.current);
    setOpen(true);
  };
  const hide = () => {
    leave.current = setTimeout(() => setOpen(false), 120);
  };
  useEffect(() => () => void (leave.current && clearTimeout(leave.current)), []);

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
      >
        <span className="hm-dot" data-tone={tone === "faint" ? undefined : tone} data-live={live ? "true" : undefined} />
        <span className="v" style={{ fontFamily: "var(--font-ui)" }}>
          {label}
        </span>
        {sub && <span className="s">{sub}</span>}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref}>
        <div className="conn-pop" onMouseEnter={show} onMouseLeave={hide}>
          <div className="r"><span className="l">Live stream (Hermes)</span><span className="v">{streamDown ? stream.state : "live"}</span></div>
          <div className="r"><span className="l">Perpl trading socket</span><span className="v">{(health ?? perpl) ? (health ?? perpl)!.status.replace("_", " ") : "n/a"}</span></div>
          <div className="r"><span className="l">Perpl mode</span><span className="v">{health?.mode ?? perpl?.mode ?? "n/a"}</span></div>
          <div className="r"><span className="l">Perpl round trip</span><span className="v">{latency !== null ? formatMs(latency) : "n/a"}</span></div>
          <div className="r"><span className="l">Last heartbeat</span><span className="v">{health?.heartbeatAgeMs != null ? `${(health.heartbeatAgeMs / 1000).toFixed(1)}s ago` : "n/a"}</span></div>
          <div className="r"><span className="l">Reconnects</span><span className="v">{health ? health.reconnects : "n/a"}</span></div>
          <div className="r"><span className="l">Hermes API round trip</span><span className="v">{rtt !== null ? formatMs(rtt) : "n/a"}</span></div>
          <div className="r"><span className="l">Account</span><span className="v">{(health?.accountId ?? perpl?.accountId) ? `#${health?.accountId ?? perpl?.accountId}` : "n/a"}</span></div>
          {health?.lastError && <div className="r"><span className="l">Last error</span><span className="v">{health.lastError}</span></div>}
        </div>
      </Popover>
    </>
  );
}

function HeadItem({ health }: { health: PerplHealthDTO | null }) {
  const rpc = useHeadBlock();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // Prefer the head block the Perpl heartbeat reports; its age is measured from when this tab first saw that block.
  const seen = useRef<{ n: number; at: number } | null>(null);
  const hb = health?.headBlock ?? null;
  if (hb !== null && seen.current?.n !== hb) seen.current = { n: hb, at: Date.now() };
  const number = hb ?? rpc.data?.number ?? null;
  const since = hb !== null ? seen.current?.at : rpc.data?.timestampMs;
  const age = since !== undefined && number !== null ? Math.max(0, (now - since) / 1000) : null;
  return (
    <div className="tb-item tb-hide-sm tb-hide-md" style={{ order: 2 }} title="Latest block">
      <span className="l">Head</span>
      <span className="v">{orNA(number, formatBlock)}</span>
      {age !== null && <span className="s">{age < 10 ? age.toFixed(1) : Math.round(age)}s</span>}
    </div>
  );
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
  const today = acc ? acc.realizedPnlTodayUsd + acc.unrealizedPnlUsd : null;
  const stop = limits.data?.dailyLossStopUsd ?? null;
  const used = today !== null ? Math.max(0, -today) : null;
  const paused = limits.data?.paused ?? false;
  const equityFlash = useFlash(acc?.equityUsd);
  const todayFlash = useFlash(today);

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
        <span className="vdiv tb-hide-sm" style={{ order: 2 }} />
        <HeadItem health={health} />
        <span className="vdiv tb-hide-md tb-hide-sm" style={{ order: 2 }} />
        <div className="tb-item" style={{ order: 2 }}>
          <span className="l">Equity</span>
          <span className={cn("v", equityFlash)}>{orNA(acc?.equityUsd, (v) => formatUsd(v))}</span>
        </div>
        <span className="vdiv" style={{ order: 2 }} />
        <div className="tb-item" style={{ order: 2 }}>
          <span className="l">Today</span>
          <span className={cn("v", todayFlash, pnlTone(today) === "positive" && "pos", pnlTone(today) === "negative" && "neg")}>{orNA(today, (v) => formatSignedUsd(v))}</span>
        </div>
        <span className="vdiv" style={{ order: 2 }} />
        <div className="tb-item" style={{ order: 2 }} title={stop !== null ? `Daily loss stop: Hermes blocks new orders once today's loss reaches ${formatUsd(stop, { decimals: 0 })}. Resets 00:00 UTC.` : undefined}>
          <span className="l">Loss stop</span>
          <span className="tb-stop">
            <Meter value={used ?? 0} max={stop ?? 1} aria-label="Daily loss used" />
            <span className="v">
              {orNA(used, (v) => formatUsd(v, { decimals: 0 }))} <span className="s">/ {orNA(stop, (v) => formatUsd(v, { decimals: 0 }))}</span>
            </span>
          </span>
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
