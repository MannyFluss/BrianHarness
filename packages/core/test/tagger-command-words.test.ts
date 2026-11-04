// Report d2bd6006: "Repeat this phrase I am ai" / "Test" became topics (kp:repeat, kp:test) and the adaptive note
// planned "EXPLORE repeat". Command words never name an interest, in the keyphrase-idf, keyphrase and lexicon taggers and
// extractor labels. Moot for plain chat (no tagger), applies to both study arms (the tagger runs in both).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTagger, IDF_COMMAND_WORDS, IDF_STOPWORDS, parseExtractorResponse } from "../src/browser.ts";

const D2 = ["Test", "Repeat this phrase I am ai", "Test", "explain how a sourdough starter works", "what should I focus on?", "testing testing"];
test("command words are stopwords and never become topics (keyphrase-idf, keyphrase-only, lexicon)", async () => {
  for (const w of ["repeat", "test", "testing", "explain", "phrase", "focus"]) { assert.ok(IDF_COMMAND_WORDS.has(w), w); assert.ok(IDF_STOPWORDS.has(w), w); }
  for (const spec of ["keyphrase-idf", "keyphrase-only", "lexicon"] as const) {
    const t = createTagger({ kind: spec });
    const ids: string[] = [];
    for (const x of D2) ids.push(...(await t.tag(x)).map((tag) => tag.id));
    for (const bad of ["repeat", "test", "testing", "explain", "phrase", "focus"]) assert.ok(!ids.some((id) => id.split(/[:_ -]/).includes(bad)), `${spec}: ${bad} in ${ids.join(",")}`);
    if (spec === "keyphrase-idf") assert.ok(ids.some((id) => /sourdough/.test(id)), `real topic kept: ${ids.join(",")}`);
  }
});
test("extractor labels made only of command words are dropped", () => {
  const out = parseExtractorResponse(JSON.stringify({ message: { content: '{"interests":[{"label":"repeat","confidence":0.9,"turns":[1]},{"label":"test","confidence":0.8,"turns":[2]},{"label":"sourdough baking","confidence":0.7,"turns":[3]}]}' } }));
  assert.deepEqual(out.map((x) => x.label), ["sourdough baking"]);
});
