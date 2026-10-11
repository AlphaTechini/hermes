import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Copies text to the clipboard (with a textarea fallback) and flips `copied` for `resetMs`. */
export function useCopy(resetMs = 1400) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.setAttribute("readonly", "");
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        } catch {
          /* clipboard unavailable */
        }
      }
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), resetMs);
    },
    [resetMs],
  );
  return { copied, copy };
}

/** Measures an element's content-box width with a ResizeObserver. Charts render at this pixel width. */
export function useContainerWidth<T extends HTMLElement>(initial = 0): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(Math.floor(el.getBoundingClientRect().width));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => read());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Skeletons only show after `delay` ms of loading (DESIGN.md: 200 ms) and never on live updates. */
export function useDelayedFlag(active: boolean, delay = 200): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!active) {
      setOn(false);
      return;
    }
    const t = setTimeout(() => setOn(true), delay);
    return () => clearTimeout(t);
  }, [active, delay]);
  return on;
}

/** Calls `handler` on mousedown/touchstart outside every ref in `refs` while `active`. */
export function useOutsideClick(refs: RefObject<HTMLElement | null>[], handler: () => void, active: boolean) {
  const h = useRef(handler);
  h.current = handler;
  useEffect(() => {
    if (!active) return;
    const on = (e: Event) => {
      const t = e.target as Node;
      if (refs.some((r) => r.current?.contains(t))) return;
      h.current();
    };
    document.addEventListener("mousedown", on);
    document.addEventListener("touchstart", on);
    return () => {
      document.removeEventListener("mousedown", on);
      document.removeEventListener("touchstart", on);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Dialog behavior: Escape closes, Tab is trapped inside, body scroll is locked, focus returns on close. */
export function useDialog(open: boolean, onClose: () => void, ref: RefObject<HTMLElement | null>) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector<HTMLElement>(FOCUSABLE) ?? el;
    first?.focus({ preventScroll: true });
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close.current();
      } else if (e.key === "Tab" && el) {
        const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (!items.length) return;
        const f = items[0]!;
        const l = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === f) {
          e.preventDefault();
          l.focus();
        } else if (!e.shiftKey && document.activeElement === l) {
          e.preventDefault();
          f.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.({ preventScroll: true });
    };
  }, [open, ref]);
}
