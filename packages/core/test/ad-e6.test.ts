// E6: browser tokenizer parity, the ad signal adapter, keystroke times, calibration (fit, words, per-orientation
// storage, staleness, distance -> px/deg), the synthetic tracker, GazeStream.live(), the tab model (and its refusal
// in blinded sessions), and a simulated 20-turn session over the R2 replays with no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadO200k, loadO200kBrowser, isBundledAssetUrl, O200K_ASSET_BYTES, O200K_ASSET_PATH, asSignalSource, GazeSource, KeystrokeTimes,
  CalibrationRun, CalibrationStore, calibrationTargets, calibrationStatus, accuracyWords, fitAffine, applyAffine, calibrateBatch, layoutFromScreen,
  gazeOptionsFromCalibration, primaryOrientation, calDeviceOf, SyntheticGazeTracker, AdStorage, buildTabModel, BlindedTabError, shareWords, ratioWords,
  evidenceParagraphs, runSimSession, type SimReplay, gazeRef,
} from "../src/actor-director/index.ts";
import { TAB_ONLY_FIELDS, SEALED_ONLY_TYPES, type ScreenInfo, type BhAdEvent } from "../src/ad-contracts/index.ts";
import { MemoryKV } from "../src/platform/kv.ts";
import type { SignalSource } from "../src/signals.ts";

const VENDOR_GZ = join(import.meta.dirname, "..", "vendor", "o200k_base.tiktoken.gz");
const FIX = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "o200k-parity.json"), "utf8")) as { cases: Array<{ text: string; count: number }> };
const node = loadO200k();
const fileFetch = async (url: string) => {
  assert.ok(url.endsWith(O200K_ASSET_PATH), url);
  const b = readFileSync(VENDOR_GZ);
  return { ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
};

test("E6: browser tokenizer (bundled gz asset, DecompressionStream, sha-checked) counts == tokenizer-node on every E4 fixture", async () => {
  assert.equal(readFileSync(VENDOR_GZ).byteLength, O200K_ASSET_BYTES);
  const br = await loadO200kBrowser({ fetchImpl: fileFetch, baseUrl: "capacitor://localhost/ad.html" });
  assert.ok(FIX.cases.length >= 10);
  for (const c of FIX.cases) { assert.equal(br.count(c.text), node.count(c.text), c.text.slice(0, 40)); assert.equal(br.count(c.text), c.count); }
  assert.ok(isBundledAssetUrl("capacitor://localhost/ad/o200k_base.tiktoken.gz", "capacitor://localhost/ad.html"));
  assert.ok(isBundledAssetUrl("http://localhost:5174/ad/x", "http://localhost:5174/ad.html"));
  assert.ok(!isBundledAssetUrl("https://cdn.example/ad/x", "capacitor://localhost/ad.html"));
  await assert.rejects(loadO200kBrowser({ fetchImpl: fileFetch, baseUrl: "http://localhost/", path: "https://cdn.example/o200k.gz" }), /app bundle/);
  const bad = async () => ({ ok: true, arrayBuffer: async () => { const z = await import("node:zlib"); const b = z.gzipSync(Buffer.from("x 1\n")); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; } });
  await assert.rejects(loadO200kBrowser({ fetchImpl: bad, baseUrl: "http://localhost/" }), /sha256 mismatch/);
});

test("E6: GazeSource adapter satisfies SignalSource structurally (signals.ts untouched)", () => {
  const g = new GazeSource({ ppd: 40, viewport: { w: 400, h: 800 } });
  const a = asSignalSource(g);
  assert.equal(a.kind, "gaze");
  const asSig: Pick<SignalSource, "id" | "push" | "summarize" | "clear"> = a;
  asSig.push([{ t: 0, x: 10, y: 10, conf: 1, face: true, blink: false }]);
  assert.equal(typeof asSig.summarize({ from: 0, to: 1000 })["gaze.quality"], "number");
});

test("E6: keystroke recorder keeps times only (no key, no text) and gives intervals", () => {
  const k = new KeystrokeTimes();
  for (const t of [100, 250, 400, 1400]) k.record(t);
  k.record(50); // out of order: ignored
  assert.deepEqual(k.intervals(0), [150, 150, 1000]);
  assert.equal(k.first(200), 250);
  assert.deepEqual(JSON.parse(JSON.stringify(k)), { n: 4 });
  assert.equal(k.record.length, 1);
});

const IPAD: ScreenInfo = { deviceModel: "iPad13,4", platform: "ios", orientation: "landscape_left", widthPt: 1194, heightPt: 834, scale: 2, webview: { x: 0, y: 0, width: 1194, height: 834 }, widthMm: 229.8 };
const IPHONE: ScreenInfo = { deviceModel: "iPhone18,1", platform: "ios", orientation: "portrait", widthPt: 402, heightPt: 874, scale: 3, webview: { x: 0, y: 0, width: 402, height: 874 }, widthMm: 66.6 };

test("E6: calibration targets: 5 on iPhone, 9 on iPad/Mac, + 4 validation; primary orientations", () => {
  assert.equal(calibrationTargets(calDeviceOf(IPHONE), { w: 402, h: 874 }).fit.length, 5);
  assert.equal(calibrationTargets(calDeviceOf(IPAD), { w: 1194, h: 834 }).fit.length, 9);
  assert.equal(calibrationTargets("mac", { w: 1440, h: 900 }).validate.length, 4);
  assert.equal(primaryOrientation("iPad13,4"), "landscape_left");
  assert.equal(primaryOrientation("iPhone18,1"), "portrait");
  const A = fitAffine([{ raw: { x: 0, y: 0 }, target: { x: 10, y: 20 } }, { raw: { x: 100, y: 0 }, target: { x: 120, y: 20 } }, { raw: { x: 0, y: 100 }, target: { x: 10, y: 110 } }])!;
  const p = applyAffine(A, 50, 50); assert.ok(Math.abs(p.x - 65) < 1e-6 && Math.abs(p.y - 65) < 1e-6);
});

async function calibrate(screen: ScreenInfo, distortion?: [number, number, number, number, number, number], noisePt = 5, moveAtValidation = false) {
  let now = 1000;
  const tr = new SyntheticGazeTracker({ screen, now: () => now, distortion, noisePt, distCm: 44 });
  const run = new CalibrationRun({ screen, paraHeightPx: 96 });
  await tr.start({ mode: "synthetic", webNow: now });
  await tr.addListener("gaze", (e) => run.push(e.samples));
  await tr.calibrate({ phase: "begin", orientation: run.orientation, targets: run.sequence });
  for (const tg of run.sequence) {
    if (moveAtValidation && tg.id === "v1") tr.setDistortion([1.06, 0, 24 + 140, 0, 1.06, -30 + 120]);
    tr.lookAt(tg.x + screen.webview.x, tg.y + screen.webview.y);
    const w = run.show(tg.id, now);
    now += run.timing.dotMs; tr.pump(now);
    await tr.calibrate({ phase: "target", targetId: tg.id, ...w });
    now += run.timing.gapMs; tr.pump(now);
  }
  const end = await tr.calibrate({ phase: "end" });
  assert.equal(end.fit, "core");
  return { res: run.finish({ t: now, at: Date.parse("2026-11-04T23:00:00Z") }), now, tr };
}

test("E6: calibration on iPad13,4 landscape: fits the distortion, words in paragraphs, distance -> px/deg, saved per orientation", async () => {
  const { res } = await calibrate(IPAD);
  assert.ok(res.ok); assert.equal(res.recommend, "use"); assert.equal(res.record.mode, "gaze");
  assert.ok(res.record.errParas! < 0.5, String(res.record.errParas));
  assert.equal(res.words, accuracyWords(res.record.errParas));
  assert.equal(res.record.distCm, 44);
  const opt = gazeOptionsFromCalibration(IPAD, res.record);
  assert.equal(opt.distCm, 44);
  assert.equal(opt.ppd, gazeRef.layoutPpd(layoutFromScreen(IPAD), 44));
  assert.ok(Math.abs(layoutFromScreen(IPAD).css_px_per_cm - 51.96) < 0.02);
  // calibrated batch: raw distorted point maps back near the true point
  const [s] = calibrateBatch([{ t: 0, x: 1.06 * 600 + 24, y: 1.06 * 400 - 30, cal: false }], res.record, IPAD.webview);
  assert.ok(Math.hypot(s!.x! - 600, s!.y! - 400) < 6); assert.equal(s!.cal, true);
  const store = new CalibrationStore(await AdStorage.open(new MemoryKV()));
  store.save(res.record);
  const { res: port } = await calibrate({ ...IPAD, orientation: "portrait", widthPt: 834, heightPt: 1194, webview: { x: 0, y: 0, width: 834, height: 1194 } });
  store.save(port.record);
  assert.deepEqual(store.orientations("iPad13,4"), ["landscape_left", "portrait"]);
  assert.deepEqual(store.load("iPad13,4", "landscape_left"), res.record);
  assert.equal(store.load("iPad13,4", "landscape_right"), null);
  assert.equal(gazeOptionsFromCalibration({ ...IPAD, orientation: "landscape_right" }, res.record).distCm, null);
});

test("E6: calibration error > 1 paragraph -> recalibrate or on-screen only; staleness at 15 deg / 25 % / orientation", async () => {
  const { res } = await calibrate(IPHONE, undefined, 5, true);
  assert.equal(res.recommend, "recalibrate_or_onscreen"); assert.equal(res.record.mode, "onscreen_only");
  assert.ok(res.record.errParas! > 1);
  assert.match(accuracyWords(2.2), /about 2 paragraphs/); assert.equal(accuracyWords(0.9), "accurate to about 1 paragraph");
  const { res: good } = await calibrate(IPHONE);
  const r = good.record;
  assert.equal(calibrationStatus(r, { yaw: (r.yaw ?? 0) + 5, distCm: 44, orientation: "portrait", t: r.t + 1000 }).stale, false);
  const y = calibrationStatus(r, { yaw: (r.yaw ?? 0) + 16, distCm: 44, orientation: "portrait", t: r.t });
  assert.equal(y.code, "gaze.calibration_stale"); assert.match(y.words, /head moved 16°/);
  assert.deepEqual(calibrationStatus(r, { yaw: r.yaw ?? 0, distCm: 56, orientation: "portrait", t: r.t }).reasons, ["distance"]);
  assert.deepEqual(calibrationStatus(r, { yaw: r.yaw ?? 0, distCm: 44, orientation: "landscape_left", t: r.t }).reasons, ["orientation"]);
  assert.equal(calibrationStatus(null, { yaw: 0, distCm: 40, orientation: "portrait", t: 0 }).stale, true);
});

test("E6: GazeStream.live(): point, current fixation target, quality, face", () => {
  const g = new GazeSource({ ppd: 40, viewport: { w: 400, h: 800 } });
  g.setAois([{ id: "a1.p1", msg: "a1", order: 1, x: 0, y: 100, w: 400, h: 100, words: 20, visible: [[0, 1e9]] }]);
  const batch = Array.from({ length: 60 }, (_, i) => ({ t: i * 33.33, x: 200 + (i % 3), y: 150, conf: 0.9, face: true, blink: false }));
  g.push(batch);
  const l = g.live();
  assert.ok(l.point && Math.abs(l.point.y - 150) < 1);
  assert.equal(l.target, "a1.p1");
  assert.ok(l.quality > 0.8, String(l.quality)); assert.equal(l.faceFrac, 1);
  g.setPpd(50); assert.equal(g.stream.ppd, 50); g.setPpd(-1); assert.equal(g.stream.ppd, 50);
});

// ---------------------------------------------------------------- simulated sessions over R2
const R2 = "/workspace/actor-director/research/R2";
const HAVE_R2 = existsSync(join(R2, "gaze-replays"));
export function loadSimReplays(names: string[]): SimReplay[] {
  return names.map((name) => {
    const file = JSON.parse(readFileSync(join(R2, "gaze-replays", name + ".json"), "utf8"));
    const turn = JSON.parse(readFileSync(join(R2, "gaze-replays", name + ".truth.json"), "utf8")).turn; // layout + aois only; labels never read
    return { name, file, turn };
  });
}
const IPAD_REPLAYS = ["ipadpro11-m1-landscape-01", "ipadpro11-m1-landscape-02"];

function noNetwork() {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("network used in a simulated session"); }) as typeof fetch;
  return { restore: () => { globalThis.fetch = orig; }, calls: () => calls };
}

test("E6: simulated 20-turn session over the R2 iPad replays, end to end, no network; tab model layers", { skip: !HAVE_R2 && "R2 research data not present" }, async () => {
  const net = noNetwork();
  try {
    const sim = await runSimSession({ turns: 20, counter: node, replays: loadSimReplays(IPAD_REPLAYS), kv: new MemoryKV() });
    assert.equal(net.calls(), 0);
    const L = sim.lines;
    assert.equal(L.filter((l) => l.type === "actor_turn").length, 20);
    assert.equal(L.filter((l) => l.type === "attention_digest").length, 19);
    assert.equal(L[L.length - 1]!.type, "session_end");
    assert.equal(sim.chat.length, 39);
    const m = buildTabModel(L);
    assert.equal(m.turns, 20);
    assert.ok(m.top && m.top.hypotheses.length >= 2 && m.top.summary.length > 0 && m.top.intent.length > 0);
    assert.equal(m.cards.length, 19);
    const states = new Set(m.cards.map((c) => c.state));
    for (const st of ["injected", "no_note", "blocked"]) assert.ok(states.has(st as never), `${st} in ${[...states]}`);
    const blocked = m.cards.find((c) => c.state === "blocked")!;
    assert.ok(blocked.railCodes.length > 0 && blocked.reason!.includes(blocked.railCodes[0]!));
    const inj = m.cards.find((c) => c.state === "injected" && c.outcome)!;
    assert.ok(inj.hint!.startsWith("[Context for your next reply") && inj.replyMsg && m.marks[inj.replyMsg] === inj.noteId);
    assert.ok(inj.kind && inj.evidence.length);
    assert.ok(m.cards.find((c) => c.state === "no_note")!.reason!.length > 0);
    assert.ok(m.share && /^(Director \d+ tok · \d+\.\d% of [\d,]+|No Director hint · [\d,]+ tok)$/.test(m.share.words), m.share?.words);
    assert.match(m.session.words, /^Session: \d+ notes? in 20 turns · \d+\.\d% of Actor input · indirect \d+%$/);
    assert.equal(m.session.spark.length, 20);
    assert.equal(m.bottom.paras.length, 3);
    assert.ok(m.bottom.paras.every((p) => p.shade >= 0 && p.shade <= 1 && p.words.length));
    assert.equal(sim.live.length, 19);
    // R2 digests came through: at least one non-trivial label and events with ids
    const dig = L.filter((l): l is Extract<BhAdEvent, { type: "attention_digest" }> => l.type === "attention_digest");
    assert.ok(dig.some((d) => d.events.length > 0));
    assert.ok(dig.every((d) => d.digest.paras.every((p) => p.aoi.startsWith(d.msg + "."))));
  } finally { net.restore(); }
});

test("E6: blinded sessions: the tab model refuses; the main log has no tab-only fields; full lines stay sealed", { skip: !HAVE_R2 && "R2 research data not present" }, async () => {
  const sim = await runSimSession({ turns: 6, sessionType: "blinded", arm: "on", counter: node, replays: loadSimReplays(IPAD_REPLAYS), kv: new MemoryKV() });
  assert.throws(() => buildTabModel(sim.lines), BlindedTabError);
  const main = sim.storage.read("blinded", sim.sessionId)!.trim().split("\n").map((l) => JSON.parse(l));
  for (const l of main) {
    assert.ok(!SEALED_ONLY_TYPES.includes(l.type), l.type);
    for (const f of (TAB_ONLY_FIELDS as Record<string, readonly string[]>)[l.type] ?? []) assert.ok(!(f in l), `${l.type}.${f}`);
  }
  assert.throws(() => buildTabModel(main), BlindedTabError);
  assert.equal(sim.log.guardDrops, 0);
});

test("E6: words with numbers", () => {
  assert.equal(shareWords({ director: 41, total: 1751 }), "Director 41 tok · 2.3% of 1,751");
  assert.equal(shareWords({ director: 0, total: 1751 }), "No Director hint · 1,751 tok");
  assert.equal(ratioWords(2.4), "2.4× your usual reading time");
  assert.deepEqual(evidenceParagraphs(["a3.p2.s1", "e31", "u2"], [{ id: "e31", aoi: "a3.p1" }]), ["a3.p2", "a3.p1"]);
});
