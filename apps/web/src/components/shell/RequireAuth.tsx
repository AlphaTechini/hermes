import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../../auth/context";
import { usePerplConnection } from "../../lib/queries";
import { Spinner } from "../ui/Feedback";

/**
 * Route guard. Not signed in: back to the landing page. Signed in with Privy but no Perpl connection yet: redirect to
 * /onboarding (except /onboarding and /wallet). In DEV mode there is no hard block; the shell shows a "Finish setup" banner.
 */
export function RequireAuth() {
  const { ready, authenticated, mode } = useAuth();
  const { pathname } = useLocation();
  const perpl = usePerplConnection();

  if (!ready) {
    return (
      <div className="page-loading" role="status" style={{ minHeight: "100dvh" }}>
        <Spinner size={20} label="Loading" />
      </div>
    );
  }
  if (!authenticated) return <Navigate to="/" replace state={{ from: pathname }} />;

  const exempt = pathname.startsWith("/onboarding") || pathname.startsWith("/wallet");
  if (mode === "privy" && !exempt && perpl.data && !perpl.data.configured) return <Navigate to="/onboarding" replace />;
  return <Outlet />;
}
