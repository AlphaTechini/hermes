import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // @hermes/shared is exported as TS source, so bundle it in.
  noExternal: ["@hermes/shared"],
  external: ["better-sqlite3"],
});
