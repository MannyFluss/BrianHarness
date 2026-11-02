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
