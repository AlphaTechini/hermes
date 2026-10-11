import { Compass } from "lucide-react";
import { ButtonLink } from "../components/ui/Button";
import { EmptyState } from "../components/ui/Feedback";
import { usePageTitle } from "../components/shell/PageHeader";

export function NotFoundPage() {
  usePageTitle("Not found");
  return (
    <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}>
      <EmptyState icon={Compass} title="Page not found" actions={<ButtonLink variant="primary" size="sm" to="/">Go to Hermes</ButtonLink>}>
        That address does not exist. Check the link or head back to the start.
      </EmptyState>
    </div>
  );
}
