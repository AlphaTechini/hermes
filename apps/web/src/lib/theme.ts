import { useCallback, useSyncExternalStore } from "react";

export type Theme = "dark" | "light";
export const THEME_KEY = "hermes-theme";

/** The inline script in index.html applied the theme before React mounted; this reads it back. */
export function getTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function setTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* private mode or blocked storage: the choice just does not persist */
  }
}

function subscribe(cb: () => void): () => void {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => mo.disconnect();
}

/** `const { theme, toggle, setTheme } = useTheme()` */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getTheme, () => "dark" as Theme);
  const toggle = useCallback(() => setTheme(getTheme() === "light" ? "dark" : "light"), []);
  return { theme, toggle, setTheme };
}
