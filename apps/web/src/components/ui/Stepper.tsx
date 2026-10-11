import { Check } from "lucide-react";
import type { ReactNode } from "react";

export interface StepperStep {
  title: ReactNode;
  description?: ReactNode;
}

/**
 * Vertical onboarding stepper, 240 wide, sticky (`position: sticky; top: 48px`). Current step: `--text` ring with a 3px halo.
 * Done: filled with a check. Below 860px it becomes a 4-segment horizontal progress bar with titles.
 * `current` is 1-based.
 */
export function Stepper({ steps, current, "aria-label": label = "Setup steps" }: { steps: StepperStep[]; current: number; "aria-label"?: string }) {
  return (
    <ol className="stepper" aria-label={label}>
      {steps.map((s, i) => {
        const n = i + 1;
        const state = n < current ? "done" : n === current ? "current" : "upcoming";
        return (
          <li key={n} data-n={n} data-state={state} aria-current={state === "current" ? "step" : undefined}>
            <span className="dot">
              <span>{n}</span>
              <Check aria-hidden />
            </span>
            <div>
              <div className="t">{s.title}</div>
              {s.description && <div className="d">{s.description}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
