import { FlaskConical } from "lucide-react";
import type { AlertRecord } from "@hermes/shared";
import { alertOutcome } from "../../lib/alert-view";
import { StatusPill } from "../../components/ui";

/** The outcome pill of an alert. A dry-run alert passed every check but was never sent, so it gets its own pill. */
export function OutcomePill({ alert }: { alert: AlertRecord }) {
  if (alert.status === "dry_run") {
    return (
      <StatusPill tone="accent" icon={FlaskConical} title="The strategy is in dry run: every check ran, nothing was sent to Perpl">
        Dry run
      </StatusPill>
    );
  }
  return <StatusPill kind={alertOutcome(alert).kind} />;
}
