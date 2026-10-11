import { TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/context";
import { Mark } from "../../components/shell/Mark";
import { usePageTitle } from "../../components/shell/PageHeader";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/Feedback";
import { Skeleton } from "../../components/ui/Skeleton";
import { Stepper } from "../../components/ui/Stepper";
import { useDelayedFlag } from "../../components/ui/hooks";
import { ONBOARDING_STEPS } from "../../lib/routes";
import { usePerplConnection, usePrivyWallet, useWalletActions } from "../../lib/queries";
import { useStreamConnection } from "../../lib/stream";
import { latestAction } from "../wallet/hooks";
import { StepAccount } from "./StepAccount";
import { StepKey } from "./StepKey";
import { StepStrategy } from "./StepStrategy";
import { StepWallet } from "./StepWallet";
import type { StepProps } from "./types";

/**
 * Onboarding in its own frame (no sidebar), like onboarding.html. The step comes from server data (signer added, Perpl
 * account, API key) so a refresh resumes where you stopped. `?step=1..4` links straight to a step, but never past the
 * first unfinished one.
 */
export function OnboardingPage() {
  usePageTitle("Set up");
  const { user, logout, authenticated } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // The shell opens the live stream for every other page. Onboarding has no shell, and wallet action rows need it.
  useStreamConnection(authenticated);

  const privy = usePrivyWallet();
  const actions = useWalletActions();
  const perpl = usePerplConnection();

  const loading = privy.isLoading || actions.isLoading || perpl.isLoading;
  const failed = privy.isError || actions.isError || perpl.isError;
  const showSkeleton = useDelayedFlag(loading);

  const signerAdded = Boolean(privy.data?.signerAddedAt);
  const keyDone = Boolean(perpl.data?.configured);
  const accountDone = keyDone || (latestAction(actions.data, "create_account")?.status === "confirmed" && latestAction(actions.data, "allow_forwarding")?.status === "confirmed");
  // A connected Perpl account (including a simulated one) means the earlier steps no longer block anything.
  const firstOpen = keyDone ? 4 : !signerAdded ? 1 : !accountDone ? 2 : 3;
  // With no ?step the page opens on the first unfinished step and stays there (it does not jump while you act).
  const landed = useRef<number | null>(null);
  if (landed.current === null && !loading && !failed) landed.current = firstOpen;
  const requested = Number(params.get("step")) || landed.current || 0;
  const step = loading || failed ? Math.min(4, Math.max(1, requested || 1)) : Math.min(requested >= 1 ? Math.min(4, requested) : firstOpen, firstOpen);

  const go = useCallback((n: number) => navigate(`/onboarding?step=${n}`), [navigate]);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [step]);

  const props: StepProps = { go, signerAdded, accountDone, keyDone };

  return (
    <>
      <header className="ob-top">
        <Link className="brand" to="/">
          <Mark />
          Hermes
        </Link>
        <span className="env-tag" style={{ marginLeft: 0 }}>
          testnet
        </span>
        <div className="right">
          <span className="xs muted">Step {step} of 4</span>
          <span className="vdiv" />
          {user?.email && <span className="xs secondary hide-sm">{user.email}</span>}
          <Button variant="ghost" size="sm" onClick={() => void logout().then(() => navigate("/"))}>
            Sign out
          </Button>
        </div>
      </header>
      <div className="ob">
        <Stepper steps={ONBOARDING_STEPS.map((s) => ({ ...s }))} current={step} />
        <section className="ob-card" data-step={step}>
          {failed ? (
            <EmptyState
              icon={TriangleAlert}
              tone="negative"
              title="Could not load your setup"
              actions={
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    void privy.refetch();
                    void actions.refetch();
                    void perpl.refetch();
                  }}
                >
                  Retry
                </Button>
              }
            >
              Hermes did not respond. Nothing was changed. Try again in a moment.
            </EmptyState>
          ) : loading ? (
            showSkeleton ? (
              <div className="col g4" aria-busy="true" aria-label="Loading">
                <Skeleton w={260} h={32} />
                <Skeleton h={44} />
                <Skeleton h={220} />
                <Skeleton h={120} />
              </div>
            ) : null
          ) : step === 1 ? (
            <StepWallet {...props} />
          ) : step === 2 ? (
            <StepAccount {...props} />
          ) : step === 3 ? (
            <StepKey {...props} />
          ) : (
            <StepStrategy {...props} />
          )}
        </section>
      </div>
    </>
  );
}
