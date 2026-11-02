#!/usr/bin/env python3
"""Regenerate research/wordfreq/wordfreq_small_en_zipf10.txt (DEV-ONLY research input, never bundled) from
wordfreq's small_en list (data: CC BY-SA 4.0). The shipped default is scripts/gen-freq-cv.py (CC0).
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
open("research/wordfreq/wordfreq_small_en_zipf10.txt", "w").write(body + "\n")
print(len(seen), "words")
