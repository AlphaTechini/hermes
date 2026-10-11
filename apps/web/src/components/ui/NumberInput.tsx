import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Field } from "./Field";

export interface NumberInputProps {
  /** Controlled value. `null` = empty. */
  value: number | null;
  onValueChange: (value: number | null) => void;
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Muted prefix inside the field: `$`. */
  prefix?: ReactNode;
  /** Unit suffix inside the field: `bps`, `x`, `USD`, `per market`. */
  unit?: ReactNode;
  min?: number;
  max?: number;
  /** Arrow key step. Default 1. */
  step?: number;
  /** Fraction digits shown after blur. Default: as typed (max 8). */
  decimals?: number;
  size?: "md" | "lg";
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  name?: string;
  "aria-label"?: string;
  fieldClassName?: string;
  onBlur?: () => void;
  /** Right-side trailing node, e.g. a "Max" button. */
  trailing?: ReactNode;
  /** Extra class on the `.input` box (e.g. `is-focus` to show the focus ring statically). */
  boxClassName?: string;
}

const fmt = (n: number, decimals?: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: decimals ?? 8, minimumFractionDigits: decimals ?? 0, useGrouping: true }).format(n);

function parse(text: string): number | null {
  const t = text.replace(/[,\s]/g, "");
  if (t === "" || t === "-" || t === ".") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Mono numeric input with a unit suffix: `<NumberInput prefix="$" unit="per market" value={v} onValueChange={setV} />`.
 * Groups thousands on blur, accepts `25000` or `25,000`, ArrowUp/Down step, clamps to `min`/`max` on blur.
 */
export function NumberInput({
  value,
  onValueChange,
  label,
  hint,
  error,
  prefix,
  unit,
  min,
  max,
  step = 1,
  decimals,
  size = "md",
  placeholder,
  disabled,
  id,
  name,
  fieldClassName,
  onBlur,
  trailing,
  boxClassName,
  ...aria
}: NumberInputProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const [text, setText] = useState(value === null ? "" : fmt(value, decimals));
  const focused = useRef(false);

  // Follow external changes (reset, discard) unless the user is typing.
  useEffect(() => {
    if (focused.current) return;
    setText(value === null ? "" : fmt(value, decimals));
  }, [value, decimals]);

  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));

  return (
    <Field label={label} htmlFor={inputId} hint={hint} error={error} className={fieldClassName} hintId={`${inputId}-msg`}>
      <div className={cn("input mono-input", size === "lg" && "input-lg", error && "is-error", disabled && "is-disabled", boxClassName)}>
        {prefix !== undefined && <span className="affix">{prefix}</span>}
        <input
          id={inputId}
          name={name}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder={placeholder}
          disabled={disabled}
          value={text}
          aria-label={aria["aria-label"]}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? `${inputId}-msg` : undefined}
          onFocus={() => {
            focused.current = true;
          }}
          onChange={(e) => {
            const raw = e.target.value;
            if (!/^-?[\d,]*\.?\d*$/.test(raw)) return;
            setText(raw);
            onValueChange(parse(raw));
          }}
          onKeyDown={(e) => {
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            const next = clamp((value ?? 0) + (e.key === "ArrowUp" ? step : -step));
            setText(fmt(next, decimals));
            onValueChange(next);
          }}
          onBlur={() => {
            focused.current = false;
            const n = parse(text);
            if (n === null) {
              setText("");
            } else {
              const c = clamp(n);
              if (c !== n) onValueChange(c);
              setText(fmt(c, decimals));
            }
            onBlur?.();
          }}
        />
        {unit !== undefined && <span className="affix">{unit}</span>}
        {trailing}
      </div>
    </Field>
  );
}
