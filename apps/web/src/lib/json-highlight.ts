/**
 * Minimal JSON highlighter for CodeBlock (port of `hermesJson` in design/prototype/prototype.js).
 * Understands trailing `  // comments` and TradingView `{{placeholders}}`.
 * Token classes match `.hm-code` in components.css: k key, s string, n number, l literal, p punctuation, c comment, v placeholder.
 */
export type TokenClass = "k" | "s" | "n" | "l" | "p" | "c" | "v" | "";
export interface Token {
  cls: TokenClass;
  text: string;
}

const RE = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\b\d+(?:\.\d+)?\b)|\b(true|false|null)\b|([{}[\],:])/g;

function splitPlaceholders(str: string, cls: TokenClass): Token[] {
  const out: Token[] = [];
  let last = 0;
  for (const m of str.matchAll(/\{\{[^}]+\}\}/g)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ cls, text: str.slice(last, i) });
    out.push({ cls: "v", text: m[0] });
    last = i + m[0].length;
  }
  if (last < str.length) out.push({ cls, text: str.slice(last) });
  return out;
}

export function highlightJsonLine(line: string): Token[] {
  let rest = line;
  let comment = "";
  const ci = rest.indexOf("  //");
  if (ci >= 0) {
    comment = rest.slice(ci);
    rest = rest.slice(0, ci);
  }
  const tokens: Token[] = [];
  let last = 0;
  for (const m of rest.matchAll(RE)) {
    const i = m.index ?? 0;
    if (i > last) tokens.push({ cls: "", text: rest.slice(last, i) });
    const [whole, str, colon, num, lit, punct] = m;
    if (str) {
      if (colon) {
        tokens.push(...splitPlaceholders(str, "k"));
        tokens.push({ cls: "p", text: colon });
      } else tokens.push(...splitPlaceholders(str, "s"));
    } else if (num) tokens.push({ cls: "n", text: num });
    else if (lit) tokens.push({ cls: "l", text: lit });
    else tokens.push({ cls: "p", text: punct ?? whole });
    last = i + whole.length;
  }
  if (last < rest.length) tokens.push({ cls: "", text: rest.slice(last) });
  if (comment) tokens.push({ cls: "c", text: comment });
  return tokens;
}

export function highlightJson(source: string): Token[][] {
  return source.replace(/^\n/, "").split("\n").map(highlightJsonLine);
}

/** Pretty-prints a value (or parses and pretty-prints a JSON string); falls back to the raw text. */
export function prettyJson(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2) ?? "";
}
