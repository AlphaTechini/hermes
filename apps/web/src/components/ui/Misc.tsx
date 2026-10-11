import { ArrowUpRight, Check, ChevronRight, Timer, type LucideIcon } from "lucide-react";
import type { AnchorHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { Link, type LinkProps } from "react-router-dom";
import { explorerAddressUrl, explorerTxUrl, formatCountdown, shortHex } from "../../lib/format";
import { cn } from "../../lib/cn";
import { Button } from "./Button";
import { Meter } from "./Meter";

/** `<Kbd>A</Kbd>` keyboard key cap. */
export const Kbd = ({ className, ...rest }: HTMLAttributes<HTMLElement>) => <kbd className={className} {...rest} />;

/** `<Avatar name="Ifeoma O" />` 24px circle with initials (or the first two letters of the email). */
export function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  const parts = name.split(/[\s@._-]+/).filter(Boolean);
  const initials = ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase();
  return (
    <span className="avatar" style={{ width: size, height: size }} aria-hidden>
      {initials}
    </span>
  );
}

/** Explorer link: accent text with a 12px `arrow-up-right`, `target=_blank rel=noopener`. Full value in `title`. */
export function ExplorerLink({ kind = "tx", value, children, className, ...rest }: { kind?: "tx" | "address"; value: string; children?: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "children">) {
  return (
    <a
      className={cn("ext mono", className)}
      href={kind === "tx" ? explorerTxUrl(value) : explorerAddressUrl(value)}
      target="_blank"
      rel="noopener"
      title={value}
      {...rest}
    >
      {children ?? shortHex(value)}
      <ArrowUpRight aria-hidden />
    </a>
  );
}

/** Accent text link that routes inside the app. */
export const TextLink = ({ className, ...rest }: LinkProps) => <Link className={cn("link", className)} {...rest} />;

/** `<dl class="kv">` with label left (muted) and value right. `items=[["Fill tx", <ExplorerLink/>], ...]` */
export function KeyValue({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn("kv", className)}>
      {items.map(([k, v], i) => (
        <KvRow key={i} k={k} v={v} />
      ))}
    </dl>
  );
}
function KvRow({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

export interface CheckItem {
  name: ReactNode;
  detail?: ReactNode;
  value?: ReactNode;
  /** `pass` positive check, `fail` warning (the limit that blocked), `skip` faint (never evaluated). */
  state: "pass" | "fail" | "skip";
  icon?: LucideIcon;
}

/** Risk checks list. The failed check is listed first, in warning text. */
export function ChecksList({ items, icons }: { items: CheckItem[]; icons: { pass: LucideIcon; fail: LucideIcon; skip: LucideIcon } }) {
  return (
    <div className="checks">
      {items.map((c, i) => {
        const Icon = c.icon ?? icons[c.state];
        return (
          <div key={i} className={cn("chk", c.state)}>
            <Icon aria-hidden />
            <div>
              <div className="n">{c.name}</div>
              {c.detail && <div className="d">{c.detail}</div>}
            </div>
            {c.value !== undefined && <span className="v">{c.value}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** Divider line. */
export const Divider = ({ className }: { className?: string }) => <hr className={cn("divider", className)} />;

/** Numbered section used in the "Connect TradingView" card: 24px circle, title, body. */
export function SectionNum({ n, title, children }: { n: number; title: ReactNode; children: ReactNode }) {
  return (
    <div className="section-num">
      <span className="n">{n}</span>
      <div className="body">
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

/** Master/detail list row (strategies): `aria-current="true"` gives the active inset bar. */
export function ListItem({ current, to, className, children, ...rest }: { current?: boolean; to?: string; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  const props = { className: cn("list-item", className), "aria-current": current ? ("true" as const) : undefined, ...rest };
  return to ? (
    <Link to={to} {...props}>
      {children}
    </Link>
  ) : (
    <div {...props}>{children}</div>
  );
}

// --- Countdown ----------------------------------------------------------------------------

/**
 * Approval countdown: `timer` icon, "Expires in", mono 16/500 value, 120px accent meter that turns warning under 60 s.
 * Pass the remaining seconds (derive it from `expiresAt - now` once per second) and the total window.
 */
export function Countdown({ remainingSec, totalSec }: { remainingSec: number; totalSec: number }) {
  const urgent = remainingSec < 60;
  return (
    <div className="countdown" data-urgent={urgent ? "" : undefined}>
      <span className="cd-row">
        <Timer className="i-14" aria-hidden />
        Expires in <span className="cd-text">{formatCountdown(remainingSec)}</span>
      </span>
      <Meter value={remainingSec} max={totalSec} tone={urgent ? "warning" : "accent"} aria-label="Time left to approve" />
    </div>
  );
}

// --- Grade badge --------------------------------------------------------------------------

/** 64x64 letter tile: A positive, B neutral, C and D warning, F negative. Pass `size` to scale (letter scales too). */
export function GradeBadge({ grade, size = 64 }: { grade: "A" | "B" | "C" | "D" | "F" | null; size?: number }) {
  return (
    <div className="grade-letter" data-g={grade ?? undefined} style={{ width: size, height: size, fontSize: size * 0.5625 }} aria-label={grade ? `Grade ${grade}` : "No grade yet"}>
      {grade ?? "n/a"}
    </div>
  );
}

/** The F D C B A scale under the grade, current outlined. */
export function GradeScale({ grade }: { grade: "A" | "B" | "C" | "D" | "F" | null }) {
  return (
    <div className="grade-scale" aria-hidden>
      {(["F", "D", "C", "B", "A"] as const).map((g) => (
        <span key={g} aria-current={g === grade ? "true" : undefined}>
          {g}
        </span>
      ))}
    </div>
  );
}

// --- Market tile --------------------------------------------------------------------------

/** Checkbox tile for allowed markets (risk limits). Dashed when unchecked, raised when checked. */
export function MarketTile({ market, checked, onChange, price, note }: { market: string; checked: boolean; onChange: (checked: boolean) => void; price?: ReactNode; note?: ReactNode }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} className="mkt-tile" onClick={() => onChange(!checked)} style={{ textAlign: "left" }}>
      <span className="top">
        <span className="tk">{market}</span>
        <span className="box">
          <Check aria-hidden />
        </span>
      </span>
      {price !== undefined && <span className="px">{price}</span>}
      {note !== undefined && <span className="ex">{note}</span>}
    </button>
  );
}

// --- Save bar -----------------------------------------------------------------------------

/**
 * Sticky unsaved-changes bar: accent dot, summary, Discard (ghost) and Save changes (primary).
 * Render it only while there are changes.
 */
export function SaveBar({ summary, onDiscard, onSave, saving }: { summary: ReactNode; onDiscard: () => void; onSave: () => void; saving?: boolean }) {
  return (
    <div className="savebar" role="region" aria-label="Unsaved changes">
      <span className="changed-dot" />
      <span className="grow">{summary}</span>
      <Button variant="ghost" onClick={onDiscard} disabled={saving}>
        Discard
      </Button>
      <Button variant="primary" onClick={onSave} loading={saving} loadingLabel="Saving">
        Save changes
      </Button>
    </div>
  );
}

/** Small chevron used in row affordances. */
export const RowChevron = () => <ChevronRight className="chev" aria-hidden />;
