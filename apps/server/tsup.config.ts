import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // @hermes/shared and @hermes/perpl are exported as TS source, so bundle them in (their npm deps stay external).
  noExternal: ["@hermes/shared", "@hermes/perpl"],
  external: ["better-sqlite3"],
});
