import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "../../lib/cn";
import { Field } from "./Field";
import { Popover } from "./Popover";
import { MarketChip } from "./Badges";

export interface SelectOption<T extends string = string> {
  value: T;
  label: ReactNode;
  /** Text label for the trigger when it differs from `label`. */
  triggerLabel?: ReactNode;
  /** Shows a market chip (`BTC`) before the label. */
  market?: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string = string> {
  value: T | null | undefined;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  placeholder?: string;
  /** `field` is the form control (`.input.select`); `button` looks like a secondary button ("All strategies"). */
  variant?: "field" | "button";
  size?: "md" | "lg" | "sm";
  disabled?: boolean;
  id?: string;
  className?: string;
  fieldClassName?: string;
  "aria-label"?: string;
}

/**
 * Popover list select (items 32 high, radius 6, shadow-2). Keyboard: ArrowUp/Down, Home/End, Enter/Space, Escape,
 * type-ahead. An option may carry a market chip.
 *   <Select label="Market" value={m} onChange={setM} options={[{ value: "BTC", label: "BTC", market: "BTC" }]} />
 */
export function Select<T extends string = string>({
  value,
  onChange,
  options,
  label,
  hint,
  error,
  placeholder = "Select",
  variant = "field",
  size = "md",
  disabled,
  id,
  className,
  fieldClassName,
  ...aria
}: SelectProps<T>) {
  const auto = useId();
  const selectId = id ?? auto;
  const listId = `${selectId}-list`;
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const typed = useRef({ s: "", t: 0 });

  const selected = options.find((o) => o.value === value);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (open) setActive(Math.max(0, options.findIndex((o) => o.value === value)));
  }, [open, options, value]);

  const move = (dir: 1 | -1, from = active) => {
    let i = from;
    for (let n = 0; n < options.length; n++) {
      i = (i + dir + options.length) % options.length;
      if (!options[i]?.disabled) return i;
    }
    return from;
  };
  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    setOpen(false);
    trigger.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => move(1, a)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => move(-1, a)));
    else if (e.key === "Home") (e.preventDefault(), setActive(move(1, -1)));
    else if (e.key === "End") (e.preventDefault(), setActive(move(-1, 0)));
    else if (e.key === "Enter" || e.key === " ") (e.preventDefault(), choose(active));
    else if (e.key === "Tab") setOpen(false);
    else if (e.key.length === 1) {
      const now = Date.now();
      typed.current.s = now - typed.current.t > 600 ? e.key.toLowerCase() : typed.current.s + e.key.toLowerCase();
      typed.current.t = now;
      const i = options.findIndex((o) => !o.disabled && String(typeof o.label === "string" ? o.label : o.value).toLowerCase().startsWith(typed.current.s));
      if (i >= 0) setActive(i);
    }
  };

  const display = selected ? (
    <>
      {selected.market && <MarketChip market={selected.market} />}
      <span className="val">{selected.triggerLabel ?? selected.label}</span>
    </>
  ) : (
    <span className="val" style={{ color: "var(--text-faint)" }}>
      {placeholder}
    </span>
  );

  const triggerProps = {
    ref: trigger,
    id: selectId,
    type: "button" as const,
    role: "combobox" as const,
    "aria-haspopup": "listbox" as const,
    "aria-expanded": open,
    "aria-controls": open ? listId : undefined,
    "aria-activedescendant": open && active >= 0 ? `${selectId}-opt-${active}` : undefined,
    "aria-label": aria["aria-label"],
    "aria-invalid": error ? true : undefined,
    disabled,
    onClick: () => setOpen((o) => !o),
    onKeyDown,
  };

  const control =
    variant === "button" ? (
      <button {...triggerProps} className={cn("btn btn-secondary select", size === "sm" && "btn-sm", size === "lg" && "btn-lg", className)}>
        {selected?.market && <MarketChip market={selected.market} />}
        <span>{selected ? (selected.triggerLabel ?? selected.label) : placeholder}</span>
      </button>
    ) : (
      <button
        {...triggerProps}
        className={cn("input select", size === "lg" && "input-lg", error && "is-error", disabled && "is-disabled", className)}
        style={{ textAlign: "left", width: "100%" }}
      >
        {display}
      </button>
    );

  const list = (
    <Popover open={open} onClose={close} anchorRef={trigger} matchWidth id={listId} role="listbox">
      {options.map((o, i) => (
        <div
          key={o.value}
          id={`${selectId}-opt-${i}`}
          role="option"
          aria-selected={o.value === value}
          aria-disabled={o.disabled || undefined}
          className={cn("menu-item", o.value === value && "is-selected")}
          data-active={i === active || undefined}
          style={{ cursor: o.disabled ? "not-allowed" : "pointer", opacity: o.disabled ? 0.45 : undefined }}
          onMouseEnter={() => !o.disabled && setActive(i)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => choose(i)}
        >
          {o.market && <MarketChip market={o.market} />}
          <span className="hm-truncate" style={{ flex: "1 1 auto" }}>
            {o.label}
          </span>
          {o.value === value && <Check aria-hidden />}
        </div>
      ))}
    </Popover>
  );

  if (variant === "button") {
    return (
      <>
        {control}
        {list}
      </>
    );
  }
  return (
    <Field label={label} htmlFor={selectId} hint={hint} error={error} className={fieldClassName} hintId={`${selectId}-msg`}>
      {control}
      {list}
    </Field>
  );
}
