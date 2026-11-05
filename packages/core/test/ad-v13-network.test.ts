/** contract-v1.3 (ruling C): network.workerBlocked as a health code; a request past the block FAILS the pilot preflight. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DIRECTOR_BLOCKING, PILOT_FAILING, Preflight, healthWords, networkIsolationProbe, networkIsolationResult } from "../src/actor-director/index.ts";
import type { HealthLine } from "../src/actor-director/index.ts";

test("C: worker-blocked only -> informational ok line (net.worker_blocked); the pilot passes", async () => {
  assert.deepEqual(networkIsolationResult({ workerBlocked: [], requests: [] }), { ok: true });
  const r = networkIsolationResult({ workerBlocked: ["https://storage.googleapis.com/mediapipe-models/x.task", "https://cdn.jsdelivr.net/npm/a.wasm"], requests: [{ url: "bh-app://app/gaze/face_landmarker.task" }] });
  assert.equal(r.ok, true); assert.equal((r as { code?: string }).code, "net.worker_blocked");
  const lines: HealthLine[] = [];
  const pf = new Preflight({ now: () => 0, emit: (h) => lines.push(h), probes: [networkIsolationProbe(() => ({ workerBlocked: ["https://cdn.jsdelivr.net/x"], requests: [] }))] });
  const rep = await pf.start(); pf.stop();
  assert.equal(rep.pilotFail, null); assert.equal(rep.directorBlock, null); assert.equal(rep.failures.length, 0); assert.equal(rep.statusLine, "");
  assert.deepEqual(lines.map((l) => [l.check, l.ok, l.code]), [["network.isolation", true, "net.worker_blocked"]]);
  assert.match(healthWords("net.worker_blocked"), /blocked; nothing left the device/);
});

test("C: any request past the block to a non-bundle origin -> net.request_escaped, the pilot preflight FAILS, Director paused", async () => {
  const st = { workerBlocked: ["https://cdn.jsdelivr.net/x"], requests: [{ url: "https://storage.googleapis.com/mediapipe-models/face_landmarker.task" }] };
  const r = networkIsolationResult(st);
  assert.equal(r.ok, false); assert.equal((r as { code: string }).code, "net.request_escaped");
  assert.ok(PILOT_FAILING.has("net.request_escaped") && DIRECTOR_BLOCKING.has("net.request_escaped"));
  assert.ok(!PILOT_FAILING.has("net.worker_blocked") && !DIRECTOR_BLOCKING.has("net.worker_blocked"));
  const lines: HealthLine[] = [];
  let state = { workerBlocked: [] as string[], requests: [] as Array<{ url: string }> };
  const pf = new Preflight({ now: () => 0, emit: (h) => lines.push(h), probes: [networkIsolationProbe(() => state)] });
  assert.equal((await pf.run("start")).pilotFail, null);
  state = st;
  const rep = await pf.run("interval");
  assert.equal(rep.pilotFail, "net.request_escaped"); assert.equal(rep.directorBlock, "net.request_escaped");
  assert.match(rep.statusLine, /^net\.request_escaped: .*pilot preflight FAILED/);
  const last = lines[lines.length - 1]!;
  assert.equal(last.ok, false); assert.equal(last.code, "net.request_escaped"); assert.match(String(last.detail), /storage\.googleapis\.com/);
  // bundle-origin traffic alone is fine; a crashed probe fails closed; no shell bridge -> skipped
  assert.deepEqual(networkIsolationResult({ workerBlocked: [], requests: [{ url: "bh-app://app/ad.html" }] }), { ok: true });
  const crash = await new Preflight({ now: () => 0, emit: () => {}, probes: [{ check: "network.isolation", run: () => { throw new Error("ipc gone"); } }] }).run("start");
  assert.equal(crash.pilotFail, "net.request_escaped");
  const skip = await new Preflight({ now: () => 0, emit: () => {}, probes: [networkIsolationProbe(() => null)] }).run("start");
  assert.equal(skip.pilotFail, null); assert.ok("skip" in skip.results[0]!);
});
