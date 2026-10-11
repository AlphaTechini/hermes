import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { useOutsideClick } from "./hooks";

export type Placement = "bottom-start" | "bottom-end" | "top-start" | "top-end";

interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** Element the popover is anchored to. */
  anchorRef: RefObject<HTMLElement | null>;
  placement?: Placement;
  /** Match the anchor's width (Select) instead of using min-width 200. */
  matchWidth?: boolean;
  className?: string;
  style?: CSSProperties;
  role?: string;
  id?: string;
  children: ReactNode;
}

/**
 * Floating panel (`.popover`: raised, shadow-2, radius 10, padding 4). Rendered in a portal, positioned with
 * fixed coordinates under (or over) the anchor, closed by Escape or an outside click.
 */
export function Popover({ open, onClose, anchorRef, placement = "bottom-start", matchWidth, className, style, role, id, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; flip: boolean } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      if (!a) return;
      const h = ref.current?.offsetHeight ?? 0;
      const w = ref.current?.offsetWidth ?? 0;
      const wantTop = placement.startsWith("top");
      const below = window.innerHeight - a.bottom;
      const flip = wantTop ? a.top >= h + 8 || a.top > below : below < h + 8 && a.top > below;
      const top = flip ? a.top - h - 6 : a.bottom + 6;
      let left = placement.endsWith("end") ? a.right - Math.max(w, matchWidth ? a.width : 0) : a.left;
      left = Math.max(8, Math.min(left, window.innerWidth - Math.max(w, a.width) - 8));
      setPos({ top, left, width: a.width, flip });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchorRef, placement, matchWidth, children]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useOutsideClick([ref, anchorRef], onClose, open);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      id={id}
      role={role}
      className={cn("popover", className)}
      style={{
        position: "fixed",
        zIndex: 70,
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        ...(matchWidth && pos ? { minWidth: pos.width, width: "max-content", maxWidth: "min(480px, calc(100vw - 16px))" } : null),
        ...style,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
