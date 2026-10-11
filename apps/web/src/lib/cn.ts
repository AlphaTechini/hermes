export type ClassValue = string | number | false | null | undefined | ClassValue[];

/** Tiny class joiner: cn("btn", active && "is-active", ["a", "b"]). Falsy values are dropped. */
export function cn(...values: ClassValue[]): string {
  const out: string[] = [];
  for (const v of values) {
    if (!v && v !== 0) continue;
    if (Array.isArray(v)) {
      const inner = cn(...v);
      if (inner) out.push(inner);
    } else out.push(String(v));
  }
  return out.join(" ");
}
