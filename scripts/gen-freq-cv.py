#!/usr/bin/env python3
"""Regenerate packages/core/src/wordfreq/cv-en.ts: the DEFAULT keyphrase-idf frequency list, computed here from the
Mozilla Common Voice English sentence corpus (server/data/en/*.txt), released under CC0 1.0 (public domain dedication).
  python3 scripts/gen-freq-cv.py [download_dir]     # downloads the pinned commit if the files are missing
Counts lowercase word tokens ([a-z]+ with inner apostrophes) over all sentences; Zipf = log10(count / total * 1e9);
keeps Zipf >= 3.0, rounded to 0.1. Stdlib only.
"""
import collections, math, os, re, sys, urllib.request

COMMIT = "b24381ce7136f2524a1128cb605b49111f79dbea"  # common-voice/common-voice main, 2026-11-02
FILES = ["DNGros", "DictionaryofForeignPhrases", "RLarissa", "activate", "ajaydee", "bavencope", "elleo", "est31",
         "fxvoice-cues", "harvsents", "james_fortune", "jf99", "kieran_drew", "mlennox", "pro.gadget", "reinhart1010",
         "sentence-collector", "singleword-benchmark", "thehowl", "tlcoles", "tww.id.au.proverbs",
         "wiki.en.rerun-2021-11", "wiki.en"]
BASE = "https://raw.githubusercontent.com/common-voice/common-voice/%s/server/data/en/" % COMMIT
d = sys.argv[1] if len(sys.argv) > 1 else "/tmp/cv"
os.makedirs(d, exist_ok=True)
for f in FILES + ["LICENSE"]:
    p = os.path.join(d, f if f == "LICENSE" else f + ".txt")
    if not os.path.exists(p):
        urllib.request.urlretrieve(BASE + (f if f == "LICENSE" else f + ".txt"), p)
assert open(os.path.join(d, "LICENSE")).read().startswith("CC0 1.0 Universal"), "license file changed"
tok = re.compile(r"[a-z]+(?:'[a-z]+)*")
c, sentences = collections.Counter(), 0
for f in FILES:
    for line in open(os.path.join(d, f + ".txt"), encoding="utf-8"):
        sentences += 1
        c.update(tok.findall(line.replace("\u2019", "'").lower()))
total = sum(c.values())
b = collections.defaultdict(list)
for w, n in c.items():
    z = round(math.log10(n / total * 1e9), 1)
    if z >= 3.0:
        b[z].append(w)
nw = sum(len(v) for v in b.values())
body = "\n".join("%d:%s" % (round(z * 10), " ".join(sorted(b[z]))) for z in sorted(b, reverse=True))
hdr = """/**
 * DEFAULT general-English word frequencies for the keyphrase-idf tagger (Zipf scale: log10 of occurrences per
 * billion words). GENERATED, do not edit: scripts/gen-freq-cv.py.
 *
 * Source: Mozilla Common Voice English sentence corpus, https://github.com/common-voice/common-voice
 * (server/data/en/*.txt at commit %s; %d sentences, %d tokens), counted by
 * scripts/gen-freq-cv.py. %d lowercase words with Zipf >= 3.0, rounded to 0.1.
 * License of the source sentences: CC0 1.0 Universal (public domain dedication), per server/data/en/LICENSE and
 * the repository README ("released under a CC0 public domain Creative Commons license"). This derived table is
 * likewise dedicated to the public domain. See NOTICE.md (repo root) and ./FREQ_LICENSE.md.
 */
""" % (COMMIT, sentences, total, nw)
open("packages/core/src/wordfreq/cv-en.ts", "w").write(hdr + "export const CV_EN_ZIPF10 = `" + body + "`;\n")
print(sentences, "sentences", total, "tokens", nw, "words")
