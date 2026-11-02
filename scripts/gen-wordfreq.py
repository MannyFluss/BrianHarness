#!/usr/bin/env python3
"""Regenerate packages/core/src/wordfreq/wordfreq-en.ts from wordfreq's small_en list (data: CC BY-SA 4.0).
  python3 -m venv /tmp/wfv && /tmp/wfv/bin/pip install msgpack && pip download wordfreq==3.1.1 --no-deps -d /tmp/wf
  (cd /tmp/wf && unzip -o wordfreq-3.1.1-py3-none-any.whl) && /tmp/wfv/bin/python scripts/gen-wordfreq.py /tmp/wf
"""
import collections, gzip, re, sys
import msgpack

root = sys.argv[1] if len(sys.argv) > 1 else "/tmp/wf"
d = msgpack.unpackb(gzip.open(root + "/wordfreq/data/small_en.msgpack.gz").read(), raw=False)
b, seen = collections.defaultdict(list), set()
for i, bucket in enumerate(d[1:]):          # bucket i = frequency 10^(-i/100) -> Zipf 9 - i/100
    z = round(9 - i / 100, 1)
    for w in bucket:
        if re.fullmatch(r"[a-z][a-z']*", w) and w not in seen:
            seen.add(w); b[z].append(w)
body = "\n".join("%d:%s" % (round(z * 10), " ".join(sorted(b[z]))) for z in sorted(b, reverse=True))
hdr = open("packages/core/src/wordfreq/wordfreq-en.ts").read().split("export const")[0]
hdr = re.sub(r"\(\d+ words", "(%d words" % len(seen), hdr)
open("packages/core/src/wordfreq/wordfreq-en.ts", "w").write(hdr + "export const WORDFREQ_EN_ZIPF10 = `" + body + "`;\n")
print(len(seen), "words")
