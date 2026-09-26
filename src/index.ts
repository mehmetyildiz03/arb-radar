import { loadConfig } from "./config.js";
import { ParIndexerClient } from "./adapters/parIndexer.js";
import { observeLaunch } from "./paper/engine.js";

const config = loadConfig();
const indexer = new ParIndexerClient(config.parApiBase);

async function tick(): Promise<void> {
  const launches = await indexer.latestLaunches(100);
  const observations = launches.flatMap((launch) => observeLaunch(launch));

  const top = observations
    .sort((a, b) => b.feeAdjustedReturnPct - a.feeAdjustedReturnPct)
    .slice(0, 10);

  console.log(JSON.stringify({
    at: new Date().toISOString(),
    multiLaunches: launches.length,
    feeFloorCandidates: observations.length,
    top,
  }, null, 2));
}

async function main(): Promise<void> {
  console.log("arb-radar v0.1 — PAPER ONLY; no wallet, signer or execution path loaded");
  await tick();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
