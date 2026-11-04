/**
 * keyphrase-idf: leak-free open-vocabulary tagger that weights DISTINCTIVE words.
 *
 * Why: keyphrase-only labels topics by repetition, so a chatty user's filler ("spot", "away",
 * "remember") wins and one-off but telling names ("Justinian", "Constantinople", "Basil II") are dropped.
 *
 * How (no curated hobby list, no topic lexicon; every label is the user's own words):
 *  1. IDF prior: idf(w) = max(0, 6 - zipf(w)) from a general-English frequency table. Default: the bundled
 *     CC0 list computed from Mozilla Common Voice English sentences (wordfreq/cv-en.ts, FREQ_LICENSE.md).
 *     Another table in the same "<zipf*10>:<words>" text format can be passed (option `freqTable`), e.g.
 *     the dev-only wordfreq small_en research list (research/wordfreq/, CC BY-SA, never bundled).
 *     Words not in the table count as rare (zipf 2.5).
 *  2. Candidates per message: proper-noun spans (capitalised mid-sentence tokens and title-case runs,
 *     incl. "Basil II", "Hagia Sophia"), content-word bigrams ("slime molds") and content unigrams.
 *     Stopwords, common verbs, time/discourse fillers and SHOUTED words are removed.
 *  3. Distinctive set D: candidates with score >= minScore, plus medium-frequency words once they
 *     recur in >= 2 messages (so "radio" said twice still counts, "spot" said once does not).
 *  4. Aggregation: messages are threaded into clusters by shared distinctive vocabulary (+ a small
 *     continuity bonus for the cluster touched last turn). Each cluster is ONE interest-map topic with a
 *     stable id; its label is the member with the most accumulated evidence (sum of score^2, proper
 *     nouns favoured), so it sharpens as evidence accrues ("empire" -> "constantinople").
 *  5. The tag's observeWeight scales with the message's distinctiveness, so one telling message
 *     carries more evidence than a filler mention.
 */
import type { TopicTag, TopicTagger } from "./tagger.js";
import { CV_EN_ZIPF10 } from "./wordfreq/cv-en.js";

/** A word -> Zipf frequency table (log10 occurrences per billion words; words below Zipf 3 are absent). */
export interface FreqTable { readonly name: string; get(word: string): number | undefined; readonly size: number }

/** Parse the "<zipf*10>:<space separated lowercase words>" line format used by the bundled list and research lists. */
export function parseZipf10(text: string, name = "custom"): FreqTable {
  const m = new Map<string, number>();
  for (const line of text.split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const z = Number(line.slice(0, i)) / 10;
    if (!Number.isFinite(z)) throw new Error(`freq table ${name}: bad line "${line.slice(0, 40)}"`);
    for (const w of line.slice(i + 1).split(" ")) if (w && !m.has(w)) m.set(w, z);
  }
  if (!m.size) throw new Error(`freq table ${name}: no entries`);
  return { name, get: (w) => m.get(w), size: m.size };
}

let DEFAULT: FreqTable | null = null;
/** The bundled default table (CC0, Mozilla Common Voice English; see wordfreq/FREQ_LICENSE.md). */
export function defaultFreqTable(): FreqTable {
  return (DEFAULT ??= parseZipf10(CV_EN_ZIPF10, "cv-en-cc0"));
}

/** table used by the helpers below; set synchronously at the entry points (idfCandidates, tagger.tag) */
let ACTIVE: FreqTable | null = null;
const active = () => ACTIVE ?? defaultFreqTable();

/** Zipf frequency of a lowercase word, or undefined when below the table (Zipf < 3). Default table unless given. */
export function zipfOf(word: string, table?: FreqTable): number | undefined {
  return (table ?? active()).get(word);
}

export const IDF_CEIL = 6;
export const MISSING_ZIPF = 2.5;
function zipfOrStem(w: string): number {
  const z = zipfOf(w) ?? zipfOf(stem(w));
  if (z !== undefined) return z;
  // hyphenated compounds ("thank-you", "daughter-in-law") are as common as their parts on average
  if (w.includes("-")) { const p = w.split("-").filter(Boolean); return p.reduce((a, x) => a + (zipfOf(x) ?? zipfOf(stem(x)) ?? MISSING_ZIPF), 0) / p.length; }
  return MISSING_ZIPF;
}
export function idf(w: string, table?: FreqTable): number {
  if (!table) return Math.max(0, IDF_CEIL - zipfOrStem(w));
  const prev = ACTIVE; ACTIVE = table;
  try { return Math.max(0, IDF_CEIL - zipfOrStem(w)); } finally { ACTIVE = prev; }
}

/** naive plural folding for grouping only ("molds" ~ "mold", "hives" ~ "hive") */
export function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && /(ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/**
 * Command words (report d2bd6006: "Repeat this phrase I am ai", "Test" became topics kp:repeat / kp:test and the
 * adaptive note planned "EXPLORE repeat"). Words that instruct the chat partner or test the app never name an
 * interest; part of IDF_STOPWORDS, so they are dropped as unigrams and trimmed from bigram edges.
 */
const IDF_COMMAND_WORDS_LIST = `
repeat repeats repeating repeated test tests testing tested explain explains explaining explained describe describes described
summarize summarise summarizes summarises summary translate translates translation define defines definition list lists
write writes rewrite rewrites paraphrase phrase phrases sentence sentences quote type typed typing reply replies respond
responds response prompt prompts command commands instruction instructions focus focusing elaborate clarify
`.split(/\s+/).filter(Boolean);
export const IDF_COMMAND_WORDS: ReadonlySet<string> = new Set(IDF_COMMAND_WORDS_LIST);

/**
 * Generic English function words, common verbs, time words and conversational fillers. Deliberately
 * topic-free: nothing here names a hobby (tests assert it contains no sim persona passion word).
 */
export const IDF_STOPWORDS: ReadonlySet<string> = new Set(`
a about above across after again against all almost alone along already also although always am among an and another any anybody anyone anything anyway anyways anywhere are aren't around as at away
back be became because become becomes been before behind being below beside besides best better between beyond both bit but by
can can't cannot could couldn't did didn't do does doesn't doing don't done down during each either else elsewhere enough especially even ever every everybody everyone everything everywhere except
few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how however i i'd i'll i'm i've if in indeed inside instead into is isn't it it's its itself just
least less let let's like likely lot lots many may maybe me might mine more moreover most mostly much must my myself near nearly neither never nevertheless next no nobody none nor not nothing now nowhere
of off often oh ok okay on once one ones only onto or other others otherwise ought our ours ourselves out outside over own per perhaps please plus quite rather really same several shall she she'd she'll she's should shouldn't since so some somebody someone something sometime sometimes somewhat somewhere soon still such
than that that's the their theirs them themselves then there there's therefore these they they'd they'll they're they've thing things this those though through throughout thus to together too toward towards under unless until up upon us very via was wasn't we we'd we'll we're we've well were weren't what what's whatever when whenever where whereas wherever whether which while who who's whoever whole whom whose why will with within without won't would wouldn't yet you you'd you'll you're you've your yours yourself yourselves
yeah yes yep nope hey hi hello hmm huh haha hahaha lol omg wow ah aw ugh um uh oops gosh goodness golly my dear sure fine cool nice great good awesome amazing wonderful lovely fun funny super pretty totally honestly basically literally actually definitely absolutely truly simply seriously certainly probably possibly obviously clearly kind kinda sort sorta stuff thanks thank sorry
get gets getting got gotten go goes going gone went come comes coming came make makes making made take takes taking took taken give gives giving gave given put puts putting keep keeps keeping kept let lets letting say says saying said tell tells telling told ask asks asking asked
know knows knowing knew known think thinks thinking thought feel feels feeling felt seem seems seemed look looks looking looked see sees seeing saw seen find finds finding found want wants wanting wanted need needs needed try tries trying tried use uses using used
like likes liked love loves loved loving enjoy enjoys enjoyed enjoying hate hates prefer prefers preferred mean means meant guess guessed suppose hope hoped wish wished remember remembers remembered forget forgot imagine imagined believe believed wonder wondered admit admire admired
start starts started starting begin began begun stop stopped finish finished end ended spend spends spending spent work works worked working play plays played playing read reads talk talks talked talking hear heard listen listened
call called turn turned move moved run running happen happened leave left bring brought buy bought pick picked help helped show showed shown change changed live lived stay stayed sit sitting sat stand wait waited walk walked open opened learn learned learnt
become became grow grew keep build built hold held set sets reach reached able unable lose lost win won pay paid send sent meet met consider considered
time times day days week weeks weekend weekends month months year years today tonight tomorrow yesterday morning mornings afternoon afternoons evening evenings night nights hour hours minute minutes moment moments while lately recently ago nowadays usually early late later soon long ever
way ways thing things part parts kind kinds type types lot bunch couple piece bit spot place places area side point fact idea ideas question questions answer reason reasons sense case example stuff matter course
people person guy guys folks everyone someone friend friends family life world home house work job place lots plenty
first second third last next new old big small little huge tiny whole full high low own different same certain other real right left wrong true easy hard simple sure free busy quiet happy glad excited interesting fascinating favorite favourite special perfect entire specific general
dont didnt doesnt cant wont im ive id youre thats theres isnt wasnt
idk tbh imo imho btw fyi ngl lmao rofl smh omw irl nah meh yup ya yah ok k gonna wanna gotta kinda dunno lemme
bored tired busy stressed relaxed relaxing exhausted sleepy annoyed calm chill weird boring awesome cute
`.split(/\s+/).concat([...IDF_COMMAND_WORDS_LIST]).filter(Boolean));

/**
 * Evaluative adjectives, intensifiers and exclamations ("i'd make the wizard mode insane", "alright"): they
 * judge a topic, they never name one. Topic-free like IDF_STOPWORDS (tests assert no persona passion word);
 * dropped as unigram candidates and as bigram parts.
 */
export const IDF_EVALUATIVE: ReadonlySet<string> = new Set(`
insane insanely crazy alright aight decent solid legit epic dope sick wild rad neat sweet gnarly brutal unreal bonkers nuts mental
terrible awful horrible horrid dreadful stupid dumb silly ridiculous absurd lame meh gross nasty sketchy messy crappy cheesy random
incredible fantastic fabulous brilliant excellent outstanding superb gorgeous beautiful pretty hilarious adorable cozy comfy fancy
tough rough intense extreme massive mega giant enormous decent mediocre average typical basic normal regular usual actual honest serious
precise proper decent okay-ish alrighty sure-fire hell heck damn dang darn freaking frickin fricking bloody effing goddamn
extremely incredibly ridiculously seriously truly really utterly highly deeply hugely wildly
fave faves top best worst better worse greatest coolest nicest biggest
`.split(/\s+/).filter(Boolean));

/** words that grade the next word ("so insane", "really cool"): what follows is adjective-like */
const INTENSIFIER = new Set(["so", "very", "really", "pretty", "too", "super", "quite", "extremely", "kinda", "sorta", "totally", "insanely", "incredibly", "absolutely"]);
/** superlative of a common word ("closest", "fastest"): grades, does not name; base >= 4 letters ("forest" stays) */
function isSuperlative(w: string): boolean {
  if (!w.endsWith("est") || w.length < 7) return false;
  const b = w.slice(0, -3);
  const forms = [b, b + "e", b.endsWith("i") ? b.slice(0, -1) + "y" : "", b.length > 4 && b[b.length - 1] === b[b.length - 2] ? b.slice(0, -1) : ""].filter((f) => f.length >= 4);
  return forms.some((f) => (zipfOf(f) ?? 0) >= 4);
}
/** cheap "noun-like" guard (no POS model): not evaluative, not a superlative */
const isEvaluative = (low: string) => IDF_EVALUATIVE.has(low) || isSuperlative(low);
/** score factor for a unigram right after an intensifier ("so wild", "pretty fancy"): adjective-like, halved */
export const AFTER_INTENSIFIER = 0.5;

const PN_BONUS = 1.4;
const isRoman = (t: string) => /^(II|III|IV|V|VI|VII|VIII|IX|X|XI|XII)$/.test(t);
const HONORIFIC = new Set(["mr", "mrs", "ms", "dr", "st", "mt", "sir", "lady", "saint", "queen", "king"]);
const CONNECTOR = new Set(["of", "de", "the", "von", "van", "la", "le", "du", "del", "and"]);

interface Cand { key: string; label: string; score: number; pn: boolean; bigram?: boolean; bothRare?: boolean }

export interface KeyphraseIdfOptions {
  /** score floor for a candidate to be distinctive (default 1.6 ~ zipf <= 4.4) */
  minScore?: number;
  /** medium words (score in [recurScore, minScore)) become distinctive once seen in this many messages (default 2) */
  minRepeats?: number;
  /** words with zipf above this are never candidates (default 5.3) */
  maxZipf?: number;
  /** cluster-link threshold: summed idf of shared vocabulary (default 3 = one rare or two medium words) */
  link?: number;
  /** word-frequency table for the IDF prior (default: bundled CC0 Common Voice list). Build with parseZipf10(). */
  freqTable?: FreqTable;
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?;:])\s+|\n+|\s[-–—]\s|(?<=["“”])\s+/).filter((s) => s.trim());
}

interface Tok { raw: string; low: string; start: boolean; joinNext: boolean }
function toks(sentence: string): Tok[] {
  const out: Tok[] = [];
  const re = /[A-Za-z][A-Za-z']*(?:-[A-Za-z]+)*/g;
  let m: RegExpExecArray | null, prevEnd = -1;
  while ((m = re.exec(sentence))) {
    const raw = m[0].replace(/'s$|'$/i, "");
    if (out.length) out[out.length - 1]!.joinNext = /^\s+$/.test(sentence.slice(prevEnd, m.index));
    out.push({ raw, low: raw.toLowerCase(), start: out.length === 0 || /^[\s"“(]*$/.test(sentence.slice(0, m.index)), joinNext: false });
    prevEnd = m.index + m[0].length;
  }
  return out;
}

/** cheap part-of-speech guard: past tenses and adjective/adverb suffixes describe, they rarely name an interest */
const MODIFIER = /(?<=..)(ed|ous|ful|ive|able|ible|less|ish|ly)$/;
const isContent = (low: string, maxZipf: number) =>
  low.length >= 3 && !(low.length >= 6 && MODIFIER.test(low)) && !IDF_STOPWORDS.has(low) && !isEvaluative(low) && !IDF_STOPWORDS.has(stem(low)) && !(low.length >= 5 && low.endsWith("ly") && zipfOf(low) !== undefined && zipfOf(low)! > 3.5) && zipfOrStem(low) <= maxZipf;

/** "-ing" forms of a common verb ("decaying", "scrolling") are usually activity descriptions; down-weighted, not dropped (hobby gerunds recur) */
function isVerbalIng(w: string): boolean {
  if (!w.endsWith("ing") || w.length < 6) return false;
  const b = w.slice(0, -3);
  const forms = [b, b + "e", b.length > 3 && b[b.length - 1] === b[b.length - 2] ? b.slice(0, -1) : ""].filter(Boolean);
  return forms.some((f) => (zipfOf(f) ?? 0) >= 3.5);
}

/** Candidate terms in one message (exported for tests / diagnostics). */
export function idfCandidates(text: string, maxZipf = 5.3, table?: FreqTable): Cand[] {
  const prev = ACTIVE;
  if (table) ACTIVE = table;
  try { return idfCandidatesActive(text, maxZipf); } finally { ACTIVE = prev; }
}
function idfCandidatesActive(text: string, maxZipf: number): Cand[] {
  const out = new Map<string, Cand>();
  const add = (c: Cand) => {
    const prev = out.get(c.key);
    if (!prev || c.score > prev.score) out.set(c.key, c);
  };
  for (const s of sentences(text)) {
    const T = toks(s);
    const inSpan = new Set<number>();
    // proper-noun spans
    for (let i = 0; i < T.length; i++) {
      const t = T[i]!;
      const cap = /^[A-Z][a-z]/.test(t.raw) || (/^[A-Z]{2,}$/.test(t.raw) && t.raw.length <= 5 && !isRoman(t.raw) && zipfOf(t.low) === undefined);
      if (!cap || t.raw === "I") continue;
      // sentence-initial capitals are only names when the word is rare or followed by another capital
      const nextCap = i + 1 < T.length && /^[A-Z][a-z]/.test(T[i + 1]!.raw) && t.joinNext;
      if (t.start && !(zipfOrStem(t.low) < 3.5 && !IDF_STOPWORDS.has(t.low)) && !nextCap) continue;
      let j = i;
      const parts: string[] = [];
      while (j < T.length) {
        const u = T[j]!;
        const ok = j === i || (/^[A-Z][a-z]/.test(u.raw) || isRoman(u.raw) || (u.raw === "I" && parts.length > 0 && T[j - 1]!.joinNext && j === T.length - 1));
        if (!ok) {
          // connector between capitals: "Corpus of Laws", "Hagia Sophia"
          if (CONNECTOR.has(u.low) && j + 1 < T.length && /^[A-Z][a-z]/.test(T[j + 1]!.raw) && T[j - 1]!.joinNext && u.joinNext) { parts.push(u.low); j++; continue; }
          break;
        }
        parts.push(u.raw === "I" ? "" : u.low);
        if (!u.joinNext) { j++; break; }
        j++;
      }
      let words = parts.filter(Boolean);
      while (words.length && (HONORIFIC.has(words[0]!) || IDF_STOPWORDS.has(words[0]!) || CONNECTOR.has(words[0]!))) words = words.slice(1);
      while (words.length && (CONNECTOR.has(words[words.length - 1]!) || IDF_STOPWORDS.has(words[words.length - 1]!))) words = words.slice(0, -1);
      for (let k = i; k < j; k++) inSpan.add(k);
      i = j - 1;
      const contentWords = words.filter((w) => !CONNECTOR.has(w) && !/^(ii|iii|iv|vi|vii|viii|ix|xi|xii)$/.test(w));
      if (!contentWords.length || contentWords.every((w) => IDF_STOPWORDS.has(w))) continue;
      const best = Math.max(...contentWords.map((w) => idf(w)));
      if (best < 1) continue; // "Monday", "English": very common capitalised words are not interests
      const score = best * PN_BONUS + 0.2 * Math.min(2, words.length - 1);
      add({ key: words.join(" "), label: words.join(" "), score, pn: true });
    }
    // content unigrams and bigrams
    for (let i = 0; i < T.length; i++) {
      if (inSpan.has(i)) continue;
      const t = T[i]!;
      if (/^[A-Z]{2,}$/.test(t.raw) && zipfOf(t.low) !== undefined) {
        // SHOUTED common word ("GAME CHANGER", "LOVE"): style, not topic
        if (zipfOf(t.low)! > 4) continue;
      }
      if (!isContent(t.low, maxZipf)) continue;
      const graded = i > 0 && T[i - 1]!.joinNext && INTENSIFIER.has(T[i - 1]!.low);
      add({ key: stem(t.low), label: t.low, score: idf(t.low) * (isVerbalIng(t.low) ? 0.6 : 1) * (graded ? AFTER_INTENSIFIER : 1), pn: false });
      const u = T[i + 1];
      if (u && t.joinNext && !inSpan.has(i + 1) && isContent(u.low, maxZipf) && !/^[A-Z]{2,}$/.test(u.raw)) {
        const a = idf(t.low), b = idf(u.low);
        // bigrams are mostly "rare adjective + noun" noise unless both words are rare; others must recur (see distinctive())
        if (Math.min(a, b) >= 0.8) add({ key: `${t.low} ${stem(u.low)}`, label: `${t.low} ${u.low}`, score: Math.max(a, b) + 0.35 * Math.min(a, b), pn: false, bigram: true, bothRare: Math.min(a, b) >= 2.5 });
      }
    }
  }
  return [...out.values()];
}

/** a single-word key shares a >= 4-letter stem prefix/suffix with a cluster member */
function subwordLink(key: string, core: Map<string, unknown>): boolean {
  if (key.includes(" ")) return false;
  for (const c of core.keys()) {
    if (c.includes(" ")) continue;
    const [a, b] = key.length <= c.length ? [key, c] : [c, key];
    if (a.length >= 4 && a !== b && (b.startsWith(a) || b.endsWith(a))) return true;
  }
  return false;
}

interface Cluster { id: string; core: Map<string, { ev: number; label: string; pn: boolean }>; ctx: Map<string, number>; last: number }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

export class KeyphraseIdfTagger implements TopicTagger {
  readonly kind = "keyphrase-idf";
  private o: Required<Omit<KeyphraseIdfOptions, "freqTable">>;
  readonly freqTable: FreqTable;
  private msgCount = new Map<string, number>();
  private clusters: Cluster[] = [];
  private turn = 0;
  private masses: number[] = [];
  constructor(opts: KeyphraseIdfOptions = {}) {
    this.o = { minScore: opts.minScore ?? 1.6, minRepeats: opts.minRepeats ?? 2, maxZipf: opts.maxZipf ?? 5.3, link: opts.link ?? 3 };
    this.freqTable = opts.freqTable ?? defaultFreqTable();
  }

  /** Distinctive candidates of a message given the session so far (also updates the repeat counts). */
  private distinctive(text: string): { D: Cand[]; V: Map<string, number> } {
    const cands = idfCandidates(text, this.o.maxZipf, this.freqTable);
    for (const c of cands) this.msgCount.set(c.key, (this.msgCount.get(c.key) ?? 0) + 1);
    const D = cands
      .filter((c) => {
        const rep = (this.msgCount.get(c.key) ?? 0) >= this.o.minRepeats;
        if (c.bigram && !c.bothRare) return rep;
        return c.score >= this.o.minScore || (c.score >= 0.8 && rep);
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    // linking vocabulary: every candidate word (incl. span/bigram parts) with some distinctiveness
    const V = new Map<string, number>();
    for (const c of cands) for (const w of c.key.split(" ")) { const s = stem(w); const v = idf(w); if (v >= 1.5 && !IDF_STOPWORDS.has(w)) V.set(s, Math.max(V.get(s) ?? 0, v)); }
    return { D, V };
  }

  async tag(text: string): Promise<TopicTag[]> {
    // fully synchronous body: the active table cannot leak into another tagger's call
    const prev = ACTIVE; ACTIVE = this.freqTable;
    try { return this.tagSync(text); } finally { ACTIVE = prev; }
  }

  private tagSync(text: string): TopicTag[] {
    this.turn++;
    const { D, V } = this.distinctive(text);
    if (!D.length) return [];
    let best: Cluster | undefined, bestScore = 0;
    for (const c of this.clusters) {
      let s = 0;
      for (const [w, v] of V) if (c.ctx.has(w)) s += v;
      for (const d of D) {
        if (c.core.has(d.key)) { s += 0.5 * d.score; continue; }
        // morphological roll-up without a list: "bees" ~ "honeybees", "hive" ~ "hives", "sketch" ~ "sketchbook"
        if (subwordLink(d.key, c.core)) s += 0.5 * d.score;
      }
      if (s > 0 && c.last === this.turn - 1) s += 0.5;
      if (s > bestScore) { bestScore = s; best = c; }
    }
    if (!best || bestScore < this.o.link) {
      best = { id: `kp:${slug(D[0]!.label)}`, core: new Map(), ctx: new Map(), last: this.turn };
      let n = 2;
      while (this.clusters.some((c) => c.id === best!.id)) best.id = `kp:${slug(D[0]!.label)}-${n++}`;
      this.clusters.push(best);
    }
    best.last = this.turn;
    for (const [w, v] of V) best.ctx.set(w, (best.ctx.get(w) ?? 0) + v);
    for (const d of D) {
      const cur = best.core.get(d.key) ?? { ev: 0, label: d.label, pn: d.pn };
      cur.ev += d.score * d.score;
      cur.pn ||= d.pn;
      best.core.set(d.key, cur);
    }
    const label = this.clusterLabel(best);
    // evidence weight: how distinctive this message is relative to THIS user's usual message (chatty users
    // are always "colourful"; a terse user's single rare name is a big deal), times the cluster's revisits
    const mass = D.reduce((a, d) => a + d.score, 0);
    const prior = this.masses.length ? [...this.masses].sort((x, y) => x - y)[Math.floor(this.masses.length / 2)]! : 4;
    this.masses.push(mass);
    const rel = Math.max(0.5, Math.min(2.5, mass / Math.max(2, prior)));
    const observeWeight = Math.round(0.7 * rel * 1000) / 1000;
    return [{ id: best.id, label, weight: Math.round(mass * 100) / 100, observeWeight }];
  }

  private clusterLabel(c: Cluster): string {
    let best = "", top = -1;
    for (const [, m] of c.core) {
      // a phrase that contains another member also inherits its evidence ("slime molds" > "molds")
      const score = m.ev;
      if (score > top) { top = score; best = m.label; }
    }
    return best;
  }

  /** debug view: clusters with their top members */
  snapshot(): Array<{ id: string; label: string; members: Array<[string, number]> }> {
    return this.clusters.map((c) => ({ id: c.id, label: this.clusterLabel(c), members: [...c.core.entries()].sort((a, b) => b[1].ev - a[1].ev).slice(0, 6).map(([, m]) => [m.label, Math.round(m.ev * 10) / 10] as [string, number]) }));
  }
}
