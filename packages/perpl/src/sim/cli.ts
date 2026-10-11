/**
 * `pnpm --filter @hermes/perpl sim [--port 8787] [--seed 1] [--vol 1] [--balance 10000] [--keys 1]`
 *
 * Starts the Perpl simulator and prints the URLs plus freshly enrolled demo API keys. Point the Hermes server at it with
 * PERPL_MODE=live-style settings: REST = the printed `url`, WS = the printed `wsUrl`.
 */
import { startPerplSimulator } from "./server";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[`PERPL_SIM_${name.toUpperCase()}`] ?? fallback;
}

const port = Number(arg("port", "8787"));
const seed = arg("seed");
const vol = Number(arg("vol", "1"));
const balance = Number(arg("balance", "10000"));
const keys = Math.max(1, Number(arg("keys", "1")));

const sim = await startPerplSimulator({
  port,
  host: arg("host", "127.0.0.1") as string,
  volMultiplier: vol,
  defaultBalanceAusd: balance,
  ...(seed !== undefined ? { seed: Number(seed) } : {}),
});

console.log(`Perpl simulator listening
  REST  ${sim.url}            (PERPL_REST_URL)
  WS    ${sim.wsUrl}          (PERPL_WS_URL)
  chain ${sim.chainId}
`);
for (let i = 0; i < keys; i++) {
  const k = sim.enrollNewKey({ balanceAusd: balance });
  console.log(`demo key #${i + 1}: account ${k.accountId}
  PERPL_API_KEY=${k.apiKey}
  PERPL_API_KEY_SECRET=${k.apiSecret}
`);
}
console.log("Prices (GBM): " + ["BTC", "ETH", "SOL", "MON", "ZEC"].map((s) => `${s} ${sim.getPrice(s)}`).join("  "));

const stop = async (): Promise<void> => {
  await sim.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
