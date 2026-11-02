// Phase D desktop/iOS wiring (fake plugins only, no network): probe schedule, telemetry flags,
// ratings through the in-process transport, BHExport (IOS Dev's simulator-verified contract),
// BHKeychain error shapes, and the blinded study end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KVCredentialStore, MemoryKV, STUDY_SCHEDULE_KEY, plainFiles, sessionExportName, type StoredCredential } from "@brianharness/core/browser";
import { createInProcessTransport } from "../src/transport/in-process.ts";
import { BH_EXPORT_MESSAGES, bhExportErrorMessage, toExportFile } from "../src/transport/bh-export.ts";
import { createKeychainCredentials, keychainStatus, nativeTransportOptions } from "../src/transport/native.ts";
import { probeScheduler, PROBE_MIN_GAP } from "../src/rating.ts";
import { classifyInput, classifySource, type SourceState } from "../src/telemetry.ts";
import type { BHExportPlugin } from "../src/transport/types.ts";

// ---- fake BHExport enforcing IOS Dev's rules exactly ----
class ExportError extends Error {
  constructor(public code: string, msg: string) { super(msg); }
}
function checkNames(files: Array<{ name: string; content: unknown }>) {
  const seen = new Set<string>();
  for (const f of files) {
    const n = f.name;
    if (typeof n !== "string" || !n || n === "." || n === ".." || n.startsWith(".") || /[/\\]/.test(n) || seen.has(n)) throw new ExportError("EINVAL", `bad name ${JSON.stringify(n)}`);
    if (typeof f.content !== "string") throw new ExportError("EINVAL", "content must be a string");
    seen.add(n);
  }
}
function fakeExport(opts: { share?: "complete" | "dismiss" | string; save?: "ok" | string } = {}) {
  const shared: Array<Array<{ name: string; content: string; mimeType?: string }>> = [];
  const docs = new Map<string, string>(); // Documents dir: same name overwrites
  const plugin: BHExportPlugin = {
    async share({ files }) {
      checkNames(files);
      if (opts.share && opts.share !== "complete" && opts.share !== "dismiss") throw new ExportError(opts.share, "fail");
      shared.push(files);
      return opts.share === "dismiss" ? { completed: false } : { completed: true, activityType: "com.apple.UIKit.activity.AirDrop" };
    },
    async saveToDocuments({ files }) {
      checkNames(files);
      if (opts.save && opts.save !== "ok") throw new ExportError(opts.save, "fail");
      for (const f of files) docs.set(f.name, f.content);
      return { dir: "/Documents", paths: files.map((f) => `/Documents/${f.name}`) };
    },
  };
  return { plugin, shared, docs };
}
function fakeKeychain() {
  const data = new Map<string, string>();
  return {
    data,
    async get({ key }: { key: string }) { if (!key) throw Object.assign(new Error("missing key"), { code: "EINVAL" }); return { value: data.get(key) ?? null }; },
    async set({ key, value }: { key: string; value: string }) { data.set(key, value); },
    async remove({ key }: { key: string }) { data.delete(key); },
    async keys() { return { keys: [...data.keys()] }; },
  };
}
const nativeWin = (plugins: Record<string, unknown>) => ({ Capacitor: { isNativePlatform: () => true, isPluginAvailable: (n: string) => n in plugins, Plugins: plugins }, fetch: (async () => new Response('{"models":[]}')) as typeof fetch });
const events = (n: number, t0: number) => Array.from({ length: n }, (_, i) => ({ t: t0 + 500 + i * 150, kind: "insert" as const, len: i + 1, source: "hardware-key" as const }));
async function chat(t: ReturnType<typeof createInProcessTransport>, turns: number) {
  const s = await t.newSession();
  for (let i = 0; i < turns; i++) {
    const t0 = Date.now() - 5000;
    await t.reply({ text: "I like birds and long walks", events: [...events(8, t0), { t: t0 + 2000, kind: "submit", len: 27 }], shownAt: t0, sentAt: t0 + 2000 });
  }
  return s;
}
const parse = (content: string) => content.trim().split("\n").map((l) => JSON.parse(l));

test("probe schedule: seeded, never turn 1, min gap, ~1 in 5 turns", () => {
  const a = probeScheduler("sess-a"), b = probeScheduler("sess-a");
  const turns = Array.from({ length: 40 }, (_, i) => i + 1);
  assert.deepEqual(turns.map((x) => a.shouldProbe(x)), turns.map((x) => b.shouldProbe(x)), "same seed, same probe turns");
  let shown = 0, total = 0;
  for (let s = 0; s < 400; s++) {
    const sch = probeScheduler(`s${s}`);
    let last = -99;
    for (let turn = 1; turn <= 30; turn++) {
      total++;
      if (!sch.shouldProbe(turn)) continue;
      shown++;
      assert.ok(turn >= 2, "never on turn 1");
      assert.ok(turn - last >= PROBE_MIN_GAP, "min gap");
      last = turn;
    }
  }
  const rate = shown / total;
  assert.ok(rate > 0.16 && rate < 0.23, `rate ${rate.toFixed(3)} ~ 1/5`);
  const r = probeScheduler("x");
  assert.equal(r.shouldProbe(5), r.shouldProbe(5), "asking twice for a turn is stable");
});

test("telemetry: dictation vs predictive vs composition, undo by length", () => {
  const st: SourceState = { lastKeyAt: 0, lastKeyHardware: false, sawHardwareKeys: false, touchDevice: true };
  assert.equal(classifySource("insertText", "hello there friend", false, 10_000, st), "dictation");
  assert.equal(classifySource("insertText", "hello ", false, 10_000, st), "predictive");
  assert.equal(classifySource("insertFromDictation", "x", false, 10_000, st), "dictation");
  assert.equal(classifySource("insertReplacementText", "the", false, 10_000, st), "autocorrect");
  assert.equal(classifySource("insertText", "k", false, 10_000, { ...st, composing: true }), "composition");
  assert.equal(classifySource("deleteContentBackward", null, true, 10_000, st), "composition");
  assert.equal(classifyInput("historyUndo", -3), "delete");
  assert.equal(classifyInput("historyRedo", 3), "insert");
});

test("ratings via the in-process transport: logged, evaluation-only, exported; web fallback = one zip", async () => {
  const downloads: Array<{ name: string; files: number }> = [];
  const storageKV = new MemoryKV();
  const t = createInProcessTransport({ storageKV, settingsKV: new MemoryKV(), platform: "test", download: (files, name) => (downloads.push({ name, files: files.length }), true) });
  await chat(t, 3);
  const before = await t.hud();
  await t.rate!({ scope: "turn", turn: 2, value: 4, shownAt: 1, answeredAt: 2, dismissed: false });
  await t.rate!({ scope: "turn", turn: 3, value: null, shownAt: 3, answeredAt: null, dismissed: true, reason: "typed" });
  await t.rate!({ scope: "session", turn: 3, value: 5, shownAt: 4, answeredAt: 5, dismissed: false, hooked: "the bird stuff", blindGuess: "adaptive" });
  assert.deepEqual(await t.hud(), before, "ratings never touch engagement / map / Director");
  const r = await t.exportLogs!();
  assert.equal(r.via, "download");
  assert.ok(r.ok && downloads.length === 1 && /^brianharness-logs-\d{8}-\d{4}\.zip$/.test(downloads[0]!.name));
});

test("BHExport: share gets plain unique names + string content; dismiss is not an error; codes -> friendly", async () => {
  const fx = fakeExport();
  const kc = fakeKeychain();
  const t = createInProcessTransport({ storageKV: new MemoryKV(), settingsKV: new MemoryKV(), platform: "test", ...nativeTransportOptions(nativeWin({ BHExport: fx.plugin, BHKeychain: kc })) });
  await chat(t, 2);
  await t.rate!({ scope: "turn", turn: 2, value: 3, shownAt: 1, answeredAt: 2, dismissed: false });
  // session end (New chat) -> saveToDocuments with this session's JSONL incl. its ratings
  await chat(t, 1);
  assert.equal(fx.docs.size, 1);
  const [docName, docContent] = [...fx.docs][0]!;
  assert.match(docName, /^bh-session-\d{8}T\d{6}Z\.jsonl$/);
  assert.ok(parse(docContent).some((e) => e.type === "rating" && e.value === 3));

  const r = await t.exportLogs!();
  assert.deepEqual({ ok: r.ok, via: r.via, error: r.error }, { ok: true, via: "share-sheet", error: undefined });
  const files = fx.shared[0]!;
  assert.equal(files.length, 3, "2 sessions + interest map");
  for (const f of files) assert.ok(!/[/\\]/.test(f.name) && !f.name.startsWith(".") && typeof f.content === "string");
  assert.ok(files.some((f) => f.mimeType === "application/x-ndjson") && files.some((f) => f.name.endsWith(".json") && f.mimeType === "application/json"));

  const dismissed = createInProcessTransport({ storageKV: new MemoryKV(), settingsKV: new MemoryKV(), platform: "test", bhExport: fakeExport({ share: "dismiss" }).plugin });
  await chat(dismissed, 1);
  const d = await dismissed.exportLogs!();
  assert.equal(d.ok, false);
  assert.equal(d.dismissed, true);
  assert.equal(d.error, undefined, "dismissing the share sheet is not an error");

  for (const code of ["EINVAL", "EWRITE", "EPRESENT", "ESHARE"]) {
    const bad = createInProcessTransport({ storageKV: new MemoryKV(), settingsKV: new MemoryKV(), platform: "test", bhExport: fakeExport({ share: code }).plugin });
    await chat(bad, 1);
    const e = await bad.exportLogs!();
    assert.equal(e.ok, false);
    assert.equal(e.code, code);
    assert.equal(e.error, BH_EXPORT_MESSAGES[code]);
  }
  assert.match(bhExportErrorMessage(new Error("boom")), /boom/);

  // saveToDocuments failure never breaks the chat
  const warn = console.warn;
  console.warn = () => {};
  try {
    const sv = createInProcessTransport({ storageKV: new MemoryKV(), settingsKV: new MemoryKV(), platform: "test", bhExport: fakeExport({ save: "EWRITE" }).plugin });
    await chat(sv, 1);
    await chat(sv, 1);
  } finally {
    console.warn = warn;
  }
});

test("BHExport names: sanitized, de-duplicated, stable per session; placeholder fields mapped", () => {
  const out = plainFiles([{ name: "sessions/a.jsonl" }, { name: "other/a.jsonl" }, { name: ".hidden" }, { name: ".." }, { name: "" }, { name: "x\\y:z.txt" }, { name: "A.JSONL" }]).map((f) => f.name);
  assert.deepEqual(out, ["a.jsonl", "a-2.jsonl", "hidden", "file", "file-2", "y_z.txt", "A-3.JSONL"]);
  assert.doesNotThrow(() => checkNames(out.map((name) => ({ name, content: "" }))));
  const start = { t: "2026-11-02T22:06:12.345Z", study: { index: 3 } };
  assert.equal(sessionExportName(start, "id"), "bh-session-03-20261102T220612Z.jsonl");
  assert.equal(sessionExportName(start, "id"), sessionExportName(start, "id"), "stable: re-saving overwrites its own file");
  assert.equal(sessionExportName({ t: start.t }, "id"), "bh-session-20261102T220612Z.jsonl");
  assert.deepEqual(toExportFile({ name: "a.txt", text: "hi", mime: "text/plain" }), { name: "a.txt", content: "hi", mimeType: "text/plain" });
  assert.deepEqual(toExportFile({ name: "a.txt", content: "hi" }), { name: "a.txt", content: "hi" });
});

test("BHKeychain errors: code '-34018' + data.status degrades; EINVAL is a programming error", async () => {
  const both = Object.assign(new Error("Keychain error"), { code: "-34018", data: { status: -34018 } });
  assert.equal(keychainStatus(both), -34018);
  assert.equal(keychainStatus(Object.assign(new Error("x"), { code: "EINVAL" })), undefined);
  const failing = (err: unknown) => ({ get: async () => { throw err; }, set: async () => { throw err; }, remove: async () => { throw err; }, keys: async () => { throw err; } });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const legacy = new KVCredentialStore(new MemoryKV());
    await legacy.modify("openai", async () => ({ type: "api_key", key: "sk-old" }) as StoredCredential);
    const ent = createKeychainCredentials(failing(both) as never, legacy);
    assert.equal((await ent.read("openai")) && "kept", "kept");
    assert.ok(ent.unavailable, "-34018 -> degraded mode");

    const einval = createKeychainCredentials(failing(Object.assign(new Error("missing key"), { code: "EINVAL" })) as never);
    await assert.rejects(einval.read("openai"), (e: Error & { code?: string }) => e.code === "EINVAL" && /invalid argument/.test(e.message));
    assert.equal(einval.unavailable, null, "EINVAL never triggers the fallback");
  } finally {
    console.warn = warn;
  }
});

test("Phase D study on iOS: schedule only in BHKeychain study/phaseD/schedule; logs, export and HUD blinded", async () => {
  const kc = fakeKeychain();
  const fx = fakeExport();
  const settingsKV = new MemoryKV();
  const t = createInProcessTransport({ storageKV: new MemoryKV(), settingsKV, platform: "test", ...nativeTransportOptions(nativeWin({ BHKeychain: kc, BHExport: fx.plugin })) });
  assert.deepEqual(await t.study!.enable(), { ok: true });
  assert.ok(kc.data.has(STUDY_SCHEDULE_KEY), "schedule in the Keychain");
  const sched = kc.data.get(STUDY_SCHEDULE_KEY)!;
  for (const [, v] of (settingsKV as unknown as { data: Map<string, string> }).data ?? []) assert.ok(!String(v).includes(sched), "progress store never holds the schedule");
  const s = await chat(t, 2);
  const hud = await t.hud();
  assert.deepEqual(hud?.study, { index: 1, total: 10 });
  assert.deepEqual([hud?.topTopics.length, hud?.plan], [0, null]);
  assert.equal(s.director.stateNote, "");
  await t.rate!({ scope: "session", turn: 2, value: 4, shownAt: 1, answeredAt: 2, dismissed: false, blindGuess: "no-idea" });
  await chat(t, 1); // ends session 1 -> autosaved
  const [name, content] = [...fx.docs][0]!;
  assert.match(name, /^bh-session-01-\d{8}T\d{6}Z\.jsonl$/);
  assert.doesNotMatch(content, /"adaptation"|:"(adaptive|baseline)"/, "mode never in the log (blindGuess no-idea only)");
  const evs = parse(content);
  assert.ok(evs[0].study?.scheduleHash && evs[0].study.index === 1);
  assert.ok(evs.some((e) => e.type === "rating" && e.blindGuess === "no-idea"));
  assert.match(String(await t.study!.hash!()), /^[0-9a-f]{64}$/);
  // session 1 had 2 user turns (< 8): invalid, so session 2 re-ran index 1 (reissueOf) and next is 2
  assert.equal((await t.study!.status()).next, 2);
  assert.equal(evs[0].study.protocol, 2);
});
