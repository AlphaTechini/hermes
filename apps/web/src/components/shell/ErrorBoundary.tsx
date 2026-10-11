import { CircleAlert } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { EmptyState } from "../ui/Feedback";
import { usePageTitle } from "./PageHeader";

interface BoundaryProps {
  /** Changing this clears a caught error (the route boundary passes the pathname, so navigating away recovers). */
  resetKey?: string;
  /** Called by "Retry" before the children render again (refetch the data that probably caused the error). */
  onRetry?: () => void;
  children: ReactNode;
  fallback: (state: { error: Error; attempts: number; retry: () => void; reset: () => void }) => ReactNode;
}

interface BoundaryState {
  error: Error | null;
  /** Consecutive failures since the last navigation. After two, the fallback offers a reload. */
  attempts: number;
}

/**
 * Catches render errors below it. One render exception must never blank the whole app: the shell stays up, the
 * fallback says what happened and offers Retry and Back to Live. Reset by Retry or by `resetKey` changing.
 */
export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null, attempts: 0 };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState((s) => ({ attempts: s.attempts + 1 }));
    // eslint-disable-next-line no-console
    console.error("Hermes render error", error, info.componentStack);
  }

  override componentDidUpdate(prev: BoundaryProps): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null, attempts: 0 });
  }

  private retry = () => {
    this.props.onRetry?.();
    this.setState({ error: null });
  };

  /** Clears the error without refetching (used when leaving the page). */
  private reset = () => this.setState({ error: null, attempts: 0 });

  override render(): ReactNode {
    const { error, attempts } = this.state;
    if (error) return this.props.fallback({ error, attempts, retry: this.retry, reset: this.reset });
    return this.props.children;
  }
}

/** The error state from DESIGN.md 10.9: icon tile, what happened, what to do next, two actions. */
function ErrorPanel({ error, attempts, onRetry, onHome, scope }: { error: Error; attempts: number; onRetry: () => void; onHome: () => void; scope: "route" | "app" }) {
  usePageTitle("Something went wrong");
  return (
    <Card role="alert" aria-live="assertive">
      <EmptyState
        icon={CircleAlert}
        tone="negative"
        title={scope === "app" ? "Hermes hit an error" : "This page hit an error"}
        actions={
          <>
            <Button size="sm" variant="primary" onClick={onRetry}>
              Retry
            </Button>
            <Button size="sm" variant="ghost" onClick={onHome}>
              Back to Live
            </Button>
            {attempts >= 2 && (
              <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
                Reload page
              </Button>
            )}
          </>
        }
      >
        {scope === "app"
          ? "Your alerts and orders are not affected. Try again, or go back to Live."
          : "The rest of Hermes still works. Try again, or go back to Live."}
        {error.message && (
          <>
            <br />
            <code className="xs faint hm-truncate" style={{ display: "inline-block", maxWidth: "100%", verticalAlign: "bottom" }} title={error.message}>
              {error.message}
            </code>
          </>
        )}
      </EmptyState>
    </Card>
  );
}

/**
 * Route-level boundary: wraps the `<Outlet />` in the app shell (sidebar and top bar stay rendered) and the onboarding
 * page. Keyed by pathname, so moving to another page always starts clean.
 */
export function RouteErrorBoundary({ children, full }: { children: ReactNode; /** No shell around it (onboarding): centre the panel in the viewport. */ full?: boolean }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  return (
    <ErrorBoundary
      resetKey={pathname}
      onRetry={() => void qc.invalidateQueries()}
      fallback={({ error, attempts, retry, reset }) => {
        const home = () => {
          reset();
          navigate("/live");
        };
        const panel = <ErrorPanel error={error} attempts={attempts} scope="route" onRetry={retry} onHome={home} />;
        return full ? <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 16 }}><div style={{ width: "min(560px, 100%)" }}>{panel}</div></div> : panel;
      }}
    >
      {children}
    </ErrorBoundary>
  );
}

/**
 * App-level boundary: the last line of defence around the router's routes (landing, shell, 404). It cannot assume the
 * shell exists, so it renders a full-viewport panel and "Back to Live" is a plain navigation.
 */
export function AppErrorBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const qc = useQueryClient();
  return (
    <ErrorBoundary
      resetKey={pathname}
      onRetry={() => void qc.invalidateQueries()}
      fallback={({ error, attempts, retry }) => (
        <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 16, background: "var(--canvas)" }}>
          <div style={{ width: "min(560px, 100%)" }}>
            <ErrorPanel error={error} attempts={attempts} scope="app" onRetry={retry} onHome={() => window.location.assign("/live")} />
          </div>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
