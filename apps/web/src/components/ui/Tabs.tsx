import { useRef, type ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface TabItem<T extends string = string> {
  value: T;
  label: ReactNode;
  count?: number | string;
  disabled?: boolean;
}

export interface TabsProps<T extends string = string> {
  value: T;
  onChange: (value: T) => void;
  tabs: TabItem<T>[];
  "aria-label": string;
  /** Remove the 16px side padding (when the tabs sit in a padded card body). */
  flush?: boolean;
  className?: string;
  /** Id prefix for `aria-controls`; panels should use `${idBase}-panel-${value}`. */
  idBase?: string;
}

/**
 * Underline tabs: 40 high, gap 20, selected text with a 2px `--text` underline. Arrow keys move selection.
 * Horizontally scrollable without a scrollbar on mobile.
 */
export function Tabs<T extends string = string>({ value, onChange, tabs, flush, className, idBase, ...aria }: TabsProps<T>) {
  const ref = useRef<HTMLDivElement | null>(null);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const enabled = tabs.filter((t) => !t.disabled);
    const i = enabled.findIndex((t) => t.value === value);
    const next = enabled[(i + (e.key === "ArrowRight" ? 1 : enabled.length - 1)) % enabled.length];
    if (next) {
      onChange(next.value);
      requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
    }
  };
  return (
    <div ref={ref} className={cn("tabs", className)} style={flush ? { padding: 0 } : undefined} role="tablist" aria-label={aria["aria-label"]} onKeyDown={onKey}>
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          id={idBase ? `${idBase}-tab-${t.value}` : undefined}
          aria-controls={idBase ? `${idBase}-panel-${t.value}` : undefined}
          aria-selected={t.value === value}
          tabIndex={t.value === value ? 0 : -1}
          disabled={t.disabled}
          className="tab"
          onClick={() => onChange(t.value)}
        >
          {t.label}
          {t.count !== undefined && <span className="c">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
