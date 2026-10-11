import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth/context";
import { AppShell } from "./components/shell/AppShell";
import { RequireAuth } from "./components/shell/RequireAuth";
import { ComponentsPage } from "./pages/Components";
import { LandingPage } from "./pages/Landing";
import { NotFoundPage } from "./pages/NotFound";
import { OnboardingPage } from "./pages/Onboarding";
import { Placeholder } from "./pages/Placeholder";
import { PAGE } from "./lib/routes";
import { useParams } from "react-router-dom";

function AlertDetailPage() {
  const { id } = useParams();
  return <Placeholder title={`Alert ${id ?? ""}`} subtitle={PAGE.alert.subtitle} crumbs={[{ label: "Live", to: "/live" }, { label: id ?? "" }]} owner="alert detail" />;
}
function StrategyDetailPage() {
  const { id } = useParams();
  return <Placeholder title={PAGE.strategy.title} documentTitle={`Strategy ${id ?? ""}`} subtitle={PAGE.strategy.subtitle} crumbs={[{ label: "Strategies", to: "/strategies" }, { label: id ?? "" }]} owner="strategy detail" />;
}
function ReportPage() {
  const { strategyId } = useParams();
  return <Placeholder {...PAGE.report} owner={strategyId ? `report card for ${strategyId}` : "report card"} />;
}

/** Landing is public; an already signed-in visitor still sees it (with an "Open app" button). */
export function App() {
  const { pathname } = useLocation();
  useAuth(); // fail fast if the provider is missing
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/components" element={<AppShell />}>
        <Route index element={<ComponentsPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route element={<AppShell />}>
          <Route path="/live" element={<Placeholder {...PAGE.live} owner="Live dashboard" />} />
          <Route path="/alerts/:id" element={<AlertDetailPage />} />
          <Route path="/strategies" element={<Placeholder {...PAGE.strategies} owner="Strategies" />} />
          <Route path="/strategies/:id" element={<StrategyDetailPage />} />
          <Route path="/limits" element={<Placeholder {...PAGE.limits} owner="Risk limits" />} />
          <Route path="/approvals" element={<Placeholder {...PAGE.approvals} owner="Approvals" />} />
          <Route path="/report/:strategyId?" element={<ReportPage />} />
          <Route path="/wallet" element={<Placeholder {...PAGE.wallet} owner="Wallet and keys" />} />
        </Route>
      </Route>
      <Route path="/home" element={<Navigate to="/live" replace />} />
      <Route path="*" element={<NotFoundPage key={pathname} />} />
    </Routes>
  );
}
