#!/usr/bin/env python3
"""Parity of HE core rankLeadEeg (packages/core/src/final-guesses.ts) vs the Researcher's references, NO LLM calls:
 - blend mode (w > 0) vs eval_leadeeg.rank_proto (PREREG_leadeeg §5 prototype), over the §6 grid
 - pure mode (w = 0)  vs the Researcher's port of eegReorder (copied below from phaseC/leadeeg/preview_he_wip_port.py)
Inputs (read-only): Track 2 answers via eval_leadeeg.load_sessions() (gate sessions are NOT used, to keep the held-out set
unexposed), synthetic EEG rows from phaseC/leadeeg/synth_cache.jsonl (every d, every rep), truncated per answer turn as the
harness does. Imports the sim modules read-only with bytecode off; writes nothing into the sim dir.

  python3 tools/phaseC-tagger-eval/lead_eeg_parity.py   -> docs/sweeps/phaseC_lead_eeg_parity.txt
"""
import json, math, os, statistics, subprocess, sys, tempfile, random
sys.dont_write_bytecode = True
SIMR = os.environ.get("SIM_ROOT", "/workspace/eeg-harness-sim")
LE = os.path.join(SIMR, "phaseC/leadeeg"); sys.path.insert(0, LE)
import eval_leadeeg as E  # noqa: E402  (read-only; main() not run)
HE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def he_port(labels, eeg, opts):  # verbatim logic of preview_he_wip_port.he_port
    z = opts.get("z", 1.645); ranked = [l[0] for l in labels]; cites = [l[2] for l in labels]
    ln = [math.log(max(1e-6, x)) for x in eeg]
    if len(ln) < 4: return ranked
    mu = statistics.mean(ln); sd = statistics.stdev(ln)
    if not sd > 1e-9: return ranked
    st = []
    for c in cites:
        zz = [(ln[t - 1] - mu) / sd for t in sorted(set(c)) if 1 <= t <= len(ln)]
        st.append((statistics.mean(zz), len(zz)) if zz else None)
    idx = list(range(len(ranked)))
    for i in range(1, len(idx)):
        for j in range(i, 0, -1):
            a, b = st[idx[j - 1]], st[idx[j]]
            if not a or not b or b[0] - a[0] <= z * math.sqrt(1 / a[1] + 1 / b[1]): break
            idx[j - 1], idx[j] = idx[j], idx[j - 1]
    return [ranked[i] for i in idx]


S = [s for s in E.load_sessions() if s["set"] == "track2"]
rows = {}
for l in open(os.path.join(LE, "synth_cache.jsonl")):
    x = json.loads(l); rows.setdefault(x["sid"], []).append(x["rows"])
BLEND = [dict(w=0.25, tie_break=tb, margin=m) for tb in ("extractor", "eeg") for m in (0, 0.05, 0.1, 0.2, 0.4)] + \
        [dict(w=w, tie_break="extractor", margin=0.0) for w in (0.05, 0.1, 0.5)]
PURE = [dict(margin=z) for z in (1.645, 1.0, 0.5, 0.0)] + [dict()]  # {} = defaults (pure, z 1.645)
jobs, want = [], []
rnd = random.Random(20261102)
for s in S:
    for eeg in rows.get(s["sid"], []):
        for t, ans in s["answers"]:
            if not ans: continue
            e = eeg[:min(t, s["seen"])]
            L = [dict(label=a[0], confidence=a[1], turns=a[2]) for a in ans]
            for c in BLEND:
                jobs.append(dict(labels=L, eeg=e, opts=c)); want.append(("blend", json.dumps(c), E.rank_proto(ans, e, c)))
            for c in PURE:
                jobs.append(dict(labels=L, eeg=e, opts=c)); want.append(("pure", json.dumps(c), he_port(ans, e, dict(z=c.get("margin", 1.645)))))
tf = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False); json.dump(jobs, tf); tf.close()
js = ("import fs from 'node:fs'; import { rankLeadEeg } from '%s/packages/core/src/final-guesses.ts';"
      "const J = JSON.parse(fs.readFileSync(%s, 'utf8')); process.stdout.write(JSON.stringify(J.map((j) => rankLeadEeg(j.labels, j.eeg, j.opts))));") % (HE, json.dumps(tf.name))
p = subprocess.run(["npx", "tsx", "--input-type=module", "-e", js], cwd=HE, capture_output=True, text=True)
if p.returncode: sys.exit(p.stderr[:2000])
got = json.loads(p.stdout); os.unlink(tf.name)
from collections import Counter
n, bad, ex = Counter(), Counter(), {}
for (mode, cfg, w), g in zip(want, got):
    n[(mode, cfg)] += 1
    if w != g: bad[(mode, cfg)] += 1; ex.setdefault((mode, cfg), (w, g))
print("rankLeadEeg parity on Track 2 answers (turn 6 + 12) x synth_cache rows (%d sessions, %d EEG row sets): %d rankings" % (
    len(S), sum(len(rows.get(s["sid"], [])) for s in S), len(got)))
print("| mode | opts | rankings | mismatches |\n|---|---|---|---|")
for k in n: print("| %s | `%s` | %d | %d |" % (k[0], k[1], n[k], bad[k]))
for k, (w, g) in ex.items(): print("example mismatch %s %s: ref %s HE %s" % (k[0], k[1], w, g))
print("TOTAL mismatches: %d / %d" % (sum(bad.values()), len(got)))
