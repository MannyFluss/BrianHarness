/**
 * Short session titles for the top bar / sidebar (instead of a cut-off first message).
 * Once the Director has a confident read on the user's topic, the title follows it.
 */
const FILLER = new Set(
  ("hi hey hello hiya howdy yo sup greetings ok okay so well um uh hmm honestly basically like yeah yes no nah lol haha " +
    "i i'm im just really there all everyone everybody guys folks friend friends again ya y'all thanks thank you please " +
    "good morning afternoon evening day nice to meet how are doing what's whats up hru lately recently anyway oh oops")
    .split(" "),
);
const STOP_TAIL = new Set("a an the and or but of to in on at for with my your is are was am be".split(" "));
/** "I like X" / "I've been into X" / "lately it's mostly X" -> "X" (lower-cased, word-split). */
const LEAD_INS: string[][] = [
  "i really like", "i really love", "i like", "i love", "i enjoy", "i'm into", "im into", "i'm really into", "i am into",
  "i've been into", "ive been into", "i've been", "ive been", "i have been", "i'm", "im", "i am",
  "my favorite thing is", "my favourite thing is", "my hobby is", "my thing is", "i'd say", "probably", "definitely",
  "it's mostly", "its mostly", "it's", "its", "mostly", "mainly", "i", "into",
].map((l) => l.split(" "));
const lc = (w: string) => w.toLowerCase().replace(/’/g, "'");

function stripLeadIns(words: string[]): string[] {
  for (let changed = true; changed && words.length > 1; ) {
    changed = false;
    for (const l of LEAD_INS) {
      if (words.length > l.length && l.every((w, i) => lc(words[i]!) === w)) { words = words.slice(l.length); changed = true; break; }
    }
    if (!changed && FILLER.has(lc(words[0]!))) { words = words.slice(1); changed = true; }
  }
  return words;
}

/**
 * Title from a user message: skips greeting/filler clauses ("Hi there, ..."), strips lead-ins
 * ("I like ...", "lately it's mostly ...") so the title is a short noun phrase, and falls back
 * to "New chat" when nothing is left (a bare "hi there").
 */
export function shortTitle(text: string, maxWords = 5, maxChars = 34): string {
  // (no regex lookbehind: older iOS WebKit lacks it)
  const clauses = text.replace(/\s+/g, " ").trim().replace(/([.!?;:])\s/g, "$1\u0000").split(/\u0000|\s[-–—]\s|,\s/);
  const wordsOf = (c: string) => c.replace(/[^\p{L}\p{N}'’&+#\- ]/gu, " ").split(/\s+/).filter(Boolean);
  const clause = clauses.find((c) => wordsOf(c).some((w) => !FILLER.has(lc(w))));
  if (!clause) return "New chat";
  let words = stripLeadIns(wordsOf(clause));
  if (words.every((w) => FILLER.has(lc(w)))) return "New chat";
  words = words.slice(0, maxWords);
  while (words.length > 1 && STOP_TAIL.has(lc(words[words.length - 1]!))) words.pop();
  let out = words.join(" ");
  if (out.length > maxChars) out = out.slice(0, maxChars).replace(/\s+\S*$/, "");
  if (!out) return "New chat";
  return out[0]!.toUpperCase() + out.slice(1);
}

/** True when a message has nothing title-worthy (a greeting or filler only). */
export function isFillerOnly(text: string | null | undefined): boolean {
  return !text || shortTitle(text) === "New chat";
}

export function sessionTitle(opts: { firstUserText?: string | null; topicLabel?: string | null; turns?: number }): string {
  const label = opts.topicLabel?.trim();
  if (label && (opts.turns ?? 0) >= 2) {
    const t = label[0]!.toUpperCase() + label.slice(1);
    return t.length <= 34 ? t : shortTitle(t);
  }
  return opts.firstUserText ? shortTitle(opts.firstUserText) : "New chat";
}
