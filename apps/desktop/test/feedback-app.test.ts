// In-app bug report in the in-process app: chat / state events from the transport, delivery (201, 404 -> export,
// no token -> export + queued), BHExport share fallback, nothing touches study / session records, triggers, and
// mid-study reports in BOTH arms pass check_blinding and are indistinguishable in shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlightRecorder, KVCredentialStore, MemoryKV, UNSEAL_PHRASE, buildFeedbackReport, type ExportFile, type FeedbackReport } from "@brianharness/core/browser";
import { createInProcessTransport } from "../src/transport/in-process.ts";
import { isReportShortcut, chatTurnsOf } from "../src/feedback/report.ts";
import { feedbackFileName } from "../src/transport/feedback.ts";
import { resultText } from "../src/components/FeedbackSheet.tsx";

const TOKEN = "bhd_fake_device_token_1234";
const repo = new URL("../../../", import.meta.url).pathname;

function worker(feedback: number | (() => Response)) {
  const posts: Array<{ path: string; body: string }> = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.pathname === "/v1/feedback") {
      posts.push({ path: u.pathname, body: String(init?.body) });
      if (typeof feedback === "function") return feedback();
      return new Response(JSON.stringify(feedback === 201 ? { id: JSON.parse(String(init?.body)).report_id, received_at: "2026-11-03T08:00:00Z" } : { error: { code: feedback === 404 ? "not_found" : "invalid_feedback_envelope", field: "kind", permanent: true } }), { status: feedback });
    }
    if (u.pathname === "/v1/sessions") { posts.push({ path: u.pathname, body: String(init?.body) }); return new Response(JSON.stringify({ id: "x" }), { status: 201 }); }
    return new Response(JSON.stringify({ models: [] }), { status: 200 });
  }) as typeof fetch;
  return { f, posts };
}
function app(o: { feedback?: number | (() => Response); bhExport?: boolean } = {}) {
  const w = worker(o.feedback ?? 404);
  const rec = new FlightRecorder();
  const downloads: ExportFile[][] = [];
  const shares: ExportFile[][] = [];
  const bhExport = o.bhExport ? { share: async ({ files }: { files: ExportFile[] }) => { shares.push(files); return { completed: true, activityType: "com.apple.DocumentManagerUICore.SaveToFiles" }; }, saveToDocuments: async () => ({ dir: "/d", paths: [] }) } : undefined;
  const t = createInProcessTransport({
    storageKV: new MemoryKV(), settingsKV: new MemoryKV(), secretKV: new MemoryKV(), uploadKV: new MemoryKV(), credentials: new KVCredentialStore(new MemoryKV()),
    fetchImpl: w.f, streaming: false, platform: "ios-phone", appVersion: "0.4.0", build: "2031", uploadAutoSchedule: false,
    download: (files) => (downloads.push(files), true), recorder: rec, ...(bhExport ? { bhExport } : {}),
  });
  return { t, w, rec, downloads, shares };
}
async function makeReport(t: ReturnType<typeof app>["t"], rec: FlightRecorder, note = "reply cut off", turns: Array<{ role: "user" | "assistant"; text: string }> = []) {
  const ctx = await t.feedback!.context();
  return buildFeedbackReport({ events: rec.events(), chatTurns: turns, header: { build: "2031", appVersion: "0.4.0", platform: t.platform, note, sessionId: ctx.sessionId, study: ctx.study, trigger: "sidebar" } });
}

test("transport records chat + backend state events; context() gives the session id and coarse study state", async () => {
  const { t, rec } = app();
  const s = await t.newSession();
  await t.reply({ text: "hello there", events: [], sentAt: Date.now(), shownAt: Date.now() - 500 });
  const chat = rec.events().filter((e) => e.type === "chat");
  assert.ok(chat.length >= 2, "opening line + reply");
  const c = chat.at(-1)!.data as Record<string, unknown>;
  assert.equal(c.backend, "mock"); assert.equal(c.status, null); assert.equal(c.error, null); assert.equal(c.truncated, false);
  assert.ok("max_tokens" in c && "finish_reason" in c && "usage" in c && "ms" in c);
  assert.ok(rec.events().some((e) => e.type === "state" && (e.data as { event?: string }).event === "backend"));
  assert.deepEqual(await t.feedback!.context(), { sessionId: s.sessionId, study: { inStudy: false, index: null } });
});

test("delivery: 201 -> sent (exact report bytes, device token); no export", async () => {
  const { t, w, rec, downloads } = app({ feedback: 201 });
  await t.providers.select("mock"); // these tests chat on Mock; a stored token alone now means Spider Cloud (c114b0a)
  await t.providers.setApiKey("spider", TOKEN);
  await t.newSession();
  const r = await makeReport(t, rec);
  const res = await t.feedback!.send(r);
  assert.equal(res.state, "sent"); assert.equal(res.queued, false);
  const fb = w.posts.filter((p) => p.path === "/v1/feedback");
  assert.equal(fb.length, 1); assert.equal(fb[0]!.body, JSON.stringify(r));
  assert.equal(downloads.length, 0);
  assert.equal(resultText(res), "Report sent. Thank you!");
});

test("delivery: 404 (endpoint not deployed) -> exported as one .json, not queued, never retried", async () => {
  const { t, w, rec, downloads } = app({ feedback: 404 });
  await t.providers.select("mock"); // these tests chat on Mock; a stored token alone now means Spider Cloud (c114b0a)
  await t.providers.setApiKey("spider", TOKEN);
  await t.newSession();
  const r = await makeReport(t, rec);
  const res = await t.feedback!.send(r);
  assert.equal(res.state, "exported"); assert.equal(res.queued, false); assert.equal(res.status, 404);
  assert.equal(downloads.length, 1); assert.equal(downloads[0]!.length, 1);
  assert.equal(downloads[0]![0]!.name, feedbackFileName(r)); assert.match(downloads[0]![0]!.name, /^bh-feedback-\d{8}-\d{4}-[0-9a-f]{8}\.json$/);
  assert.deepEqual(JSON.parse(downloads[0]![0]!.content), r);
  await t.uploads!.flush(); await t.uploads!.flush();
  assert.equal(w.posts.filter((p) => p.path === "/v1/feedback").length, 1, "no loop");
  assert.match(resultText(res), /isn't live yet/);
  const st = await t.uploads!.status();
  assert.equal(st.needsExport, 0, "the study-log Export prompt is not raised");
});

test("delivery: 422 invalid_feedback_envelope -> exported; no token -> exported AND kept queued; iOS -> BHExport share sheet", async () => {
  const a = app({ feedback: 422 });
  await a.t.providers.setApiKey("spider", TOKEN);
  const ra = await a.t.feedback!.send(await makeReport(a.t, a.rec));
  assert.deepEqual([ra.state, ra.queued, ra.status], ["exported", false, 422]);
  const b = app({ feedback: 201, bhExport: true });
  const r = await makeReport(b.t, b.rec);
  const rb = await b.t.feedback!.send(r);
  assert.deepEqual([rb.state, rb.queued, rb.reason], ["exported", true, "no-token"]);
  assert.equal(b.shares.length, 1); assert.equal(b.shares[0]![0]!.mimeType, "application/json"); assert.equal(b.downloads.length, 0);
  await b.t.providers.setApiKey("spider", TOKEN); // a token later: the queued report goes out once
  await b.t.uploads!.flush();
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(b.w.posts.filter((p) => p.path === "/v1/feedback").length, 1);
  assert.equal(b.w.posts[0]!.body, JSON.stringify(r));
});

test("sending a report touches no study, schedule, timing or session record", async () => {
  const { t, rec, downloads } = app({ feedback: 404 });
  await t.providers.select("mock"); // these tests chat on Mock; a stored token alone now means Spider Cloud (c114b0a)
  await t.providers.setApiKey("spider", TOKEN);
  await t.study!.enable();
  const s = await t.newSession();
  for (let i = 0; i < 3; i++) await t.reply({ text: `turn ${i} about gardens`, events: [], sentAt: Date.now(), shownAt: Date.now() - 800 });
  const before = { status: await t.study!.status(), hash: await t.study!.hash!(), sessions: await t.sessions(), hud: await t.hud(), uploads: await t.uploads!.status() };
  const jsonl = (fs: ExportFile[]) => fs.filter((f) => f.name.endsWith(".jsonl"));
  await t.exportLogs!(); const logsBefore = jsonl(downloads.pop()!);
  const res = await t.feedback!.send(await makeReport(t, rec));
  assert.equal(res.state, "exported"); downloads.pop();
  const after = { status: await t.study!.status(), hash: await t.study!.hash!(), sessions: await t.sessions(), hud: await t.hud(), uploads: await t.uploads!.status() };
  await t.exportLogs!(); const logsAfter = jsonl(downloads.pop()!);
  assert.ok(logsBefore.length >= 1);
  const { feedback: fb, ...uploadsAfter } = after.uploads;
  assert.deepEqual({ ...after, uploads: uploadsAfter }, before, "study, schedule, sessions, HUD, study-log uploads unchanged");
  assert.deepEqual(fb, { pending: 0, needsExport: 1, done: 0 }, "the report is counted on its own");
  assert.deepEqual(logsAfter, logsBefore, "session files byte-identical");
  assert.equal((await t.feedback!.context()).sessionId, s.sessionId, "same session: nothing started or ended");
});

test("triggers: Cmd/Ctrl+Shift+R only; chat turns = last 6 with cut-off / failed flags", () => {
  const k = (key: string, m: Partial<KeyboardEvent> = {}) => ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...m });
  assert.equal(isReportShortcut(k("R", { metaKey: true, shiftKey: true })), true);
  assert.equal(isReportShortcut(k("r", { ctrlKey: true, shiftKey: true })), true);
  assert.equal(isReportShortcut(k("r", { metaKey: true })), false, "Cmd+R alone is not it");
  assert.equal(isReportShortcut(k("r", { shiftKey: true })), false);
  assert.equal(isReportShortcut(k("r", { metaKey: true, shiftKey: true, altKey: true })), false);
  assert.equal(isReportShortcut(k("h", { metaKey: true, shiftKey: true })), false);
  const msgs = Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, role: (i % 2 ? "user" : "assistant") as "user" | "assistant", text: `t${i}` }));
  msgs[8] = { ...msgs[8]!, cutOff: true } as never; msgs[6] = { ...msgs[6]!, failed: true } as never;
  const turns = chatTurnsOf(msgs as never);
  assert.equal(turns.length, 6); assert.equal(turns[0]!.text, "t3");
  assert.equal(turns[5]!.cutOff, true); assert.equal(turns[3]!.failed, true);
});

// ---- blinding: reports made mid-study in both arms ----
const keyPaths = (v: unknown, p = ""): string[] => {
  if (Array.isArray(v)) return v.flatMap((x) => keyPaths(x, `${p}[]`));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [`${p}.${k}`, ...keyPaths(x, `${p}.${k}`)]);
  return [];
};
test("blinding: mid-study reports in both arms pass check_blinding and have the same shape", async () => {
  const { t, rec } = app({ feedback: 404 });
  await t.study!.enable();
  const order = ((await t.study!.unseal!(UNSEAL_PHRASE)) as { order: string[] }).order;
  const byArm = new Map<string, FeedbackReport>();
  const dir = mkdtempSync(join(tmpdir(), "bh-fb-blind-"));
  for (let n = 0; n < 10 && byArm.size < 2; n++) {
    const s = await t.newSession();
    rec.clear(); // per-session window (the launch-only backend state event would otherwise sit in session 1 only)
    const turns: Array<{ role: "user" | "assistant"; text: string }> = [{ role: "assistant", text: s.director.text }];
    for (let i = 0; i < 8; i++) {
      const r = await t.reply({ text: `I keep thinking about tide pools and old maps ${i}`, events: [], sentAt: Date.now(), shownAt: Date.now() - 900 });
      turns.push({ role: "user", text: `I keep thinking about tide pools and old maps ${i}` }, { role: "assistant", text: r.director.text });
      if (i === 3) {
        const ctx = await t.feedback!.context();
        assert.equal(ctx.study.inStudy, true);
        const arm = order[ctx.study.index! - 1]!;
        rec.record("screen", { screen: "chat", hudOpen: true, controls: [{ label: "Director HUD", control: "button", pressed: true }] });
        // an HTTP failure whose message quotes the response body (what the on-screen ⚠ text shows), with sizes
        const quoted = `HTTP 500: {"error":"upstream said: ${arm} prompt of 2210 tokens, state note 7 lines"}`;
        rec.record("error", { source: "stream", code: "upstream_incomplete", message: quoted, status: 500, partial: false });
        rec.record("chat", { backend: "spider-cloud", model: "m", max_tokens: 4096, status: 500, ms: 12, finish_reason: null, usage: { prompt_tokens: 2210, completion_tokens: null, reasoning_tokens: null }, prompt_chars: 9000, truncated: true, error: { code: "upstream_incomplete", message: quoted }, streamed: true, chars: 0 });
        rec.record("screen", { screen: "chat", messages: [{ role: "assistant", text: `⚠ ${quoted}` }], notices: [quoted, "Reply interrupted: the connection dropped before it finished"] });
        const report = await makeReport(t, rec, "the reply looked odd", [...turns, { role: "assistant", text: `⚠ ${quoted}` }]);
        const raw = JSON.stringify(rec.events());
        assert.ok(!raw.includes("upstream said") && !raw.includes("2210") && !raw.includes("9000"), "the recorder itself never stored the error text or sizes in study");
        if (!byArm.has(arm)) {
          byArm.set(arm, report);
          writeFileSync(join(dir, `bh-feedback-study-${ctx.study.index}.jsonl`), [
            JSON.stringify({ type: "session_start", t: new Date().toISOString(), sessionId: ctx.sessionId, study: { index: ctx.study.index, total: 10, protocol: 3 } }),
            JSON.stringify({ type: "feedback_report", ...report }),
          ].join("\n") + "\n");
        }
      }
    }
    await t.rate!({ scope: "session", turn: 8, value: 4, shownAt: 1, answeredAt: 2, dismissed: false, blindGuess: "no-idea" });
  }
  assert.equal(byArm.size, 2, `both arms covered (${[...byArm.keys()]})`);
  const out = execFileSync("node", [join(repo, "tools/phaseD/check_blinding.mjs"), dir], { encoding: "utf8" });
  assert.match(out, /2 files: 2 study/); assert.match(out, /; 0 leaks/); assert.doesNotMatch(out, /LEAK/);
  // the checker does catch an arm in a report (sanity)
  const bad = mkdtempSync(join(tmpdir(), "bh-fb-leak-"));
  writeFileSync(join(bad, "x.jsonl"), `${JSON.stringify({ type: "session_start", study: { index: 1, total: 10, protocol: 3 } })}\n${JSON.stringify({ type: "feedback_report", payload: { header: { mode: "adaptive" } } })}\n`);
  assert.throws(() => execFileSync("node", [join(repo, "tools/phaseD/check_blinding.mjs"), bad], { encoding: "utf8", stdio: "pipe" }));
  const [a, b] = [...byArm.values()];
  const shape = (r: FeedbackReport) => [...new Set(keyPaths(r))].sort();
  assert.deepEqual(shape(a!), shape(b!), "same key structure in both arms");
  for (const r of [a!, b!]) {
    const body = JSON.stringify(r);
    assert.ok(!/"(?:plan|stateNote|mode|hypothesis|topTopics|topStyles)"/.test(body));
    assert.ok(!/"(?:adaptive|baseline|explore|exploit|relax)"/.test(body));
    assert.deepEqual(Object.keys(r.payload.header.study), ["inStudy", "index"]);
    for (const e of r.payload.events.filter((x) => x.type === "chat")) assert.equal((e.data as { usage: { prompt_tokens: unknown } }).usage.prompt_tokens, null);
    assert.ok(!body.includes("upstream said") && !body.includes("2210") && !body.includes("9000"), "no raw error text / prompt sizes in a study report");
    assert.equal(r.filters.last_error_code, "upstream_incomplete");
    assert.match(r.payload.header.last_error_summary ?? "", /^chat m error upstream_incomplete HTTP 500 \(truncated\)/);
    assert.equal(r.payload.chat_turns.at(-1)!.text, "⚠ [error text omitted]");
  }
});
