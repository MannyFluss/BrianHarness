import { test } from "node:test";
import assert from "node:assert/strict";
import { HarnessSession, KeyphraseTagger, LexiconTagger, MockBackend, OllamaTagger, lexiconTags } from "../src/index.js";

test("lexicon maps ham radio and watch restoration to specific topics with parents", () => {
  const ham = lexiconTags("Last night I worked a station in Japan on ham radio, all in Morse code.");
  assert.equal(ham[0]!.id, "x:ham-radio");
  const watch = lexiconTags("I spent the evening cleaning the movement of a 1960s wristwatch and fitting a new mainspring.");
  assert.ok(watch.some((t) => t.id === "x:watch-restoration"));
  assert.ok(!lexiconTags("we might watch a film tonight").some((t) => t.id === "x:watch-restoration"));
});

test("keyphrase tagger picks up an unlisted recurring interest", async () => {
  const k = new KeyphraseTagger();
  await k.tag("I have been into lock picking for a while");
  const t = await k.tag("lock picking is so satisfying, especially spool pins");
  assert.ok(t.some((x) => x.id === "kp:lock-picking"), JSON.stringify(t));
});

test("ollama tagger parses JSON topics, merges duplicates, falls back to lexicon on error", async () => {
  const fake = (async () => new Response(JSON.stringify({ message: { content: JSON.stringify({ topics: [{ label: "Lock Picking", parent: "programming" }, { label: "", parent: "none" }] }) } }))) as typeof fetch;
  const t = await new OllamaTagger({ model: "m", fetchImpl: fake }).tag("spool pins");
  assert.deepEqual(t.map((x) => [x.id, x.label, x.parent]), [["o:lock-picking", "lock picking", "programming"]]);
  const broken = (async () => { throw new Error("down"); }) as typeof fetch;
  const t2 = await new OllamaTagger({ model: "m", fetchImpl: broken }).tag("my telescope and the stars");
  assert.equal(t2[0]!.id, "space");
});

test("session discovers and labels specific topics; final guesses carry the specific label", async () => {
  let clock = 0;
  const s = new HarnessSession({ userId: "g", backend: new MockBackend(1), store: null, clock: () => clock, tagger: new LexiconTagger() });
  await s.start();
  for (const txt of ["ham radio contests are my thing, morse code at 30 wpm", "I worked a DX station in Chile on my ham radio antenna last weekend, amazing", "morse code practice every morning before work, ham radio keeps me sharp"]) {
    clock += 20000;
    await s.reply(txt);
  }
  const g = s.finalGuesses(3);
  assert.equal(g[0]!.topic, "x:ham-radio");
  assert.equal(g[0]!.label, "amateur (ham) radio");
});

test("keyphrase roll-up: child phrases consolidate on the parent; unknown passions stay findable; filler is dropped", async () => {
  const { HarnessSession, MockBackend, KeyphraseTagger, InterestMap } = await import("../src/index.js");
  // filler / generic phrases never become topics
  const kt = new KeyphraseTagger();
  for (const t of ["honestly mostly the stars", "honestly mostly cooking", "honestly mostly code"]) await kt.tag(t);
  const tags = await kt.tag("honestly mostly nothing");
  assert.ok(!tags.some((t) => /honestly|mostly/.test(t.id)), JSON.stringify(tags));

  // children don't fragment the hypothesis: evidence on kp children rolls into the parent
  const m = InterestMap.fresh("u");
  m.defineTopic("kp:telescope-mirror", "telescope mirror", "space");
  m.defineTopic("kp:star-party", "star party", "space");
  m.observeTopic("kp:telescope-mirror", 0.9, 1);
  m.observeTopic("kp:star-party", 0.9, 1);
  m.observeTopic("space", 0.85, 2);
  m.observeTopic("cooking", 0.4, 2);
  assert.equal(m.hypothesis(), "space");
  assert.equal(m.topTopics(3)[0]![0], "space");
  assert.ok(!m.topTopics(3).some(([t]) => t.startsWith("kp:")));

  // a passion with no lexicon topic at all is still found, under its own open-vocab label
  let clock = 0;
  const s = new HarnessSession({ userId: "u", backend: new MockBackend(1), store: null, tagger: { kind: "keyphrase" }, clock: () => clock, seed: 3 });
  await s.start();
  const lines = ["lockpicking, i practice lockpicking every night", "the lockpicking pins are so satisfying!! lockpicking forever", "meh", "lockpicking again, new lockpicking picks arrived, love lockpicking", "ok", "lockpicking competitions next month, lockpicking is my thing"];
  let out: any;
  for (const l of lines) {
    clock += 4000;
    const ev = Array.from({ length: l.length }, (_, i) => ({ t: clock - 3000 + i * 40, kind: "insert" as const, len: i + 1 }));
    out = await s.reply(l, ev, clock);
  }
  const fg = s.finalGuesses(3);
  assert.ok(fg.some((g: any) => g.topic === "kp:lockpicking"), JSON.stringify(fg));
  assert.equal(s.map.label("kp:lockpicking"), "lockpicking");
  void out;
});
