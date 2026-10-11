import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: ReactNode;
  /** Mono count after the label (outcome filters: `Filled 41`). */
  count?: number | string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string = string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  /** Required: describes the group for screen readers. */
  "aria-label": string;
  /** `sm` is the 28px variant used in code block heads. */
  size?: "md" | "sm";
  className?: string;
}

/** Track 32, items 26, selected `bg-active` with a 1px ring. Used for outcome filters, time ranges, size mode. */
export function SegmentedControl<T extends string = string>({ value, onChange, options, size = "md", className, ...aria }: SegmentedControlProps<T>) {
  return (
    <div className={cn("seg", className)} role="group" aria-label={aria["aria-label"]} style={size === "sm" ? { height: 28 } : undefined}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          disabled={o.disabled}
          style={size === "sm" ? { height: 22 } : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count !== undefined && <span className="c">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}
