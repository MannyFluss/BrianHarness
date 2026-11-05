/**
 * E6 demo snapshots for the Director tab screenshots (dev only, never shipped):
 *   npx tsx scripts/ad-demo.ts [outDir=/workspace/ad-scratch/demo]
 * Runs the 20-turn mock session over the R2 gaze replays (truth.json: only `turn` layout/AOIs are read; labels
 * never), with no network, and writes:
 *   <dev>-waiting.json   tab_visible, reading window of a(N-1) closed, Director note for aN waiting for Send
 *   <dev>-injected.json  tab_visible, right after aN used the note (margin mark, newest card fresh)
 *   <dev>-blinded.json   blinded: chat + calibration only (no lines exist in the file)
 *   cal-<dev>-good.json / cal-<dev>-bad.json  calibration results; replays.json for the live mode
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSimSession, loadO200k, buildTabModel, CalibrationRun, SyntheticGazeTracker, type SimReplay } from "../packages/core/src/actor-director/index.ts";
import { MemoryKV } from "../packages/core/src/platform/kv.ts";
import type { BhAdEvent, ScreenInfo } from "../packages/core/src/ad-contracts/index.ts";

const OUT = process.argv[2] ?? "/workspace/ad-scratch/demo";
const R2 = process.env.AD_R2 ?? "/workspace/actor-director/research/R2/gaze-replays";
mkdirSync(OUT, { recursive: true });
const load = (names: string[]): SimReplay[] => names.map((name) => ({ name, file: JSON.parse(readFileSync(join(R2, name + ".json"), "utf8")), turn: JSON.parse(readFileSync(join(R2, name + ".truth.json"), "utf8")).turn }));
const net = globalThis.fetch; globalThis.fetch = (async () => { throw new Error("no network in the demo"); }) as typeof fetch;
const counter = loadO200k();
const W = (f: string, v: unknown) => writeFileSync(join(OUT, f), JSON.stringify(v));

const SCREENS: Record<string, ScreenInfo> = {
  ipad: { deviceModel: "iPad13,4", platform: "ios", orientation: "landscape_left", widthPt: 1194, heightPt: 834, scale: 2, webview: { x: 0, y: 0, width: 1194, height: 834 }, widthMm: 229.8 },
  iphone: { deviceModel: "iPhone18,1", platform: "ios", orientation: "portrait", widthPt: 390, heightPt: 844, scale: 3, webview: { x: 0, y: 0, width: 390, height: 844 }, widthMm: 65.9 },
};
async function calibrate(screen: ScreenInfo, move: boolean) {
  let now = 1000;
  const tr = new SyntheticGazeTracker({ screen, now: () => now, noisePt: 5, distCm: 44 });
  const run = new CalibrationRun({ screen, paraHeightPx: 96 });
  await tr.start({ mode: "synthetic", webNow: now });
  await tr.addListener("gaze", (e) => run.push(e.samples));
  await tr.calibrate({ phase: "begin", orientation: run.orientation, targets: run.sequence });
  for (const tg of run.sequence) {
    if (move && tg.id === "v1") tr.setDistortion([1.06, 0, 164, 0, 1.06, 90]);
    tr.lookAt(tg.x, tg.y);
    const w = run.show(tg.id, now);
    now += run.timing.dotMs; tr.pump(now);
    await tr.calibrate({ phase: "target", targetId: tg.id, ...w });
    now += run.timing.gapMs; tr.pump(now);
  }
  await tr.calibrate({ phase: "end" });
  return run.finish({ t: now, at: Date.parse("2026-11-05T00:00:00Z") });
}

const devs = { ipad: ["ipadpro11-m1-landscape-01", "ipadpro11-m1-landscape-02"], iphone: ["iphone17pro-portrait-01", "iphone17pro-portrait-02"] };
const allReplays: SimReplay[] = [];
for (const [dev, names] of Object.entries(devs)) {
  const replays = load(names); allReplays.push(...replays);
  const good = await calibrate(SCREENS[dev]!, false), bad = await calibrate(SCREENS[dev]!, true);
  W(`cal-${dev}-good.json`, good); W(`cal-${dev}-bad.json`, bad);
  const sim = await runSimSession({ turns: 20, counter, replays, kv: new MemoryKV(), sessionId: `demo-${dev}`, distCm: good.record.distCm });
  const L = sim.tabLines; // v1.3: the demo files hold only what the tab may read (no leak_judge)
  // N: the latest request turn whose note was injected, with at least 8 earlier turns of history
  const inj = L.filter((l): l is Extract<BhAdEvent, { type: "injection" }> => l.type === "injection" && l.decision === "inject" && l.turn >= 9 && l.turn <= 14);
  const N = inj[inj.length - 1]!.turn;
  const iUser = L.findIndex((l) => l.type === "user_turn" && l.turn === N - 1);
  const pre = L.slice(0, iUser);
  const dc = L.find((l): l is Extract<BhAdEvent, { type: "director_call" }> => l.type === "director_call" && l.turn === N)!;
  const ij = inj[inj.length - 1]!;
  const chatTo = (ids: Set<string>) => sim.chat.filter((m) => ids.has(m.id)).map(({ id, role, text }) => ({ id, role, text }));
  const ids = (n: number) => new Set([...Array(n + 1).keys()].flatMap((k) => (k < n ? [`a${k}`, `u${k}`] : [`a${k}`])));
  const digestMono = pre[pre.length - 1]!.mono;
  const liveN = sim.live.filter((x) => x.turn === N - 1);
  const base = { sessionType: "tab_visible" as const, live: liveN, calibration: good.record };
  W(`${dev}-waiting.json`, { ...base, lines: pre, chat: chatTo(ids(N - 1)), pending: { turn: N, state: "waiting", output: dc.output, railCodes: [], hint: ij.actor_text }, nowMono: digestMono + 600, injected: null, selected: null });
  const iAct = L.findIndex((l) => l.type === "actor_turn" && l.turn === N);
  const post = L.slice(0, iAct + 1);
  const m = buildTabModel(post);
  const card = m.cards.find((c) => c.turn === N)!;
  // a card with evidence to select (evidence highlight screenshot): the injected card for aN
  W(`${dev}-injected.json`, { ...base, lines: post, chat: chatTo(ids(N)), pending: null, nowMono: post[post.length - 1]!.mono + 400, injected: card.key, selected: card.key, live: sim.live.filter((x) => x.turn === N - 1) });
  // the full run (for the tab-on session with all 20 turns)
  W(`${dev}-full.json`, { ...base, lines: L, chat: sim.chat.map(({ id, role, text }) => ({ id, role, text })), pending: null, nowMono: L[L.length - 1]!.mono + 10000, injected: null, selected: null, live: sim.live.slice(-1) });
  const bl = await runSimSession({ turns: 12, sessionType: "blinded", counter, replays, kv: new MemoryKV(), sessionId: `demo-${dev}-b`, distCm: good.record.distCm });
  W(`${dev}-blinded.json`, { sessionType: "blinded", chat: bl.chat.map(({ id, role, text }) => ({ id, role, text })), calibration: good.record });
  console.log(dev, "N =", N, "cards", m.cards.length, "share", m.share?.words, "cal", good.words, "/", bad.words);
}
W("replays.json", allReplays.map((r) => ({ name: r.name, file: { screen: r.file.screen, samples: r.file.samples }, turn: r.turn })));
globalThis.fetch = net;
