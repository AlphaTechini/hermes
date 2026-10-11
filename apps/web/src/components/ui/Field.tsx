import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

interface FieldProps {
  label?: ReactNode;
  /** `id` of the control, for the label's `htmlFor`. */
  htmlFor?: string;
  hint?: ReactNode;
  /** Error message below the control (12px, circle-alert icon). The control itself should get `error` too. */
  error?: ReactNode;
  /** Optional element after the label (e.g. a changed-dot or a link). */
  labelExtra?: ReactNode;
  className?: string;
  children: ReactNode;
  hintId?: string;
}

/** Label (12/500 secondary) above, control, then hint (12 muted) or error below. Gap 6. */
export function Field({ label, htmlFor, hint, error, labelExtra, className, children, hintId }: FieldProps) {
  return (
    <div className={cn("field", className)}>
      {label !== undefined && (
        <label className="label" htmlFor={htmlFor}>
          {label}
          {labelExtra}
        </label>
      )}
      {children}
      {error ? (
        <span className="field-error" id={hintId} role="alert">
          <CircleAlert className="i-12" aria-hidden />
          {error}
        </span>
      ) : hint ? (
        <span className="hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
