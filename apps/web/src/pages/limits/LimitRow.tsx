import type { ReactNode } from "react";

/** One row of the Limits card: label and explanation (300) | control (280) | live usage (rest). */
export function LimitRow({ label, changed, description, control, usage, wide }: { label: ReactNode; changed?: boolean; description: ReactNode; control: ReactNode; usage?: ReactNode; wide?: boolean }) {
  return (
    <div className="set-row">
      <div className="lbl">
        <h3>
          {label}
          {changed && <span className="changed-dot" title="Unsaved change" aria-label="Unsaved change" />}
        </h3>
        <p>{description}</p>
      </div>
      {wide ? <div className="wide col g3">{control}</div> : control}
      {usage}
    </div>
  );
}

/** Usage column header line: label left, mono value right. */
export function UsageHead({ label, value }: { label: ReactNode; value?: ReactNode }) {
  return (
    <div className="head">
      <span>{label}</span>
      {value !== undefined && <span className="v">{value}</span>}
    </div>
  );
}
