import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange" | "size"> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  label?: ReactNode;
  /** `sm` 13px body text, `xs` 12px secondary (inline hints). */
  size?: "sm" | "xs";
}

/** 16x16, radius 4. `<Checkbox checked={v} onCheckedChange={setV} label="Dry run" />` */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({ checked, onCheckedChange, label, size = "sm", className, ...rest }, ref) {
  return (
    <label className={cn("check", size === "sm" ? "sm" : "xs secondary", className)}>
      <input ref={ref} type="checkbox" checked={checked} onChange={(e) => onCheckedChange?.(e.target.checked)} {...rest} />
      {label}
    </label>
  );
});
