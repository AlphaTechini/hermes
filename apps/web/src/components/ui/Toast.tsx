import { CircleCheck, CircleX, Hand, OctagonX, X, type LucideIcon } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { cn } from "../../lib/cn";

export type ToastTone = "positive" | "negative" | "warning" | "accent";

export interface ToastAction {
  label: string;
  /** Router path. */
  to?: string;
  onClick?: () => void;
}

export interface ToastInput {
  tone?: ToastTone;
  title: ReactNode;
  body?: ReactNode;
  icon?: LucideIcon;
  actions?: ToastAction[];
  /** ms until auto-dismiss. Default 4000. Negative toasts stay until dismissed unless you set this. 0 = sticky. */
  duration?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

const DEFAULT_ICON: Record<ToastTone, LucideIcon> = { positive: CircleCheck, negative: CircleX, warning: OctagonX, accent: Hand };
const MAX = 3;

interface ToastApi {
  /** `toast({ tone: "positive", title: "Limits saved", body: "They apply from the next alert." })` */
  (t: ToastInput): number;
  positive: (title: ReactNode, body?: ReactNode, rest?: Partial<ToastInput>) => number;
  negative: (title: ReactNode, body?: ReactNode, rest?: Partial<ToastInput>) => number;
  warning: (title: ReactNode, body?: ReactNode, rest?: Partial<ToastInput>) => number;
  accent: (title: ReactNode, body?: ReactNode, rest?: Partial<ToastInput>) => number;
  dismiss: (id: number) => void;
}

const Ctx = createContext<ToastApi | null>(null);

/** Static toast (used by the gallery and by the viewport). */
export function ToastView({ tone = "positive", title, body, icon, actions, onDismiss, className }: ToastInput & { onDismiss?: () => void; className?: string }) {
  const Icon = icon ?? DEFAULT_ICON[tone];
  return (
    <div className={cn("toast", tone, className)} role={tone === "negative" ? "alert" : "status"}>
      <Icon aria-hidden />
      <div>
        <div className="tt">{title}</div>
        {body && <div className="tb">{body}</div>}
        {actions && actions.length > 0 && (
          <div className="ta">
            {actions.map((a) =>
              a.to ? (
                <Link key={a.label} className="link" to={a.to} onClick={() => { a.onClick?.(); onDismiss?.(); }}>
                  {a.label}
                </Link>
              ) : (
                <button key={a.label} className="link" style={{ background: "none", border: 0, padding: 0, font: "inherit" }} onClick={() => { a.onClick?.(); onDismiss?.(); }}>
                  {a.label}
                </button>
              ),
            )}
          </div>
        )}
      </div>
      <button className="x" aria-label="Dismiss" onClick={onDismiss}>
        <X aria-hidden />
      </button>
    </div>
  );
}

function ToastTimer({ item, dismiss }: { item: ToastItem; dismiss: (id: number) => void }) {
  const onDone = useCallback(() => dismiss(item.id), [dismiss, item.id]);
  const duration = item.duration ?? (item.tone === "negative" ? 0 : 4000);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!duration || paused) return;
    const t = setTimeout(onDone, duration);
    return () => clearTimeout(t);
  }, [duration, paused, onDone]);
  return (
    <div onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <ToastView {...item} onDismiss={onDone} />
    </div>
  );
}

/**
 * Mount once near the root (main.tsx does). Bottom right, 20 from the edges, 360 wide, newest at the bottom, max 3.
 * Auto-dismiss after 4 s; errors stay until dismissed. Hover pauses.
 *
 *   const toast = useToast();
 *   toast.positive("Limits saved", "They apply from the next alert.");
 *   toast.negative("Could not save limits", "The server did not answer. Your changes are still here.", { actions: [{ label: "Try again", onClick: retry }] });
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);

  const api = useMemo<ToastApi>(() => {
    const push = (t: ToastInput) => {
      const id = nextId.current++;
      setItems((l) => [...l, { ...t, id }].slice(-MAX));
      return id;
    };
    const fn = ((t: ToastInput) => push(t)) as ToastApi;
    fn.positive = (title, body, rest) => push({ tone: "positive", title, body, ...rest });
    fn.negative = (title, body, rest) => push({ tone: "negative", title, body, ...rest });
    fn.warning = (title, body, rest) => push({ tone: "warning", title, body, ...rest });
    fn.accent = (title, body, rest) => push({ tone: "accent", title, body, ...rest });
    fn.dismiss = dismiss;
    return fn;
  }, [dismiss]);

  return (
    <Ctx.Provider value={api}>
      {children}
      {typeof document !== "undefined" &&
        createPortal(
          <div className="toasts" aria-live="polite">
            {items.map((t) => (
              <ToastTimer key={t.id} item={t} dismiss={dismiss} />
            ))}
          </div>,
          document.body,
        )}
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useToast must be used inside <ToastProvider>");
  return v;
}
