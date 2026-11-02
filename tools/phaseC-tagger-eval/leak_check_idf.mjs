// Leak check for the leak-free taggers (keyphrase-idf, llm-extract prompt) against the sim personas.
// Reads the persona files read-only; imports the compiled core. Exit 1 on FAIL.
//   node tools/phaseC-tagger-eval/leak_check_idf.mjs [personas_c.json personas.json]
import fs from "node:fs";
import path from "node:path";
const HE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const SIM = process.env.SIM_ROOT ?? "/workspace/eeg-harness-sim";
const core = await import(`${HE}/packages/core/dist/index.js`);
const { IDF_STOPWORDS, idfCandidates, createTagger, EXTRACTOR_SYSTEM_PROMPT, buildExtractorPrompt, SPECIFIC_TOPICS, zipfOf } = core;
const files = process.argv.slice(2).length ? process.argv.slice(2) : ["personas_c.json", "personas.json"];
let fail = 0;
const out = [];
const curated = Object.values(SPECIFIC_TOPICS).map((t) => t.label.toLowerCase());
for (const f of files) {
  const P = JSON.parse(fs.readFileSync(path.isAbsolute(f) ? f : path.join(SIM, f), "utf8")).personas;
  out.push(`== ${f}`);
  for (const p of P) {
    const kws = [...p.passion_keywords, ...(p.synonyms ?? [])].map((s) => s.toLowerCase());
    const words = [...new Set(kws.flatMap((k) => k.split(/\s+/)))];
    const rx = p.rescore ? ["exact", "close"].map((k) => new RegExp(p.rescore[k], "i")) : [];
    // 1. stopword list must not contain any passion word (would systematically hide the passion)
    const stop = kws.filter((w) => !w.includes(" ") && IDF_STOPWORDS.has(w));
    const stopParts = words.filter((w) => IDF_STOPWORDS.has(w) && !stop.includes(w));
    // 2. extractor system prompt must not name the passion (no examples in the prompt)
    const promptHits = [...kws.filter((k) => new RegExp(`(^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(EXTRACTOR_SYSTEM_PROMPT.toLowerCase())), ...rx.filter((r) => r.test(EXTRACTOR_SYSTEM_PROMPT)).map((r) => `/${r.source}/`)];
    // 3. a conversation that never mentions the passion yields no label matching its exact/close rules,
    //    and every label word is the user's own (feed the OTHER personas' keyword sentences)
    const others = P.filter((q) => q.id !== p.id).map((q) => `Lately I keep thinking about ${q.passion_keywords.slice(0, 4).join(", ")} and stuff like that.`);
    const tg = createTagger({ kind: "keyphrase-idf" });
    let said = "";
    const bad = [];
    for (const m of others) {
      said += " " + m.toLowerCase();
      for (const t of await tg.tag(m)) {
        if (t.id.startsWith("x:")) bad.push(`curated id ${t.id}`);
        for (const w of t.label.split(" ")) if (!said.includes(w)) bad.push(`label word "${w}" not in text`);
        if (curated.includes(t.label) && !said.includes(t.label)) bad.push(`curated label ${t.label}`);
        if (rx.some((r) => r.test(t.label)) && !rx.some((r) => r.test(said))) bad.push(`passion label "${t.label}" without the user saying it`);
      }
    }
    // 4. info: which passion words the tagger can actually pick up (candidate in a neutral sentence) + zipf
    const seen = words.map((w) => {
      const c = idfCandidates(`I really got into ${w} this year.`).find((c) => c.key.split(" ").includes(w) || c.label.includes(w));
      return `${w}${c ? "" : "(not a candidate)"}@${zipfOf(w) ?? "<3"}`;
    });
    const ok = !stop.length && !promptHits.length && !bad.length;
    if (!ok) fail++;
    out.push(`${ok ? "PASS" : "FAIL"} ${p.id.padEnd(11)} single-word passion keywords in the stopword list: ${stop.join(",") || "none"} (generic parts of multi-word keyphrases, info: ${stopParts.join(",") || "none"}); prompt hits: ${promptHits.join(",") || "none"}; neutral-convo leaks: ${bad.join(", ") || "none"}`);
    out.push(`     candidates (info): ${seen.join(" ")}`);
  }
}
out.push(fail ? `${fail} persona(s) FAIL` : "all personas PASS (no single-word passion keyword in the stopword list or the extractor prompt; no label the user did not write)");
console.log(out.join("\n"));
process.exit(fail ? 1 : 0);
