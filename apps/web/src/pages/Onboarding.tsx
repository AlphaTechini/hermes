import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/context";
import { Mark } from "../components/shell/Mark";
import { usePageTitle } from "../components/shell/PageHeader";
import { Button } from "../components/ui/Button";
import { Stepper } from "../components/ui/Stepper";
import { Card, CardBody } from "../components/ui/Card";
import { ONBOARDING_STEPS } from "../lib/routes";

const TITLES = ["Your wallet is ready", "Open your Perpl account", "Add a trade-only API key", "Create your first strategy"];

/**
 * Onboarding has its own frame (no sidebar), exactly like onboarding.html: 56px top bar, 240 stepper + 560 content.
 * `?step=1..4` selects the step. The screen engineer replaces the <section className="ob-card"> body.
 */
export function OnboardingPage() {
  usePageTitle("Set up");
  const [params] = useSearchParams();
  const step = Math.min(4, Math.max(1, Number(params.get("step")) || 1));
  const { user, logout } = useAuth();
  return (
    <>
      <header className="ob-top">
        <Link className="brand" to="/">
          <Mark />
          Hermes
        </Link>
        <span className="env-tag" style={{ marginLeft: 0 }}>testnet</span>
        <div className="right">
          <span className="xs muted">Step {step} of 4</span>
          <span className="vdiv" />
          {user?.email && <span className="xs secondary hide-sm">{user.email}</span>}
          <Button variant="ghost" size="sm" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </header>
      <div className="ob">
        <Stepper steps={ONBOARDING_STEPS.map((s) => ({ ...s }))} current={step} />
        <section className="ob-card">
          <div>
            <h2>{TITLES[step - 1]}</h2>
          </div>
          <Card>
            <CardBody>
              <p className="secondary">Placeholder for onboarding step {step}. Go to <Link className="link" to="/live">Live</Link> to skip setup in DEV mode.</p>
            </CardBody>
          </Card>
        </section>
      </div>
    </>
  );
}
