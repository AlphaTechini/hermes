import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

/** Class names defined by our own CSS (not tokens.css: its `.font-mono` deliberately mirrors the Tailwind utility). */
function ownClassNames(): string[] {
  const names = new Set<string>();
  for (const f of ["app.css", "components.css"]) {
    const css = readFileSync(path.join(here, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/url\([^)]*\)/g, "")
      .replace(/"[^"]*"/g, "");
    for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) names.add(m[1]!);
  }
  return [...names];
}

describe("component classes", () => {
  it("do not collide with Tailwind v4 utilities (a utility would win over the component class)", async () => {
    const { compile } = require("tailwindcss") as typeof import("tailwindcss");
    const load = async (id: string) => {
      const p = require.resolve(id);
      return { path: p, base: path.dirname(p), content: readFileSync(p, "utf8") };
    };
    const c = await compile('@layer theme, base, components, utilities;\n@import "tailwindcss/theme.css" layer(theme);\n@import "tailwindcss/utilities.css" layer(utilities);', { loadStylesheet: load });
    const names = ownClassNames();
    const out = c.build(names);
    const generated = new Set<string>();
    for (const m of out.matchAll(/^\s*\.((?:\\.|[\w-])+)\s*\{/gm)) generated.add(m[1]!.replace(/\\(.)/g, "$1"));
    expect(names.filter((n) => generated.has(n))).toEqual([]);
  });
});
