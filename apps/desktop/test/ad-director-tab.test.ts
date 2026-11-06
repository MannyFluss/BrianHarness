// E6: the Director tab UI. Blinded sessions render no tab DOM and no tab-only field (through the real
// LiveAdController + session, and from the R2 sim); tab_visible renders the three layers; Reduce Motion fades the
// injection line instead of moving it; the shared calibration driver saves per orientation.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
(globalThis as { React?: typeof React }).React = React;
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AdStorage, CalibrationStore, SyntheticGazeTracker, simActor, simDirector, runSimSession, primaryOrientation, type SimReplay } from "@brianharness/core/actor-director/browser";
import { loadO200k } from "@brianharness/core/actor-director";
import { TAB_ONLY_FIELDS, type BhAdEvent, type ScreenInfo, type SessionType } from "@brianharness/core/ad-contracts";
import { MemoryKV } from "@brianharness/core/browser";
import { AdApp } from "../src/ad/AdApp.tsx";
import { InjectionLine } from "../src/ad/InjectionLine.tsx";
import { runCalibration } from "../src/ad/Calibration.tsx";
import { LiveAdController, blindedView, calibrationSummary, visibleView, staticController, type AdStore } from "../src/ad/controller.ts";

const counter = loadO200k();
const IPAD: ScreenInfo = { deviceModel: "iPad13,4", platform: "ios", orientation: "landscape_left", widthPt: 1194, heightPt: 834, scale: 2, webview: { x: 0, y: 0, width: 1194, height: 834 }, widthMm: 229.8 };
const PARAS = ["Starters need feeding every day.", "Rye ferments faster than wheat.", "Use 75 percent hydration for a first loaf."];
const FAKE: SimReplay[] = [{ name: "fake", file: { screen: IPAD, samples: [] }, turn: { aois: PARAS.map((text, i) => ({ id: `a.p${i + 1}`, order: i + 1, text })) } } as unknown as SimReplay];

/** tab DOM: every data-ad-* attribute that only the tab layer may render */
const TAB_DOM = ["data-ad-tab", "data-ad-card", "data-ad-mark", "data-ad-share", "data-ad-waiting", "data-ad-injection", "data-ad-minimap", "data-ad-live", "data-ad-summary", "data-ad-hypotheses", "data-ad-ticker", "data-ad-hint", "data-ad-evidence", "data-ad-highlight", "data-ad-tab-toggle", "data-ad-session-line"];
const BLINDED_DOM_OK = new Set(["data-ad-app", "data-ad-badge", "data-ad-camera-indicator", "data-ad-chat", "data-ad-composer", "data-ad-mode-badge", "data-ad-models-toggle"]);
const TAB_ONLY = Object.values(TAB_ONLY_FIELDS).flat();

function assertNoTab(html: string, lines: readonly BhAdEvent[], label: string) {
  for (const a of TAB_DOM) assert.ok(!html.includes(a + "="), `${label}: ${a} in blinded DOM`);
  for (const a of new Set(html.match(/data-ad-[a-z-]+/g) ?? [])) assert.ok(BLINDED_DOM_OK.has(a), `${label}: unexpected ${a}`);
  for (const f of TAB_ONLY) assert.ok(!html.includes(f), `${label}: tab-only field ${f}`);
  assert.ok(!html.includes("[Context for your next reply"), `${label}: hint text`);
  // every sealed value the session produced stays out: note ids, hint texts, Director summaries, rail codes
  for (const l of lines) {
    if (l.type === "injection") { assert.ok(!html.includes(l.actor_text.slice(0, 40)), `${label}: actor_text`); assert.ok(!new RegExp(`\\b${l.note_id}\\b`).test(html), `${label}: note id ${l.note_id}`); }
    if (l.type === "director_call" && l.output) { assert.ok(!html.includes(l.output.summary), `${label}: summary`); if (l.output.note) assert.ok(!html.includes(l.output.note.observation.text), `${label}: observation`); }
    if (l.type === "rail_check") for (const c of l.blocked_by) assert.ok(!html.includes(c), `${label}: rail ${c}`);
  }
}
const render = (store: AdStore, layout: "phone" | "tablet", extra: Record<string, unknown> = {}) => renderToStaticMarkup(React.createElement(AdApp, { store, layout, tabOpen: true, ...extra }));

async function liveSession(sessionType: SessionType, turns = 4) {
  let now = 1000;
  const c = await LiveAdController.open({
    sessionType, arm: "on", sessionId: `ui-${sessionType}`, userId: "u", actor: simActor(FAKE), director: simDirector(), counter, kv: new MemoryKV(),
    tracker: null, screen: IPAD, calibration: null, consent: { camera: true, rawGaze: false }, now: () => now,
  });
  try {
    for (let k = 0; k < turns; k++) {
      now += 4000; c.composerKey!(now); c.composerTap!(600, 780, now);
      await new Promise((r) => setTimeout(r, 5));
      now += 1200; await c.send!(`question ${k}?`);
    }
  } finally { c.dispose(); }
  return { c, lines: (c as unknown as { log: { lines: BhAdEvent[] } }).log.lines };
}

test("E6 UI: blinded session through the real controller: no tab DOM, no tab-only field, no sealed value; view has no tab data", async () => {
  const { c, lines } = await liveSession("blinded");
  // the Director did run (notes, rail checks, an injection decision); the UI just never sees any of it
  assert.ok(lines.filter((l) => l.type === "director_call" && l.output?.note).length >= 3, "blinded session had Director notes");
  assert.ok(lines.some((l) => l.type === "injection") && lines.some((l) => l.type === "rail_check" && !l.pass));
  const v = c.getSnapshot();
  assert.equal(v.sessionType, "blinded");
  assert.deepEqual([v.tab, v.pending, v.live, v.events], [null, null, null, []]);
  assert.equal(c.live(), null);
  const json = JSON.stringify(v);
  for (const f of [...TAB_ONLY, "note_id", "actor_text", "output", "hint", "railCodes"]) assert.ok(!json.includes(`"${f}"`), `view has ${f}`);
  assert.deepEqual(Object.keys(v.chat[0]!).sort(), ["id", "role", "text"]);
  for (const layout of ["phone", "tablet"] as const) {
    const html = render(c, layout, { holdInjection: "t2", selectedCard: "t2", reduceMotion: true });
    assertNoTab(html, lines, `blinded/${layout}`);
    assert.match(html, /data-ad-badge="true"[^>]*>Study session</);
    assert.match(html, /data-msg="a4"/);
  }
});

test("E6 UI: tab_visible through the real controller: three layers, cards, share bar, margin mark, pending note; keystroke times only", async () => {
  const { c, lines } = await liveSession("tab_visible");
  const v = c.getSnapshot();
  assert.equal(v.sessionType, "tab_visible");
  assert.ok(v.tab && v.tab.cards.length === 4);
  for (const layout of ["phone", "tablet"] as const) {
    const html = render(c, layout);
    for (const a of ["data-ad-tab", "data-ad-card", "data-ad-share", "data-ad-summary", "data-ad-minimap", "data-ad-live", "data-ad-tab-toggle"]) assert.ok(html.includes(a + "="), `${layout}: ${a}`);
    if (lines.some((l) => l.type === "actor_turn" && l.note_id)) assert.ok(html.includes("data-ad-mark="), `${layout}: margin mark`);
    assert.match(html, /Director tab</);
  }
  // keystroke times never reach the log (v1): no keys/intervals field anywhere
  assert.ok(!JSON.stringify(lines).match(/"keystrokes":\[[^\]]/));
});

test("E6 UI: pending note waits at the composer until Send (tab_visible only)", async () => {
  let now = 1000;
  const c = await LiveAdController.open({ sessionType: "tab_visible", arm: "on", sessionId: "p", userId: "u", actor: simActor(FAKE), director: simDirector(), counter, kv: new MemoryKV(), tracker: null, screen: IPAD, calibration: null, consent: { camera: true, rawGaze: false }, now: () => now });
  try {
    assert.equal(c.getSnapshot().pending, null, "no Director call before the first keystroke");
    now += 3000; c.composerKey!(now);
    for (let i = 0; i < 50 && c.getSnapshot().pending?.state !== "waiting"; i++) { await new Promise((r) => setTimeout(r, 10)); (c as unknown as { tick(): void }).tick(); }
    const v = c.getSnapshot();
    assert.equal(v.pending?.state, "waiting");
    assert.match(v.pending!.hint ?? "", /^\[Context for your next reply/);
    const html = render(c, "tablet");
    assert.ok(html.includes("data-ad-waiting") && html.includes('data-ad-card="pending"'));
  } finally { c.dispose(); }
  // blinded: the session itself refuses to expose the pending call
  const b = await LiveAdController.open({ sessionType: "blinded", arm: "on", sessionId: "pb", userId: "u", actor: simActor(FAKE), director: simDirector(), counter, kv: new MemoryKV(), tracker: null, screen: IPAD, calibration: null, consent: { camera: true, rawGaze: false }, now: () => now });
  try {
    now += 3000; b.composerKey!(now);
    await new Promise((r) => setTimeout(r, 30));
    const sess = (b as unknown as { session: { peekPending(): unknown; pendingTurn?: unknown } }).session;
    assert.equal(sess.peekPending(), null);
    assert.equal(b.getSnapshot().pending, null);
    assert.ok(!render(b, "tablet").includes("data-ad-waiting"));
  } finally { b.dispose(); }
});

test("E6 UI: Reduce Motion fades the injection line instead of moving it", () => {
  const full = renderToStaticMarkup(React.createElement(InjectionLine, { from: "t2", active: true, reduceMotion: false }));
  const reduced = renderToStaticMarkup(React.createElement(InjectionLine, { from: "t2", active: true, reduceMotion: true }));
  assert.match(full, /data-ad-injection="ad-travel"/); assert.match(full, /data-ad-motion="full"/);
  assert.match(reduced, /data-ad-injection="ad-fade"/); assert.match(reduced, /data-ad-motion="reduce"/);
  const css = readFileSync(new URL("../src/ad/ad.css", import.meta.url), "utf8");
  const rm = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.ok(rm.includes(".ad-pulse") && rm.includes("animation: none") && rm.includes("offset-distance: 100%"));
  assert.ok(!/\.ad-fade[^{]*\.ad-runner/.test(css), "no runner in the fade variant");
});

test("E6 UI: shared calibration driver (iPad13,4 landscape primary): fits, saves per orientation, distance in the record", async () => {
  let now = 1000;
  const tracker = new SyntheticGazeTracker({ screen: IPAD, now: () => now, noisePt: 4, distCm: 46 });
  await tracker.start({ mode: "synthetic", webNow: now });
  const dots: string[] = [];
  const r = await runCalibration({
    tracker, screen: IPAD, paraHeightPx: 96, now: () => now, wall: () => 0,
    sleep: async (ms) => { now += ms; tracker.pump(now); }, onDot: (t) => t && dots.push(t.id), simLook: (x, y) => tracker.simLook(x, y),
  });
  assert.equal(dots.length, 13);
  assert.equal(r.recommend, "use"); assert.equal(r.record.orientation, primaryOrientation("iPad13,4"));
  assert.ok(r.record.distCm && Math.abs(r.record.distCm - 46) < 1);
  const store = new CalibrationStore(await AdStorage.open(new MemoryKV()));
  store.save(r.record);
  assert.deepEqual(store.orientations("iPad13,4"), ["landscape_left"]);
  assert.equal(store.load("iPad13,4", "portrait"), null);
});

const R2 = "/workspace/actor-director/research/R2/gaze-replays";
const loadR2 = (names: string[]): SimReplay[] => names.map((name) => ({ name, file: JSON.parse(readFileSync(join(R2, name + ".json"), "utf8")), turn: JSON.parse(readFileSync(join(R2, name + ".truth.json"), "utf8")).turn }));
test("E6 UI: R2 20-turn sim renders in the tab; the blinded sim renders chat only", { skip: !existsSync(R2) && "R2 research data not present" }, async () => {
  const replays = loadR2(["ipadpro11-m1-landscape-01", "ipadpro11-m1-landscape-02"]);
  const vis = await runSimSession({ turns: 20, counter, replays, kv: new MemoryKV() });
  const chat = vis.chat.map(({ id, role, text }) => ({ id, role, text }));
  const html = render(staticController(visibleView(vis.lines, chat, { calibration: calibrationSummary(null) })), "tablet");
  assert.equal((html.match(/data-ad-card="t\d+"/g) ?? []).length, 19);
  assert.ok((html.match(/data-ad-mark=/g) ?? []).length >= 3);
  const bl = await runSimSession({ turns: 20, sessionType: "blinded", counter, replays, kv: new MemoryKV() });
  const bhtml = render(staticController(blindedView(bl.chat, calibrationSummary(null))), "phone");
  assertNoTab(bhtml, bl.lines, "blinded R2");
  // negative control: the same check fails on a tab_visible render
  assert.throws(() => assertNoTab(html, vis.lines, "control"));
});
