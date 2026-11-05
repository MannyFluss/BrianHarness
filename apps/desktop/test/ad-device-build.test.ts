// contract-v1.3 (ruling B2): a device build has no path to a native plugin's lookAt; a simulator build (AD_SIM_BUILD=1)
// keeps the aid. Builds the real AD web bundle both ways (vite.ad.config.ts) and runs tools/ad/check_device_build.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const app = join(import.meta.dirname, "..");
const check = join(app, "../../tools/ad/check_device_build.mjs");
const build = (out: string, sim: boolean) => {
  const env = { ...process.env, AD_DEMO_BUNDLE: "", AD_SIM_BUILD: sim ? "1" : "" };
  const r = spawnSync(process.execPath, [join(app, "../../node_modules/vite/bin/vite.js"), "build", "--config", "vite.ad.config.ts", "--outDir", out, "--emptyOutDir", "--logLevel", "error"], { cwd: app, encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
};

test("B2: lookAt is stripped from a device build and present only in a simulator build", () => {
  const dir = mkdtempSync(join(tmpdir(), "adb-"));
  build(join(dir, "device"), false);
  const dev = spawnSync(process.execPath, [check, join(dir, "device")], { encoding: "utf8" });
  assert.equal(dev.status, 0, dev.stdout + dev.stderr);
  assert.match(dev.stdout, /ok: no lookAt path in the device bundle/);
  build(join(dir, "sim"), true);
  const sim = spawnSync(process.execPath, [check, join(dir, "sim"), "--expect-sim"], { encoding: "utf8" });
  assert.equal(sim.status, 0, sim.stdout);
  // and the scanner flags it when pointed at the simulator bundle as if it were a device bundle
  const neg = spawnSync(process.execPath, [check, join(dir, "sim")], { encoding: "utf8" });
  assert.equal(neg.status, 1); assert.match(neg.stdout, /DEVICE-LEAK .*lookAt call/);
  assert.match(neg.stdout, /DEVICE-LEAK .*sim-look module \(SIM_LOOK_AID\)/, "v1.4: the sim-look marker is in a sim build and caught");
  assert.match(sim.stdout, /SIM .*lookAt\?\.\(\{/, "v1.4: the sim bundle calls lookAt with one options object");
});
