/**
 * Short session titles for the top bar / sidebar (instead of a cut-off first message).
 * Once the Director has a confident read on the user's topic, the title follows it.
 */
const FILLER = new Set("hi hey hello yo ok okay so well um uh hmm honestly basically like yeah yes no lol i i'm im just really".split(" "));
const STOP_TAIL = new Set("a an the and or but of to in on at for with my your is are was am be".split(" "));

export function shortTitle(text: string, maxWords = 5, maxChars = 34): string {
  const clauses = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?;:])\s|\s[-–—]\s|,\s/);
  const wordsOf = (c: string) => c.replace(/[^\p{L}\p{N}'’&+#\- ]/gu, " ").split(/\s+/).filter(Boolean);
  let words = wordsOf(clauses.find((c) => wordsOf(c).some((w) => !FILLER.has(w.toLowerCase()))) ?? clauses[0] ?? "");
  while (words.length > 1 && FILLER.has(words[0]!.toLowerCase())) words.shift();
  words = words.slice(0, maxWords);
  while (words.length > 1 && STOP_TAIL.has(words[words.length - 1]!.toLowerCase())) words.pop();
  let out = words.join(" ");
  if (out.length > maxChars) out = out.slice(0, maxChars).replace(/\s+\S*$/, "");
  if (!out) return "New chat";
  return out[0]!.toUpperCase() + out.slice(1);
}

export function sessionTitle(opts: { firstUserText?: string | null; topicLabel?: string | null; turns?: number }): string {
  const label = opts.topicLabel?.trim();
  if (label && (opts.turns ?? 0) >= 2) {
    const t = label[0]!.toUpperCase() + label.slice(1);
    return t.length <= 34 ? t : shortTitle(t);
  }
  return opts.firstUserText ? shortTitle(opts.firstUserText) : "New chat";
}
