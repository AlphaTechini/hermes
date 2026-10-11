import { NavLink, Link } from "react-router-dom";
import { useAuth } from "../../auth/context";
import { usePendingApprovalCount } from "../../lib/queries";
import { NAV_ACCOUNT, NAV_MAIN, type NavEntry } from "../../lib/routes";
import { shortAddress } from "../../lib/format";
import { Avatar } from "../ui/Misc";
import { Mark } from "./Mark";

function Item({ entry, count }: { entry: NavEntry; count: number }) {
  const Icon = entry.icon;
  return (
    <NavLink to={entry.to} className="nav-item" title={entry.label}>
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
    </NavLink>
  );
}

/**
 * 232 wide at >= 1280, 56 icon rail at 768 to 1279 (labels hidden, accent dot for approvals), off-canvas drawer below 768.
 * The mobile open state is the `nav-open` class on <body> (see AppShell).
 */
export function Sidebar() {
  const { authenticated, user } = useAuth();
  const pending = usePendingApprovalCount();
  const email = user?.email ?? (authenticated ? "Signed in" : "Not signed in");
  return (
    <aside className="sidebar" aria-label="Sidebar">
      <div className="sb-head">
        <Link className="brand" to={authenticated ? "/live" : "/"}>
          <Mark />
          <span className="brand-name">Hermes</span>
        </Link>
        <span className="env-tag">testnet</span>
      </div>
      <nav className="sb-nav" aria-label="Main">
        {NAV_MAIN.map((n) => (
          <Item key={n.id} entry={n} count={pending} />
        ))}
        <div className="nav-label">Account</div>
        {NAV_ACCOUNT.map((n) => (
          <Item key={n.id} entry={n} count={0} />
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
    </aside>
  );
}
