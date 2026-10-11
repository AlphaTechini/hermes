import { cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  content: ReactNode;
  /** Delay before showing, ms. DESIGN.md: 300. */
  delay?: number;
  side?: "top" | "bottom";
  children: ReactElement<Record<string, unknown>>;
}

/**
 * `<Tooltip content="Copy"><button/></Tooltip>`. Dark-on-light inverse bubble, 12/16, appears after 300 ms on hover
 * or immediately on keyboard focus. The child keeps its own handlers; `aria-describedby` is added.
 */
export function Tooltip({ content, delay = 300, side = "top", children }: TooltipProps) {
  const id = useId();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);

  const show = useCallback(
    (el: Element, wait: number) => {
      clear();
      timer.current = setTimeout(() => {
        const r = el.getBoundingClientRect();
        setPos({ x: r.left + r.width / 2, y: side === "top" ? r.top : r.bottom });
      }, wait);
    },
    [side],
  );
  const hide = useCallback(() => {
    clear();
    setPos(null);
  }, []);

  if (!isValidElement(children) || content === null || content === undefined || content === "") return children;
  const p = children.props as Record<string, (e: unknown) => void>;
  const chain = (name: string, fn: (e: React.SyntheticEvent<Element>) => void) => (e: React.SyntheticEvent<Element>) => {
    p[name]?.(e);
    fn(e);
  };
  return (
    <>
      {cloneElement(children, {
        onMouseEnter: chain("onMouseEnter", (e) => show(e.currentTarget, delay)),
        onMouseLeave: chain("onMouseLeave", hide),
        onFocus: chain("onFocus", (e) => show(e.currentTarget, 0)),
        onBlur: chain("onBlur", hide),
        onClick: chain("onClick", hide),
        "aria-describedby": pos ? id : (children.props["aria-describedby"] as string | undefined),
      })}
      {pos &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            className="tip"
            style={{
              position: "fixed",
              zIndex: 80,
              left: Math.max(8, Math.min(pos.x, window.innerWidth - 8)),
              top: pos.y,
              transform: side === "top" ? "translate(-50%, calc(-100% - 6px))" : "translate(-50%, 6px)",
              pointerEvents: "none",
              maxWidth: "min(320px, calc(100vw - 16px))",
              whiteSpace: "normal",
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
