import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface ToggleProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange" | "size"> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** 12px secondary label. */
  label?: ReactNode;
  labelSide?: "left" | "right";
  /** `positive` is the global Trading switch (green when on). Default is the accent. */
  tone?: "accent" | "positive";
}

/**
 * Switch: track 30x18, knob 14. `<Toggle checked={on} onCheckedChange={setOn} label="Enabled" />`.
 * Always pass `label` or `aria-label`.
 */
export const Toggle = forwardRef<HTMLInputElement, ToggleProps>(function Toggle(
  { checked, onCheckedChange, label, labelSide = "right", tone = "accent", className, onClick, ...rest },
  ref,
) {
  return (
    <label className={cn("toggle", tone === "positive" && "positive", className)} onClick={(e) => e.stopPropagation()}>
      {label !== undefined && labelSide === "left" && <span>{label}</span>}
      <input ref={ref} type="checkbox" role="switch" checked={checked} onChange={(e) => onCheckedChange?.(e.target.checked)} onClick={onClick} {...rest} />
      <span className="track" />
      {label !== undefined && labelSide === "right" && <span>{label}</span>}
    </label>
  );
});
