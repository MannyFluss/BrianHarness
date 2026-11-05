// E7: preflight health checks with root-cause codes; plain words; change-only logging; no secret in any line;
// the Director is skipped (chat continues) while a blocking code stands.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ActorDirectorSession, AdStorage, AdSessionLog, ManualClock, MockAdBackend, loadO200k, Preflight, DIRECTOR_BLOCKING, healthWords, scrubDetail,
  cameraPermissionProbe, consentProbe, arkitProbe, mediapipeProbe, calibrationProbe, thermalProbe, trackerProbe, tokenProbe, replyShapeProbe, workerProbe,
  type HealthLine, type CameraPermission, type ThermalState, type ModelLoadState,
} from "../src/actor-director/index.ts";
import { HEALTH_CODES, HEALTH_CHECKS, type AttentionEvent, type BhAdEvent, type HealthCode, type ReadingDigest } from "../src/ad-contracts/index.ts";
import { MemoryKV } from "../src/platform/kv.ts";

const TOKEN = "bhd_SECRETSECRET1234";
type Resp = { status: number; body?: unknown } | "throw" | "hang";
function fakeFetch(r: () => Resp, seen: Array<{ url: string; headers: Record<string, string> }> = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const x = r();
    if (x === "throw") throw new TypeError(`fetch failed for ${TOKEN}`);
    if (x === "hang") return new Promise((_, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    return new Response(x.body === undefined ? "" : JSON.stringify(x.body), { status: x.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const MODELS = { data: [{ id: "gpt-oss:120b-cloud" }, { id: "gemma4:cloud" }, { id: "gpt-oss:20b-cloud" }] };

test("preflight: every probe reports its root-cause code; start logs all, later runs log only changes and recoveries", async () => {
  let cam: CameraPermission = "granted", consent = true, thermal: ThermalState = "nominal", token: string | null = TOKEN;
  let model: ModelLoadState = { loaded: true, source: "bundle", sha256Ok: true };
  let tracker = { running: true, lastSampleAgoMs: 40 as number | null, reason: undefined as string | undefined };
  let cal = { stale: false, words: "accurate to about 1 paragraph" };
  let resp: Resp = { status: 200, body: MODELS };
  let shape: HealthCode | null = null;
  const lines: HealthLine[] = [];
  let now = 0;
  const pf = new Preflight({
    now: () => now, emit: (h) => lines.push(h),
    probes: [
      cameraPermissionProbe(() => cam), consentProbe(() => consent), arkitProbe(() => null), mediapipeProbe(() => model), calibrationProbe(() => cal),
      thermalProbe(() => thermal), trackerProbe(() => tracker), tokenProbe(() => !!token), replyShapeProbe(() => shape),
      workerProbe({ baseUrl: "https://w.example/v1/", token: () => token, models: () => ["gpt-oss:120b-cloud", "gemma4:cloud"], fetchImpl: fakeFetch(() => resp) }),
    ],
  });
  const r0 = await pf.run("start");
  assert.equal(r0.failures.length, 0);
  assert.equal(r0.statusLine, "");
  assert.equal(r0.directorBlock, null);
  assert.equal(lines.length, 11, "start logs every applicable check (arkit skipped on the Mac)");
  assert.ok(lines.every((l) => l.ok && l.code === null));
  assert.ok(!lines.some((l) => l.check === "arkit.supported"));
  lines.length = 0;
  await pf.run("interval");
  assert.equal(lines.length, 0, "no change, nothing logged");

  const expect: Array<[() => void, string, HealthCode]> = [
    [() => { cam = "denied"; }, "camera.permission", "gaze.camera_denied"],
    [() => { consent = false; }, "consent.camera", "gaze.no_consent"],
    [() => { model = { loaded: false, source: "none", error: "file not found" }; }, "mediapipe.model_loaded", "gaze.model_missing"],
    [() => { cal = { stale: true, words: "Recalibrate (head moved 18° since calibration)" }; }, "calibration.valid", "gaze.calibration_stale"],
    [() => { thermal = "serious"; }, "thermal", "gaze.thermal_degraded"],
    [() => { tracker = { running: true, lastSampleAgoMs: 5000, reason: undefined }; }, "tracker.running", "gaze.tracker_interrupted"],
    [() => { shape = "model.length_cutoff"; }, "upstream.reply_shape", "model.length_cutoff"],
    [() => { resp = { status: 200, body: { data: [{ id: "gpt-oss:120b-cloud" }, { id: "gemma4:cloud", verified: false }] } }; }, "model.route", "model.route_unverified"],
  ];
  for (const [set, check, code] of expect) {
    set(); lines.length = 0;
    await pf.run("interval");
    const l = lines.find((x) => x.check === check);
    assert.ok(l && !l.ok && l.code === code, `${check} -> ${code}: ${JSON.stringify(lines)}`);
    assert.equal(lines.length, 1, `${check}: only the change is logged`);
  }
  const route = pf.lastReport!.failures.find((f) => f.check === "model.route")!;
  assert.equal(route.detail, "gemma4:cloud verified:false");
  assert.equal(pf.lastReport!.directorBlock, "model.route_unverified");
  assert.match(pf.lastReport!.statusLine, /^model\.route_unverified: Model route not verified \(gemma4:cloud verified:false\); Director paused, chat continues without notes$/);
  // recovery is logged as ok:true code:null
  cam = "granted"; lines.length = 0;
  await pf.run("interval");
  assert.deepEqual(lines.map((l) => [l.check, l.ok, l.code]), [["camera.permission", true, null]]);
  // the calibration words come through as the status detail
  assert.equal(pf.lastReport!.failures.find((f) => f.check === "calibration.valid")!.detail, "Recalibrate (head moved 18° since calibration)");
});

test("preflight: GET /v1/models -> unreachable (+HTTP status / timeout / token rejected), caps from the 429 body; the token never reaches a line", async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const cases: Array<[Resp, Partial<HealthLine>[]]> = [
    ["throw", [{ check: "worker.reachable", code: "net.worker_unreachable", detail: "network error" }]],
    ["hang", [{ check: "worker.reachable", code: "net.worker_unreachable", detail: "timeout" }]],
    [{ status: 503, body: { error: { message: "down", code: "upstream" } } }, [{ check: "worker.reachable", code: "net.worker_unreachable", http_status: 503 }]],
    [{ status: 401 }, [{ check: "worker.reachable", code: "net.worker_unreachable", http_status: 401, detail: "token rejected" }]],
    [{ status: 429, body: { error: { message: "cap", type: "rate_limit_error", code: "role_cap_director", role: "director" } } }, [{ check: "budget", code: "budget.director_cap", http_status: 429, worker_code: "role_cap_director", role: "director" }]],
    [{ status: 429, body: { error: { message: "cap", type: "rate_limit_error", code: "daily_cap_device" } } }, [{ check: "budget", code: "budget.daily_cap_device", worker_code: "daily_cap_device" }]],
    [{ status: 200, body: { data: [{ id: "gpt-oss:120b-cloud" }] } }, [{ check: "model.route", code: "model.route_unverified", detail: "gemma4:cloud not listed" }]],
    [{ status: 200, body: "not a list" }, [{ check: "model.route", code: "model.route_unverified", detail: "model list unreadable" }]],
  ];
  for (const [resp, want] of cases) {
    const lines: HealthLine[] = [];
    const pf = new Preflight({ now: () => 0, emit: (h) => lines.push(h), probes: [tokenProbe(() => true), workerProbe({ baseUrl: "https://w.example", token: () => TOKEN, models: () => ["gpt-oss:120b-cloud", "gemma4:cloud"], fetchImpl: fakeFetch(() => resp, seen), timeoutMs: 30 })] });
    const r = await pf.run("start");
    for (const w of want) {
      const f = r.failures.find((x) => x.check === w.check);
      assert.ok(f, `${JSON.stringify(resp)} -> ${w.check}`);
      for (const [k, v] of Object.entries(w)) assert.equal((f as Record<string, unknown>)[k], v, `${JSON.stringify(resp)} ${k}`);
      assert.ok(DIRECTOR_BLOCKING.has(f!.code!));
      assert.equal(r.directorBlock, f!.code);
    }
    assert.ok(!JSON.stringify(lines).includes(TOKEN) && !JSON.stringify(r).includes(TOKEN), "no token in lines or the report");
  }
  assert.ok(seen.every((s) => s.url === "https://w.example/v1/models" && s.headers.authorization === `Bearer ${TOKEN}`), "the token goes in the header only");
  // no token: auth.no_token, and the Worker is not even asked
  const n0 = seen.length; const lines: HealthLine[] = [];
  const pf = new Preflight({ now: () => 0, emit: (h) => lines.push(h), probes: [tokenProbe(() => false), workerProbe({ baseUrl: "https://w.example", token: () => null, models: () => ["gemma4:cloud"], fetchImpl: fakeFetch(() => ({ status: 200, body: MODELS }), seen) })] });
  const r = await pf.run("start");
  assert.equal(seen.length, n0);
  assert.deepEqual(r.failures.map((f) => f.code), ["auth.no_token"]);
  assert.match(r.statusLine, /^auth\.no_token: This device has no access token; Director paused, chat continues without notes$/);
  assert.equal(scrubDetail(`boom Bearer ${TOKEN} and ${TOKEN}`), "boom [redacted] and [redacted]");
});

test("preflight: plain words for every health code; each fallback says it is one; a crashing probe still reports a code", async () => {
  for (const c of HEALTH_CODES) {
    const w = healthWords(c);
    assert.ok(w.length > 8, c);
    if (c.startsWith("gaze.") && !["gaze.calibration_stale", "gaze.thermal_degraded"].includes(c)) assert.match(w, /fallback/, c);
    if (DIRECTOR_BLOCKING.has(c)) assert.match(w, /chat continues without notes/, c);
  }
  assert.equal(healthWords("gaze.camera_denied").startsWith("Camera is off in Settings > BrianHarness"), true);
  assert.equal(healthWords("gaze.thermal_degraded"), "Device warm: gaze at 15 Hz");
  assert.equal(healthWords("budget.daily_cap_device"), "Director paused: daily cap reached; chat continues without notes");
  const lines: HealthLine[] = [];
  const pf = new Preflight({ now: () => 0, emit: (h) => lines.push(h), probes: [{ check: "mediapipe.model_loaded", run: () => { throw new Error("wasm abort"); } }] });
  const r = await pf.run("start");
  assert.deepEqual(r.failures.map((f) => [f.check, f.code, f.detail]), [["mediapipe.model_loaded", "gaze.model_missing", "check crashed"]]);
  assert.ok(HEALTH_CHECKS.length >= 17);
});

test("preflight: directorBlock() is synchronous from the last run and refreshes in the background after 60 s", async () => {
  let now = 0, calls = 0, ok = true;
  const pf = new Preflight({ now: () => now, emit: () => {}, probes: [{ check: "worker.reachable", run: async () => { calls++; return ok ? { ok: true } : { ok: false, code: "net.worker_unreachable", http_status: 502 }; } }] });
  assert.equal(pf.directorBlock(), null, "no report yet: does not block (and starts a run)");
  await pf.run("manual");
  const c0 = calls;
  now = 30_000; ok = false;
  assert.equal(pf.directorBlock(), null); assert.equal(calls, c0, "fresh: no refetch");
  now = 61_000;
  assert.equal(pf.directorBlock(), null, "stale answer returned at once");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, c0 + 1);
  assert.equal(pf.directorBlock(), "net.worker_unreachable");
});

// ---- session: a blocking code skips the Director call; chat continues ------------------------------------------
const o200k = loadO200k();
function digestFor(turn: number): { digest: ReadingDigest; events: AttentionEvent[] } {
  const id = `e${turn * 10 + 1}`;
  const paras = [1, 2].map((i) => ({ aoi: `a${turn}.p${i}`, excerpt: `paragraph ${i}`, label: (i === 2 ? "deep" : "read") as "deep" | "read", ratio: i === 2 ? 2.1 : 0.9, ...(i === 2 ? { ev: [id] } : {}) }));
  const events: AttentionEvent[] = [{ id, kind: "deep_read", aoi: `a${turn}.p2`, excerpt: "paragraph 2", t0: 0, t1: 1, z: 2.1, conf: 0.8, features: {} }];
  return { digest: { msg: `a${turn}`, windowMs: 20000, quality: 0.8, qualityLabel: "good", paras, lookBacks: [], offscreenMs: 0, composerPauses: 0, events: [id] }, events };
}
const director = () => new MockAdBackend([], (req) => {
  const ev = /\b(e\d+)\b/.exec(req.messages[1]!.content)?.[1] ?? "e1";
  return { text: JSON.stringify({ context_update: { summary: "s", hypotheses: [], changed: [] }, intent: "i", note: { id: `n${Math.random().toString(36).slice(2, 6)}`, rationale: "r", suggestion: { move: "give_example", text: "give one example" }, value: "v", evidence: [ev], confidence: 0.6, expires_after_turns: 1 }, no_note_reason: null }) };
});
const actor = () => new MockAdBackend([], (req) => ({ text: req.messages[req.messages.length - 1]!.content === "(session start)" ? "Hi!" : "Direct answer.\n\nMore detail." }));

test("preflight in the session: while net.worker_unreachable stands no director_call is made; chat continues; it resumes on recovery", async () => {
  const storage = await AdStorage.open(new MemoryKV());
  const clock = new ManualClock();
  const log = new AdSessionLog(storage, "s-e7-pf", "tab_visible", clock);
  let down = false;
  const pf = new Preflight({ now: () => 0, emit: (h) => log.emit(h), probes: [{ check: "worker.reachable", run: () => (down ? { ok: false, code: "net.worker_unreachable", http_status: 503 } : { ok: true }) }] });
  const s = new ActorDirectorSession({ log, userId: "u", sessionType: "tab_visible", arm: "shadow", actor: actor(), director: director(), counter: o200k, consent: { camera: true, rawGaze: false }, seed: 1, preflight: pf });
  s.start(); await pf.start(); pf.stop(); await s.opener();
  const dc = () => log.lines.filter((l) => l.type === "director_call").length;
  const turn = async (t: number) => { s.observeReading({ ...digestFor(t), faceFrac: 0.95, baselineParagraphs: 22 }); clock.advance(5000); await s.send(`q${t}`); };
  await turn(0); await turn(1);
  const before = dc();
  assert.ok(before >= 1);
  down = true; await pf.run("manual");
  await turn(2); await turn(3);
  assert.equal(dc(), before, "no Director call while blocked");
  const at = log.lines.filter((l) => l.type === "actor_turn").length;
  assert.equal(at, 5, "the chat itself continued");
  const h = log.lines.filter((l): l is Extract<BhAdEvent, { type: "health" }> => l.type === "health" && l.check === "worker.reachable");
  assert.deepEqual(h.map((x) => [x.ok, x.code, x.http_status]), [[true, null, undefined], [false, "net.worker_unreachable", 503]]);
  down = false; await pf.run("manual");
  await turn(4); await turn(5);
  assert.ok(dc() > before, "resumed");
  await s.end();
});
