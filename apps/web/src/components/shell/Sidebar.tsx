import { X } from "lucide-react";
import { forwardRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../../auth/context";
import { usePendingApprovalCount } from "../../lib/queries";
import { NAV_ACCOUNT, NAV_MAIN, type NavEntry } from "../../lib/routes";
import { shortAddress } from "../../lib/format";
import { cn } from "../../lib/cn";
import { IconButton } from "../ui/Button";
import { Avatar } from "../ui/Misc";
import { Tooltip } from "../ui/Tooltip";
import { useMediaQuery } from "../ui/hooks";
import { Mark } from "./Mark";

/** True when `entry` is the current page. An alert is part of Live (`/alerts/:id`), as the breadcrumb says. */
export function isNavActive(entry: Pick<NavEntry, "id" | "to">, pathname: string): boolean {
  if (pathname === entry.to || pathname.startsWith(`${entry.to}/`)) return true;
  return entry.id === "live" && pathname.startsWith("/alerts/");
}

function Item({ entry, count, rail }: { entry: NavEntry; count: number; rail: boolean }) {
  const Icon = entry.icon;
  const { pathname } = useLocation();
  const active = isNavActive(entry, pathname);
  const link = (
    <Link to={entry.to} className={cn("nav-item", active && "active")} aria-current={active ? "page" : undefined} aria-label={rail ? entry.label : undefined}>
      <Icon aria-hidden />
      <span>{entry.label}</span>
      {entry.count === "approvals" && count > 0 && (
        <>
          <em className="nav-count" style={{ fontStyle: "normal" }} aria-label={`${count} waiting`}>
            {count}
          </em>
          <i className="dot-badge" />
        </>
      )}
    </Link>
  );
  // In the icon rail the label is hidden, so it moves into the Hermes tooltip (not the slow native `title`).
  return rail ? (
    <Tooltip content={entry.label} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

/**
 * 232 wide at >= 1280, 56 icon rail at 768 to 1279 (labels in tooltips, accent dot for approvals), off-canvas drawer
 * below 768. The mobile open state is the `nav-open` class on <body> (see AppShell, which also moves focus into the
 * drawer, traps Tab and gives focus back). The aside stretches to the full page height; `.sb-inner` is the sticky part.
 */
export const Sidebar = forwardRef<HTMLElement, { onClose: () => void }>(function Sidebar({ onClose }, ref) {
  const { authenticated, user } = useAuth();
  const pending = usePendingApprovalCount();
  const rail = useMediaQuery("(min-width: 768px) and (max-width: 1279px)");
  const email = user?.email ?? (authenticated ? "Signed in" : "Not signed in");
  return (
    <aside className="sidebar" aria-label="Sidebar" ref={ref}>
      <div className="sb-inner">
        <div className="sb-head">
          <Link className="brand" to={authenticated ? "/live" : "/"}>
            <Mark />
            <span className="brand-name">Hermes</span>
          </Link>
          <span className="env-tag">testnet</span>
          <IconButton className="sb-close" size="sm" icon={X} label="Close navigation" onClick={onClose} />
        </div>
        <nav className="sb-nav" aria-label="Main">
          {NAV_MAIN.map((n) => (
            <Item key={n.id} entry={n} count={pending} rail={rail} />
          ))}
          <div className="nav-label">Account</div>
          {NAV_ACCOUNT.map((n) => (
            <Item key={n.id} entry={n} count={0} rail={rail} />
          ))}
        </nav>
        <div className="sb-foot">
          <Link className="account" to="/wallet" title={user?.email ?? undefined}>
            <Avatar name={user?.email ?? "Hermes"} />
            <span className="account-text">
              <span className="e hm-truncate">{email}</span>
              {user?.walletAddress && <span className="w" title={user.walletAddress}>{shortAddress(user.walletAddress)}</span>}
            </span>
          </Link>
        </div>
      </div>
    </aside>
  );
});
