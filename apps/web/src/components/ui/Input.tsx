import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import { Field } from "./Field";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "prefix"> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** `md` 32 high, `lg` 40 high with radius 8 and 14px text. */
  size?: "md" | "lg";
  /** Mono variant (12px Geist Mono) for numbers, keys, ids. */
  mono?: boolean;
  /** Leading icon (14px, muted). */
  icon?: LucideIcon;
  /** Muted 12px affix before the value: `$`. */
  prefix?: ReactNode;
  /** Muted 12px affix after the value: `bps`, `x`, `per market`, `USD`. */
  suffix?: ReactNode;
  /** Right-side controls inside the field (small ghost buttons). */
  trailing?: ReactNode;
  /** Wrapper class on the `.field` element. */
  fieldClassName?: string;
  /** Class on the `.input` box. */
  boxClassName?: string;
}

/**
 * Text input in the prototype's `.input` box. Focus ring is on the box (`:focus-within`), error shows a red ring and
 * a message below.
 *   <Input label="Name" placeholder="Strategy name" />
 *   <Input mono prefix="$" suffix="per market" defaultValue="25,000" />
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, size = "md", mono, icon: Icon, prefix, suffix, trailing, fieldClassName, boxClassName, className, id, disabled, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  const msgId = `${inputId}-msg`;
  return (
    <Field label={label} htmlFor={inputId} hint={hint} error={error} className={fieldClassName} hintId={msgId}>
      <div className={cn("input", mono && "mono-input", size === "lg" && "input-lg", error && "is-error", disabled && "is-disabled", boxClassName)}>
        {Icon && <Icon aria-hidden />}
        {prefix !== undefined && <span className="affix">{prefix}</span>}
        <input
          ref={ref}
          id={inputId}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? msgId : undefined}
          className={className}
          {...rest}
        />
        {suffix !== undefined && <span className="affix">{suffix}</span>}
        {trailing}
      </div>
    </Field>
  );
});
