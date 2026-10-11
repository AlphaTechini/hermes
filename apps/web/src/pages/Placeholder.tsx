import { Hammer } from "lucide-react";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/Feedback";
import { PageHeader, type Crumb } from "../components/shell/PageHeader";

/** Temporary body for screens that other engineers build. Replace the whole component, keep the <PageHeader>. */
export function Placeholder({ title, subtitle, crumbs, owner, documentTitle }: { title: string; subtitle: string; crumbs?: Crumb[]; owner: string; documentTitle?: string }) {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} crumbs={crumbs} documentTitle={documentTitle} />
      <Card>
        <EmptyState icon={Hammer} title="Not built yet">
          The {owner} screen goes here. The shell, data hooks and components it needs are already in place.
        </EmptyState>
      </Card>
    </>
  );
}
