import { ArrowRight, FlaskConical, KeyRound, Mail, Moon, Shield, Sun } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/context";
import { Mark } from "../components/shell/Mark";
import { usePageTitle } from "../components/shell/PageHeader";
import { Button, ButtonLink, IconButton } from "../components/ui/Button";
import { useTheme } from "../lib/theme";

/**
 * Public landing (placeholder for the landing engineer). Nav, eyebrow, H1, sub, CTA and proof are final copy
 * (DESIGN.md 10.1). "Sign in" opens the Privy modal, or in DEV mode just unlocks the app.
 */
export function LandingPage() {
  usePageTitle("Hermes");
  const { authenticated, login, mode } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();

  const signIn = () => {
    if (authenticated) return navigate("/live");
    login();
    if (mode === "dev") navigate("/live");
  };

  return (
    <div className="lp">
      <nav className="lp-nav" aria-label="Main">
        <Link className="brand" to="/">
          <Mark />
          Hermes
        </Link>
        <div className="links">
          <a href="#how">How it works</a>
          <a href="#measure">Report card</a>
          <a href="#safety">Safety</a>
        </div>
        <div className="right">
          <IconButton size="sm" icon={theme === "light" ? Moon : Sun} label="Switch theme" onClick={toggle} />
          <Button size="sm" variant="secondary" onClick={signIn}>
            {authenticated ? "Open app" : "Sign in"}
          </Button>
        </div>
      </nav>
      <div className="lp-hero-wrap">
        <header className="lp-hero">
          <div>
            <span className="eyebrow">
              <span className="hm-dot" data-tone="positive" />
              Live on Perpl, Monad testnet
            </span>
            <h1 className="lp-h1">TradingView alerts, filled on Perpl in under a second.</h1>
            <p className="lp-sub">Hermes places each order inside limits you set, then shows how the live fills compare with the chart.</p>
            <div className="lp-cta">
              <Button variant="primary" size="lg" icon={Mail} onClick={signIn}>
                {authenticated ? "Open Hermes" : "Sign in with email"}
              </Button>
              <ButtonLink variant="ghost" size="lg" to="#how">
                How it works
                <ArrowRight aria-hidden />
              </ButtonLink>
            </div>
            <div className="lp-proof">
              <span><KeyRound aria-hidden />Trade-only keys, no withdrawals</span>
              <span><Shield aria-hidden />Hard limits on every order</span>
              <span><FlaskConical aria-hidden />Testnet funds only</span>
            </div>
          </div>
        </header>
      </div>
      <footer className="lp-foot">
        <span>Hermes · open source, MIT licence</span>
        <span>Runs on Perpl, Monad testnet. No real funds.</span>
      </footer>
    </div>
  );
}
