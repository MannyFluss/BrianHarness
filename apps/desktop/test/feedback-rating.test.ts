// Absorption ratings never reach a bug report (Researcher blinding check, Nov 3 2026): the real Rating.tsx markup
// (per-turn probe + session rating card with the blinding check), rendered with react-dom/server into a minimal DOM,
// is tapped and snapshotted through the real tap / screen recorders; the report built after "Report" carries no
// rating value, checked flag, option label or index, in study AND practice. Plus: check_blinding flags rating leaks
// in reports, and time hidden inside the feedback bracket is not away time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FlightRecorder, KVCredentialStore, MemoryKV, buildFeedbackReport, ratingScrubEvent, type FeedbackReport } from "@brianharness/core/browser";
import { createInProcessTransport } from "../src/transport/in-process.ts";
import { SessionRatingCard, TurnProbe } from "../src/components/Rating.tsx";
import { installScreenRecorder, installTapRecorder, setRecorderStudy } from "../src/feedback/recorder.ts";
import { FeedbackBracket } from "../src/feedback/away.ts";
import { AWAY_MS } from "../src/rating.ts";

const repo = new URL("../../../", import.meta.url).pathname;

// ---------------------------------------------------------------- a minimal DOM (enough for snapshot.ts / recorder.ts)
type Sel = { tag?: string; classes: string[]; attrs: Array<{ name: string; op?: string; value?: string; i?: boolean }> };
const parseCompound = (s: string): Sel => {
  const out: Sel = { classes: [], attrs: [] };
  const re = /^([a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w-]+)(?:([*^$]?=)'([^']*)'(\s+i)?)?\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[1]) out.tag = m[1].toUpperCase();
    else if (m[2]) out.classes.push(m[2]);
    else out.attrs.push({ name: m[3]!, op: m[4], value: m[5], i: !!m[6] });
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return out;
};
const splitTop = (s: string, ch: string) => { const parts: string[] = []; let d = 0, q = false, cur = ""; for (const c of s) { if (c === "'") q = !q; if (!q && c === "[") d++; if (!q && c === "]") d--; if (!q && !d && (ch === " " ? /\s/.test(c) : c === ch)) { if (cur.trim()) parts.push(cur.trim()); cur = ""; } else cur += c; } if (cur.trim()) parts.push(cur.trim()); return parts; };
class El {
  attrs = new Map<string, string>();
  children: Array<El | string> = [];
  parent: El | null = null;
  value = "";
  constructor(public tagName: string) {}
  get attributes() { return [...this.attrs.keys()].map((name) => ({ name })); }
  getAttribute(n: string) { return this.attrs.has(n) ? this.attrs.get(n)! : null; }
  setAttribute(n: string, v: string) { this.attrs.set(n, v); }
  get classList() { return { contains: (c: string) => (this.getAttribute("class") ?? "").split(/\s+/).includes(c) }; }
  get type() { return this.getAttribute("type") ?? ""; }
  get disabled() { return this.attrs.has("disabled"); }
  get textContent(): string { return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
  get innerText() { return this.textContent; }
  get dataset() { return {} as Record<string, string>; }
  getBoundingClientRect() { return { width: 10, height: 10, top: 10, bottom: 20, left: 10, right: 20 }; }
  private matchOne(c: Sel) {
    if (c.tag && c.tag !== this.tagName) return false;
    for (const k of c.classes) if (!this.classList.contains(k)) return false;
    for (const a of c.attrs) {
      const v = this.getAttribute(a.name);
      if (v === null) return false;
      if (!a.op) continue;
      const [x, y] = a.i ? [v.toLowerCase(), a.value!.toLowerCase()] : [v, a.value!];
      if (a.op === "=" ? x !== y : a.op === "*=" ? !x.includes(y) : a.op === "^=" ? !x.startsWith(y) : !x.endsWith(y)) return false;
    }
    return true;
  }
  matches(sel: string): boolean {
    return splitTop(sel, ",").some((alt) => {
      const chain = splitTop(alt, " ").map(parseCompound);
      if (!this.matchOne(chain.at(-1)!)) return false;
      let i = chain.length - 2, p = this.parent;
      while (i >= 0 && p) { if (p.matchOne(chain[i]!)) i--; p = p.parent; }
      return i < 0;
    });
  }
  closest(sel: string): El | null { for (let e: El | null = this; e; e = e.parent) if (e.matches(sel)) return e; return null; }
  *walk(): Generator<El> { for (const c of this.children) if (typeof c !== "string") { yield c; yield* c.walk(); } }
}
const VOID = new Set(["input", "br", "img", "hr", "meta", "link"]);
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function fakeDocument(html: string) {
  const root = new El("BODY");
  let cur = root;
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[5]) { cur.children.push(decode(m[5])); continue; }
    if (m[1]) { cur = cur.parent ?? root; continue; }
    const el = new El(m[2]!.toUpperCase());
    for (const a of m[3]!.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) el.setAttribute(a[1]!, decode(a[2] ?? ""));
    el.parent = cur; cur.children.push(el);
    if (el.tagName === "TEXTAREA") el.value = "";
    if (!m[4] && !VOID.has(m[2]!.toLowerCase())) cur = el;
  }
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  const win = { innerHeight: 4000, innerWidth: 4000, addEventListener() {}, removeEventListener() {} };
  const doc = {
    body: root, defaultView: win, documentElement: { dataset: {} as Record<string, string> },
    querySelectorAll: (sel: string) => [...root.walk()].filter((e) => e.matches(sel)),
    querySelector: (sel: string) => [...root.walk()].find((e) => e.matches(sel)) ?? null,
    addEventListener: (t: string, f: (e: unknown) => void) => { listeners.set(t, [...(listeners.get(t) ?? []), f]); },
    removeEventListener: (t: string, f: (e: unknown) => void) => { listeners.set(t, (listeners.get(t) ?? []).filter((x) => x !== f)); },
    click: (el: El) => { for (const f of listeners.get("click") ?? []) f({ target: el }); },
  };
  return doc;
}
(globalThis as { MutationObserver?: unknown }).MutationObserver ??= class { observe() {} disconnect() {} };
(globalThis as { React?: unknown }).React ??= React; // tsx compiles the app's .tsx with the classic JSX runtime here
const h = React.createElement;

// ---------------------------------------------------------------- the flow: rate probe + session rating, then Report
function ratingPage() {
  const html = renderToStaticMarkup(h("div", { className: "eeg-app", "data-layout": "phone" },
    h("div", null, h("div", { "data-msg-role": "assistant" }, "What hooked you about tide pools?")),
    h(TurnProbe, { onRate: () => {}, onSkip: () => {} }),
    h(SessionRatingCard, { open: true, study: true, phone: true, onClose: () => {} }),
  ));
  return { html, doc: fakeDocument(html) };
}
const RATING_TEXT = /Absorption|not at all|completely|How absorbed|Overall, how absorbed|Which session|What hooked you\?|Adaptive|Baseline|No idea|tide pools hooked me/;
async function rateAndReport(inStudy: boolean) {
  const rec = new FlightRecorder();
  const t = createInProcessTransport({
    storageKV: new MemoryKV(), settingsKV: new MemoryKV(), secretKV: new MemoryKV(), uploadKV: new MemoryKV(), credentials: new KVCredentialStore(new MemoryKV()),
    fetchImpl: (async () => new Response("{}", { status: 404 })) as typeof fetch, streaming: false, platform: "ios-phone", uploadAutoSchedule: false,
    download: () => true, recorder: rec, // the same recorder: rate() through the transport must not add anything either
  });
  if (inStudy) await t.study!.enable();
  await t.newSession();
  for (let i = 0; i < 3; i++) await t.reply({ text: `tide pools ${i}`, events: [], sentAt: Date.now(), shownAt: Date.now() - 900 });
  const ctx = await t.feedback!.context();
  assert.equal(ctx.study.inStudy, inStudy);
  setRecorderStudy(inStudy); rec.study = inStudy;
  const { doc, html } = ratingPage();
  assert.match(html, /data-rating-option/); assert.doesNotMatch(html, /data-rating="\d"/, "no value attribute on the 1-5 buttons");
  const stopTap = installTapRecorder(doc as never, rec);
  const screen = installScreenRecorder(doc as never, rec, 1);
  const probe = doc.querySelectorAll("[data-rating-probe='turn'] [data-rating-option]");
  const session = doc.querySelectorAll("[data-rating-probe='session'] [data-rating-option]");
  assert.equal(probe.length, 5); assert.equal(session.length, 5);
  // per-turn probe: tap 4 (the probe closes after one tap; the snapshot is taken with it on screen)
  screen.snapshotNow();
  doc.click(probe[3]!); // keyboard Enter / Space on a <button> dispatches this same click
  await t.rate!({ scope: "turn", turn: 2, value: 4, shownAt: 1, answeredAt: 2, dismissed: false });
  // session rating: 2 checked, "What hooked you?" filled, blinding check answered, Done
  session[1]!.setAttribute("aria-checked", "true");
  doc.querySelector("[data-rating-probe='session'] textarea")!.value = "tide pools hooked me";
  doc.click(session[1]!);
  const blind = doc.querySelectorAll("[data-blind]");
  assert.equal(blind.length, 3);
  blind[0]!.setAttribute("aria-checked", "true"); doc.click(blind[0]!);
  screen.snapshotNow();
  doc.click(doc.querySelector("[data-rating-done]")!);
  await t.rate!({ scope: "session", turn: 3, value: 2, shownAt: 1, answeredAt: 2, dismissed: false, hooked: "tide pools hooked me", blindGuess: "adaptive" });
  // Report: the screen as it was when the sheet opened, then the report
  screen.snapshotNow();
  rec.record("state", { event: "report_open", trigger: "sidebar" });
  stopTap(); screen.stop(); setRecorderStudy(false);
  const report = buildFeedbackReport({ events: rec.events(), chatTurns: [{ role: "assistant", text: "What hooked you about tide pools?" }], header: { build: "2031", platform: "ios-phone", note: "rating looked odd", sessionId: ctx.sessionId, study: ctx.study, trigger: "sidebar", appState: { overlays: ["turn-probe", "session-rating"] } } });
  return { report, rec, ctx };
}
const controlsOf = (r: FeedbackReport) => r.payload.events.flatMap((e) => (e.type === "screen" ? ((e.data as { controls?: Array<Record<string, unknown>> }).controls ?? []) : []));
const tapsOf = (r: FeedbackReport) => r.payload.events.filter((e) => e.type === "tap").map((e) => e.data as Record<string, unknown>);
function assertNoRating(r: FeedbackReport, raw: string) {
  const body = JSON.stringify({ ...r, payload: { ...r.payload, header: { ...r.payload.header, study: null } } }); // header.study.index = the study session number (allowed)
  for (const s of [body, raw]) {
    assert.doesNotMatch(s, /"checked"|"selected"|"pressed"/, "no checked / selected / pressed flag");
    assert.doesNotMatch(s, /"(?:rating|ratings|absorption|hooked|blindGuess|value)"\s*:/, "no rating / value keys");
    assert.doesNotMatch(s, RATING_TEXT, "no rating question, end labels, option labels or hooked text");
    assert.doesNotMatch(s, /"(?:name|label)":"\s*[1-5]\s*"/, "no 1-5 digit as a name / label");
    assert.doesNotMatch(s, /"index":\s*\d/, "no option index");
  }
  const taps = tapsOf(r);
  assert.deepEqual(taps.map((x) => x.name), ["rating option", "rating option", "blinding-check option", "rating control"]);
  for (const x of taps) assert.deepEqual(Object.keys(x).sort(), ["control", "name", "screen"]);
  const generic = controlsOf(r).filter((c) => /option|rating /.test(String(c.label)));
  assert.ok(generic.filter((c) => c.label === "rating option").length >= 10, "both 1-5 rows recorded, generically");
  for (const c of generic) assert.deepEqual(Object.keys(c).sort(), ["control", "label"], `generic only: ${JSON.stringify(c)}`);
  // checking an option does not even produce a new screen event (the snapshot cannot tell before from after)
  assert.equal(r.payload.events.filter((e) => e.type === "screen").length, 1);
}

test("study: rating the probe + the session rating, then Report: no rating value, checked flag or rating label anywhere", async () => {
  const { report, rec, ctx } = await rateAndReport(true);
  assert.deepEqual(Object.keys(report.payload.header.study), ["inStudy", "index"]);
  assertNoRating(report, JSON.stringify(rec.events()));
  // check_blinding: the report inside a study session log and as an exported .json both pass
  const dir = mkdtempSync(join(tmpdir(), "bh-fb-rating-"));
  writeFileSync(join(dir, "s.jsonl"), `${JSON.stringify({ type: "session_start", sessionId: ctx.sessionId, study: { index: ctx.study.index, total: 10, protocol: 3 } })}\n${JSON.stringify({ type: "feedback_report", ...report })}\n`);
  writeFileSync(join(dir, "bh-feedback-x.json"), JSON.stringify(report));
  const out = execFileSync("node", [join(repo, "tools/phaseD/check_blinding.mjs"), dir], { encoding: "utf8" });
  assert.match(out, /2 files: 2 study \(0 practice, no protocol, 1 report \.json\)/); assert.match(out, /; 0 leaks/);
});

test("practice (non-study): rating controls are redacted the same way", async () => {
  const { report, rec } = await rateAndReport(false);
  assert.deepEqual(report.payload.header.study, { inStudy: false, index: null });
  assertNoRating(report, JSON.stringify(rec.events()));
});

test("core backstop + check_blinding: a rating value that slips into an event is scrubbed / flagged", () => {
  const leakyTap = { ts: 1, type: "tap" as const, data: { name: "4", control: "radio", screen: "turn-probe" } };
  const leakyScreen = { ts: 2, type: "screen" as const, data: { screen: "session-rating", overlays: ["session-rating"], controls: [{ label: "2", control: "radio", checked: true }, { label: "rating option", control: "radio", checked: true }, { label: "Skip", control: "button" }], rating: { value: 2 }, hooked: "x" } };
  assert.deepEqual(ratingScrubEvent(leakyTap).data, { name: "rating option", control: "radio", screen: "turn-probe" });
  assert.deepEqual(ratingScrubEvent(leakyScreen).data, { screen: "session-rating", overlays: ["session-rating"], controls: [{ label: "rating option", control: "radio" }, { label: "rating option", control: "radio" }, { label: "Skip", control: "button" }] });
  const rec = new FlightRecorder();
  rec.record(leakyTap.type, leakyTap.data);
  assert.deepEqual(rec.events()[0]!.data, { name: "rating option", control: "radio", screen: "turn-probe" }, "scrubbed at record time");
  const built = buildFeedbackReport({ events: [leakyTap, leakyScreen], chatTurns: [], header: { note: "", study: null } });
  assert.doesNotMatch(JSON.stringify(built), /"checked"|"name":"4"|"label":"2"|"hooked"|"rating"/, "scrubbed at build time too");
  // the checker flags a report that carries a value (e.g. one made by an older build)
  const bad = mkdtempSync(join(tmpdir(), "bh-fb-rating-leak-"));
  writeFileSync(join(bad, "s.jsonl"), `${JSON.stringify({ type: "session_start", study: { index: 1, total: 10, protocol: 3 } })}\n${JSON.stringify({ type: "feedback_report", schema: "brianharness-feedback/1", payload: { events: [leakyTap, leakyScreen] } })}\n`);
  let out = "";
  try { execFileSync("node", [join(repo, "tools/phaseD/check_blinding.mjs"), bad], { encoding: "utf8", stdio: "pipe" }); } catch (e) { out = String((e as { stdout?: string }).stdout); }
  for (const why of ["rating value as name", "rating value as label", "rating control state", "checked radio on a rating screen", "rating key"]) assert.ok(out.includes(why), `${why} in:\n${out}`);
});

test("away time: hidden time inside the feedback bracket (e.g. the iOS share sheet) is not away", () => {
  const b = new FeedbackBracket();
  const t0 = 1_000_000;
  b.open(t0); // Report opened
  // share sheet: hidden for 25 min while the sheet is still open -> 0 ms away
  assert.equal(b.awayMs(t0 + 1000, t0 + 1000 + 25 * 60_000), 0);
  b.close(t0 + 26 * 60_000);
  // hidden 1 min before closing the sheet, then 30 min after: only the 30 min count
  assert.equal(b.awayMs(t0 + 25 * 60_000, t0 + 56 * 60_000), 30 * 60_000);
  assert.ok(b.awayMs(t0 + 25 * 60_000, t0 + 56 * 60_000) >= AWAY_MS);
  // hidden entirely outside any bracket: all of it counts
  assert.equal(b.awayMs(t0 + 60 * 60_000, t0 + 70 * 60_000), 10 * 60_000);
  b.open(t0 + 80 * 60_000); b.open(t0 + 81 * 60_000); // a second open while open is ignored
  b.close(t0 + 82 * 60_000);
  assert.equal(b.overlap(t0 + 79 * 60_000, t0 + 90 * 60_000), 2 * 60_000);
});
