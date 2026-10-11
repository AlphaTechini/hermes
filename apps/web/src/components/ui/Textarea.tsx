import { forwardRef, useId, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { Field } from "./Field";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  mono?: boolean;
  fieldClassName?: string;
}

/** Same box as Input, multi-line. `<Textarea label="Notes" rows={3} />` */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, mono, fieldClassName, className, id, disabled, rows = 3, ...rest },
  ref,
) {
  const auto = useId();
  const tid = id ?? auto;
  return (
    <Field label={label} htmlFor={tid} hint={hint} error={error} className={fieldClassName} hintId={`${tid}-msg`}>
      <div className={cn("input textarea", mono && "mono-input", error && "is-error", disabled && "is-disabled")}>
        <textarea
          ref={ref}
          id={tid}
          rows={rows}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? `${tid}-msg` : undefined}
          className={className}
          {...rest}
        />
      </div>
    </Field>
  );
});
