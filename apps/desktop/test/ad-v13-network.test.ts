// contract-v1.3 (ruling C, desktop): the Mac shell's network.isolation. Worker-blocked URLs are an informational health
// code; any request that got past the block to a non-bundle origin FAILS the pilot preflight (net.request_escaped), in the
// session log, in the controller and in the shell's H1 report verdict (electron/ad-network.mjs, same rule as core).
import { test } from "node:test";
import assert from "node:assert/strict";
import { networkIsolationResult, simActor, simDirector, type SimReplay } from "@brianharness/core/actor-director/browser";
import { loadO200k } from "@brianharness/core/actor-director";
import type { ScreenInfo } from "@brianharness/core/ad-contracts";
import { MemoryKV } from "@brianharness/core/browser";
import { LiveAdController } from "../src/ad/controller.ts";
import { macNetworkProbe } from "../src/ad/mac/MacBoot.tsx";
import type { MacBridge } from "../src/ad/mac/mediapipe-tracker.ts";
// @ts-expect-error plain .mjs shared with electron/ad-main.mjs
import { networkVerdict } from "../electron/ad-network.mjs";

const counter = loadO200k();
const MAC: ScreenInfo = { deviceModel: "Mac", platform: "macos", orientation: "landscape_left", widthPt: 1512, heightPt: 982, scale: 2, webview: { x: 0, y: 0, width: 1512, height: 982 }, widthMm: 302 } as ScreenInfo;
const FAKE: SimReplay[] = [{ name: "fake", file: { screen: MAC, samples: [] }, turn: { aois: [{ id: "a.p1", order: 1, text: "Hello there." }] } } as unknown as SimReplay];

async function open(requests: Array<{ url: string }>, blocked: string[], withBridge = true) {
  const bridge = (withBridge ? { network: async () => requests } : {}) as MacBridge;
  const tracker = { getStats: () => ({ blocked }) };
  const c = await LiveAdController.open({
    sessionType: "tab_visible", arm: "on", sessionId: "net", userId: "u", actor: simActor(FAKE), director: simDirector(), counter, kv: new MemoryKV(),
    screen: MAC, calibration: null, consent: { camera: true, rawGaze: false }, preflightProbes: [macNetworkProbe(tracker, () => bridge)],
  });
  c.dispose();
  const lines = (c as unknown as { log: { lines: Array<Record<string, unknown>> } }).log.lines.filter((l) => l.type === "health" && l.check === "network.isolation");
  return { c, lines };
}

test("C desktop: Worker-blocked only -> net.worker_blocked logged ok:true; the pilot passes, the Director is not paused", async () => {
  const { c, lines } = await open([], ["https://storage.googleapis.com/mediapipe-models/face_landmarker.task"]);
  assert.deepEqual(lines.map((l) => [l.ok, l.code]), [[true, "net.worker_blocked"]]);
  assert.equal(c.pilotFail, null); assert.equal(c.healthLine, ""); assert.deepEqual(c.healthSeen(), []);
});

test("C desktop: a request past the block -> net.request_escaped, the pilot preflight FAILS (controller + H1 verdict)", async () => {
  const esc = [{ url: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm" }];
  const { c, lines } = await open(esc, ["https://storage.googleapis.com/x"]);
  assert.deepEqual(lines.map((l) => [l.ok, l.code]), [[false, "net.request_escaped"]]);
  assert.equal(c.pilotFail, "net.request_escaped");
  assert.match(c.healthLine, /^net\.request_escaped/);
  assert.deepEqual(c.healthSeen(), ["net.request_escaped"]);
  // no shell bridge (browser demo) -> the probe skips; nothing logged
  assert.equal((await open(esc, [], false)).lines.length, 0);
});

test("C desktop: the shell's H1 verdict (electron/ad-network.mjs) agrees with core networkIsolationResult", () => {
  const cases = [
    { requests: [], workerBlocked: [] },
    { requests: [], workerBlocked: ["https://cdn.jsdelivr.net/a"] },
    { requests: [{ url: "bh-app://app/gaze/vision_wasm_module_internal.wasm" }], workerBlocked: [] },
    { requests: [{ url: "https://example.com/x" }], workerBlocked: ["https://cdn.jsdelivr.net/a"] },
    { requests: [{ url: "bh-app://app/ad.html" }, { url: "wss://evil.example/s" }], workerBlocked: [] },
  ];
  for (const st of cases) {
    const core = networkIsolationResult(st) as { ok: boolean; code?: string };
    const shell = networkVerdict(st);
    assert.equal(shell.ok, core.ok, JSON.stringify(st)); assert.equal(shell.code, core.code ?? null, JSON.stringify(st));
    assert.equal(shell.pilotFail, core.ok ? null : "net.request_escaped");
  }
});
