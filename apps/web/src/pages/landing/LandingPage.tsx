import {
  ArrowRight,
  ChartColumn,
  FlaskConical,
  Gauge,
  Hand,
  KeyRound,
  Mail,
  Moon,
  OctagonX,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Timer,
  Wallet,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/context";
import { Mark } from "../../components/shell/Mark";
import { usePageTitle } from "../../components/shell/PageHeader";
import { Button, ButtonAnchor, IconButton } from "../../components/ui/Button";
import { KpiRow, KpiTile } from "../../components/ui/Card";
import { usePerplConnection } from "../../lib/queries";
import { useTheme } from "../../lib/theme";
import { RelayCard } from "./RelayCard";

function Feature({ icon: Icon, num, title, children }: { icon: LucideIcon; num?: string; title: string; children: ReactNode }) {
  return (
    <div className="feat">
      <span className="ic">
        <Icon aria-hidden />
      </span>
      {num && <span className="num">{num}</span>}
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

function Point({ icon: Icon, bold, children }: { icon: LucideIcon; bold: string; children: ReactNode }) {
  return (
    <div>
      <Icon aria-hidden />
      <span>
        <b>{bold}</b>
        {children}
      </span>
    </div>
  );
}

/**
 * Public landing (DESIGN.md 10.1, design/prototype/landing.html). "Sign in with email" opens the Privy modal (DEV mode just
 * unlocks the app). Once signed in, new users go to /onboarding and finished ones to /live. A visitor who is already
 * signed in sees "Open Hermes".
 */
export function LandingPage() {
  usePageTitle("Hermes");
  const { authenticated, login } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const perpl = usePerplConnection();
  const [signingIn, setSigningIn] = useState(false);

  // After a sign in started here: wait for the Perpl connection to load, then route.
  useEffect(() => {
    if (!signingIn || !authenticated) return;
    if (perpl.isSuccess) navigate(perpl.data.configured ? "/live" : "/onboarding", { replace: true });
    else if (perpl.isError) navigate("/live", { replace: true });
  }, [signingIn, authenticated, perpl.isSuccess, perpl.isError, perpl.data, navigate]);

  const signIn = () => {
    if (authenticated) return navigate("/live");
    setSigningIn(true);
    login();
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
            {authenticated ? "Open Hermes" : "Sign in"}
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
              <Button variant="primary" size="lg" icon={authenticated ? ArrowRight : Mail} onClick={signIn} loading={signingIn && !authenticated} loadingLabel="Opening sign in">
                {authenticated ? "Open Hermes" : "Sign in with email"}
              </Button>
              <ButtonAnchor variant="ghost" size="lg" href="#how">
                How it works
                <ArrowRight aria-hidden />
              </ButtonAnchor>
            </div>
            <div className="lp-proof">
              <span>
                <KeyRound aria-hidden />
                Trade-only keys, no withdrawals
              </span>
              <span>
                <Shield aria-hidden />
                Hard limits on every order
              </span>
              <span>
                <FlaskConical aria-hidden />
                Testnet funds only
              </span>
            </div>
          </div>
          <RelayCard />
        </header>
      </div>

      <section className="lp-section" id="how">
        <h2>Set up once. Every alert after that trades itself.</h2>
        <p className="intro">No bot to write and no server to run. You keep your strategy in TradingView.</p>
        <div className="lp-cols">
          <Feature icon={Wallet} num="01" title="Connect Perpl">
            Sign in with email and get a wallet. Open your Perpl account and add a trade-only API key.
          </Feature>
          <Feature icon={SlidersHorizontal} num="02" title="Set your limits">
            Pick allowed markets, max position size, max leverage, a daily loss stop and a size that needs your approval.
          </Feature>
          <Feature icon={Webhook} num="03" title="Paste the webhook">
            Copy your Hermes URL and message into a TradingView alert. Send a test alert to see it fill.
          </Feature>
        </div>
      </section>

      <section className="lp-section" id="measure">
        <div className="lp-split">
          <div>
            <h2>See if live trading matches the chart.</h2>
            <p className="intro">A backtest assumes you fill at the alert price, instantly. Hermes measures what actually happened.</p>
            <div className="lp-list">
              <Point icon={ArrowRight} bold="Alert price vs fill price">
                , in basis points, for every order.
              </Point>
              <Point icon={Timer} bold="Alert to fill time">
                , split into each step, in milliseconds.
              </Point>
              <Point icon={OctagonX} bold="Every alert that did not trade">
                , with the reason.
              </Point>
              <Point icon={ChartColumn} bold="A grade per strategy">
                , with the formula shown.
              </Point>
            </div>
          </div>
          <div style={{ position: "relative" }}>
            <KpiRow cols={3} aria-label="Example report card numbers">
              <KpiTile label="Fill rate" value="91.2" unit="%" sub="135 of 148" />
              <KpiTile label="Median alert to fill" value="486" unit="ms" sub="p95 871 ms" />
              <KpiTile label="Median slippage" value="4.1" unit="bps" sub="cap 30 bps" />
              <KpiTile label="Grade" value="B" sub="88.7 of 100" />
              <KpiTile label="Blocked by limits" value="9" sub="as you asked" />
              <KpiTile label="Missed" value="13" sub="each with a reason" />
            </KpiRow>
            <p className="xs muted" style={{ position: "absolute", top: "100%", marginTop: 8 }}>
              Example numbers from a demo strategy.
            </p>
          </div>
        </div>
      </section>

      <section className="lp-section" id="safety">
        <h2>Built so a bad alert cannot become a bad day.</h2>
        <div className="lp-cols c4">
          <Feature icon={KeyRound} title="Trade-only key">
            Perpl API keys can trade but can never withdraw or transfer funds.
          </Feature>
          <Feature icon={ShieldCheck} title="Wallet policy">
            Your wallet can only interact with the Perpl exchange contract.
          </Feature>
          <Feature icon={Gauge} title="Hard limits">
            Every alert is checked against your limits before any order is sent.
          </Feature>
          <Feature icon={Hand} title="Your approval">
            Orders above your threshold wait for you, and expire if you do nothing.
          </Feature>
        </div>
      </section>

      <footer className="lp-foot">
        <span className="row g2">
          <Mark />
          Hermes · open source, MIT licence
        </span>
        <span>Runs on Perpl, Monad testnet. No real funds.</span>
      </footer>
    </div>
  );
}
