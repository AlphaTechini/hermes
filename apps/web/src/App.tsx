import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth/context";
import { AppShell } from "./components/shell/AppShell";
import { RequireAuth } from "./components/shell/RequireAuth";
import { ComponentsPage } from "./pages/Components";
import { LandingPage } from "./pages/landing";
import { NotFoundPage } from "./pages/NotFound";
import { OnboardingPage } from "./pages/onboarding";
import { AlertPage } from "./pages/alert/AlertPage";
import { ApprovalsPage } from "./pages/approvals/ApprovalsPage";
import { LivePage } from "./pages/live/LivePage";
import { WalletPage } from "./pages/wallet";
import { LimitsPage } from "./pages/limits/LimitsPage";
import { ReportPage } from "./pages/report/ReportPage";
import { StrategiesPage } from "./pages/strategies/StrategiesPage";


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
          <Route path="/live" element={<LivePage />} />
          <Route path="/alerts/:id" element={<AlertPage />} />
          <Route path="/strategies/:id?" element={<StrategiesPage />} />
          <Route path="/limits" element={<LimitsPage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/report/:strategyId?" element={<ReportPage />} />
          <Route path="/wallet" element={<WalletPage />} />
        </Route>
      </Route>
      <Route path="/home" element={<Navigate to="/live" replace />} />
      <Route path="*" element={<NotFoundPage key={pathname} />} />
    </Routes>
  );
}
