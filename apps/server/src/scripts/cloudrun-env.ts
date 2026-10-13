/**
 * Fills `.env.cloudrun.yaml` (repo root, git-ignored) for the Cloud Run deploy without printing any secret.
 * Run: `pnpm --filter @hermes/server cloudrun:env`
 *
 *   1. loads PRIVY_APP_ID / PRIVY_APP_SECRET from the repo-root `.env` or `apps/server/.env`,
 *   2. runs the Privy bootstrap once (skipped when the yaml already has a policy id, so re-runs never create duplicates),
 *   3. generates HERMES_MASTER_KEY if it is empty,
 *   4. writes the values into the yaml and prints only the names it filled.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.resolve(serverDir, "../..");
const yamlPath = path.join(repoRoot, ".env.cloudrun.yaml");

const BOOTSTRAP_KEYS = [
  "PRIVY_AUTHORIZATION_PRIVATE_KEY",
  "PRIVY_KEY_QUORUM_ID",
  "PRIVY_POLICY_ID",
  "PRIVY_POLICY_EXPIRES_AT",
  "PRIVY_APPROVE_CAP",
];

function readYaml(): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of readFileSync(yamlPath, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+):\s*"(.*)"\s*$/.exec(line);
    if (m) values.set(m[1]!, JSON.parse(`"${m[2]}"`) as string);
  }
  return values;
}

function writeYaml(updates: Map<string, string>): void {
  const lines = readFileSync(yamlPath, "utf8").split(/\r?\n/);
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const m = /^([A-Z0-9_]+):/.exec(line);
    if (m && updates.has(m[1]!)) {
      seen.add(m[1]!);
      return `${m[1]}: ${JSON.stringify(updates.get(m[1]!))}`;
    }
    return line;
  });
  for (const [k, v] of updates) if (!seen.has(k)) out.push(`${k}: ${JSON.stringify(v)}`);
  writeFileSync(yamlPath, out.join("\n"), { mode: 0o600 });
}

function main() {
  if (!existsSync(yamlPath)) throw new Error(`Missing ${yamlPath}`);
  for (const f of [path.join(repoRoot, ".env"), path.join(serverDir, ".env")]) {
    if (existsSync(f)) process.loadEnvFile(f);
  }

  const current = readYaml();
  const updates = new Map<string, string>();

  for (const k of ["PRIVY_APP_ID", "PRIVY_APP_SECRET"]) {
    const v = current.get(k) || process.env[k];
    if (!v) throw new Error(`${k} is not set in .env or ${path.basename(yamlPath)}`);
    if (!current.get(k)) updates.set(k, v);
  }

  if (current.get("PRIVY_POLICY_ID")) {
    console.log("Privy bootstrap skipped: the yaml already has PRIVY_POLICY_ID.");
  } else {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", "src/privy/bootstrap.ts"], {
      cwd: serverDir,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    for (const line of stdout.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && BOOTSTRAP_KEYS.includes(m[1]!)) updates.set(m[1]!, m[2]!);
    }
    const missing = BOOTSTRAP_KEYS.filter((k) => !updates.has(k));
    if (missing.length) throw new Error(`Bootstrap output did not include: ${missing.join(", ")}`);
  }

  if (!/^[0-9a-fA-F]{64}$/.test(current.get("HERMES_MASTER_KEY") ?? "")) {
    updates.set("HERMES_MASTER_KEY", randomBytes(32).toString("hex"));
  }

  if (updates.size) writeYaml(updates);
  console.log(`Filled in ${path.basename(yamlPath)}: ${[...updates.keys()].join(", ") || "nothing (already complete)"}`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
