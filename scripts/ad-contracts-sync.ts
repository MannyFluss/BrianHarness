// Writes packages/core/src/ad-contracts/examples/*.json from examples.ts and publishes the contracts folder to
// /workspace/actor-director/contracts (or $AD_CONTRACTS_OUT). The contracts test fails if the JSON drifts.
//   npx tsx scripts/ad-contracts-sync.ts [--publish]
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exampleFiles } from "../packages/core/test/ad-contracts-examples.ts";

const dir = join(import.meta.dirname, "..", "packages/core/src/ad-contracts");
mkdirSync(join(dir, "examples"), { recursive: true });
for (const [name, { value }] of Object.entries(exampleFiles())) writeFileSync(join(dir, "examples", name + ".json"), JSON.stringify(value, null, 2) + "\n");
console.log("examples written:", Object.keys(exampleFiles()).length);
if (process.argv.includes("--publish")) {
  const out = process.env.AD_CONTRACTS_OUT ?? "/workspace/actor-director/contracts";
  rmSync(out, { recursive: true, force: true });
  cpSync(dir, out, { recursive: true });
  console.log("published to", out);
}
