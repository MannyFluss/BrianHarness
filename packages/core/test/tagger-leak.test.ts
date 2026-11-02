// Leak-free tagging for experiments: the curated SPECIFIC_TOPICS list contains the 8 Phase A sim
// persona passions verbatim, so the default ("full") lexicon can name a passion the user never said.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HarnessSession, MockBackend, SIM_PERSONA_SPECIFICS, SPECIFIC_TOPICS, createTagger, lexiconTags } from "../src/index.ts";

const curatedLabels = Object.values(SPECIFIC_TOPICS).map((t) => t.label.toLowerCase());

// persona-style replies that use the passions' vocabulary but never the curated label text
const CONVOS: string[][] = [
  ["Mostly I sit at the transceiver at night chasing dx on the hf band", "Last weekend was a contest, my contest log had 300 contacts", "Morse is still the best mode for weak signals", "The antenna on my roof is a dipole for shortwave"],
  ["I service an old wristwatch movement most evenings", "The mainspring on that one was shot, so I sourced a new mainspring", "A balance wheel is fiddly to true", "Opening a caseback still makes me nervous"],
  ["Out at dawn with binoculars again, a lifer warbler this morning", "My ebird list is at 412 for the year, life list keeps growing", "The warbler migration is peaking right now", "Twitching a rarity two counties over this weekend"],
  ["Found physarum on a rotting log, bright yellow plasmodium", "I feed the plasmodium oat flakes in a petri dish", "Myxomycetes are not fungi, people always assume", "Photographing fruiting bodies with a macro lens"],
  ["Hypertapping is dying out, everyone rolls now", "Rolling got me past level 29 for the first time", "The killscreen used to be a myth", "Watching the CTWC finals tonight"],
  ["Spent the afternoon with my sketchbook drawing facades", "Ink and wash on location, then watercolor at home", "A fountain pen line looks great under watercolor", "Sketchers meet downtown every Saturday"],
  ["Reading about Justinian and the Nika riots", "Basil II is the most interesting emperor to me", "Constantinople's walls held for almost a thousand years", "The Komnenos dynasty is underrated"],
  ["Did a hive inspection, both hives look healthy", "Treating for varroa before winter", "Harvested honey from the second hive frames", "Caught a swarm in the neighbor's tree"],
];

test("keyphrase-only never emits a curated hobby label unless the user wrote it", async () => {
  for (const convo of CONVOS) {
    const tagger = createTagger({ kind: "keyphrase-only" });
    let said = "";
    for (const msg of convo) {
      said += " " + msg.toLowerCase();
      for (const t of await tagger.tag(msg)) {
        assert.ok(!t.id.startsWith("x:"), `curated id ${t.id}`);
        assert.ok(/^kp:/.test(t.id), `non-keyphrase id ${t.id}`);
        if (curatedLabels.includes(t.label.toLowerCase())) assert.ok(said.includes(t.label.toLowerCase()), `leaked label "${t.label}"`);
        // every label is literally from the user's words
        for (const w of t.label.split(" ")) assert.ok(said.includes(w), `label word "${w}" not in user text`);
      }
    }
  }
});

test("the default (full) lexicon does name passions the user never wrote (the documented leak)", () => {
  const leaked = CONVOS.flat().flatMap((m) => lexiconTags(m)).filter((t) => SIM_PERSONA_SPECIFICS.includes(t.id));
  assert.ok(new Set(leaked.map((t) => t.id)).size >= 6, "expected the full lexicon to hit most persona passions");
  // defaults unchanged
  assert.equal(createTagger().kind, "lexicon");
  assert.equal(createTagger({ kind: "keyphrase" }).kind, "keyphrase");
});

test("generic lexicon drops exactly the sim-persona specifics; broad keeps categories only", () => {
  const all = CONVOS.flat();
  for (const m of all) for (const t of lexiconTags(m, "generic")) assert.ok(!SIM_PERSONA_SPECIFICS.includes(t.id), t.id);
  assert.ok(lexiconTags("my sourdough starter and levain", "generic").some((t) => t.id === "x:sourdough"), "non-persona specifics kept");
  assert.ok(lexiconTags("i watched the rocket launch through my telescope", "broad").every((t) => !t.id.includes(":")));
  assert.deepEqual(lexiconTags("ham radio morse code", "none"), []);
});

test("keyphrase-only rolls phrases up to a phrase cluster so the hypothesis consolidates", async () => {
  const s = new HarnessSession({ userId: "kp-only", backend: new MockBackend(1), store: null, tagger: { kind: "keyphrase-only" }, seed: 1 });
  await s.start();
  const msgs = ["I got into ham radio last year", "ham radio contests are my weekends now", "the radio club meets on tuesdays, radio people are great", "my ham radio license upgrade came through", "radio propagation was amazing today"];
  for (const m of msgs) await s.reply(m);
  const hud = s.hud();
  // all radio evidence lands on one root cell (kp:radio) instead of fragmenting across phrases
  assert.equal(hud.topTopics[0]?.[0], "kp:radio", JSON.stringify(hud.topTopics));
  assert.ok(!hud.topTopics.some(([t]) => t === "kp:ham-radio"), "child rolled into its cluster");
  for (const [t] of hud.topTopics) assert.ok(!t.startsWith("x:"), t);
  const tagger = createTagger({ kind: "keyphrase-only" });
  let last: { id: string; parent?: string }[] = [];
  for (const m of msgs.slice(0, 4)) last = await tagger.tag(m);
  assert.equal(last.find((t) => t.id === "kp:ham-radio")?.parent, "kp:radio");
});
