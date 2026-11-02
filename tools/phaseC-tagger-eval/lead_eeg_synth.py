#!/usr/bin/env python3
"""rank "lead-eeg" (HE core eegReorder, LEAD_EEG_Z = 1.645) on the Researcher's synthetic-EEG setup, NO LLM calls.
Same sessions, EEG synthesis and conditions as eeg-harness-sim/phaseC/gate/rerank_eeg_proto.py (read-only import of
the sim's rescore/sim modules, bytecode off): Track 2 only (24, cached gemma4:cloud
answer at turn 12); eeg-synth consumer profile d=1.25, 20 s windows, latent z of that session; conditions eeg |
yoked (next session of the same src+group) | shuffle (own rows deranged) | noise (d=0); REPS reps.
Also re-runs the prototype's rule (confidence + w*zEEG, w=0.25) on the same synth rows as a reproduction check.

  EH_ROOT=/workspace/eeg-harness REPS=50 python3 tools/phaseC-tagger-eval/lead_eeg_synth.py > docs/sweeps/phaseC_lead_eeg_synth.txt
"""
import json, os, sys, math, re, statistics
sys.dont_write_bytecode = True
SIMR = os.environ.get("SIM_ROOT", "/workspace/eeg-harness-sim"); sys.path.insert(0, SIMR)
import rescore as RS, sim as SIM  # noqa: E402
HE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EH = os.environ.get("EH_ROOT", HE); REPS = int(os.environ.get("REPS", "50"))
Z = 1.645; MIN_TURNS = 4  # = packages/core/src/final-guesses.ts LEAD_EEG_Z / LEAD_EEG_MIN_TURNS (preset)
rs = RS.Rescorer([os.path.join(SIMR, "personas.json"), os.path.join(SIMR, "personas_c.json")])
ok = lambda pid, l: rs.level(pid, l) in ("exact", "close")


def parse(content):
    body = re.sub(r"^```(json)?|```$", "", content.strip()).strip()
    return [(x["label"], float(x.get("confidence", 0)), [int(t) for t in x.get("turns", [])]) for x in json.loads(body)["interests"]]


S = []
# The Phase C gate (runs_c/gate_x) is the HELD-OUT set of PREREG_leadeeg.md: never loaded or scored here.
bt = {}
for d in ("runs_b/full_w025", "runs_b/w05"):
    for l in open(os.path.join(SIMR, d, "turns.jsonl")):
        t = json.loads(l)
        if t["speaker"] == "user": bt.setdefault(d + "/" + t["run_id"], []).append(t)
    for l in open(os.path.join(SIMR, d, "runs.jsonl")):
        r = json.loads(l); bt.setdefault("_g", {})[d + "/" + r["run_id"]] = r.get("persona_group")
for l in open(os.path.join(HE, "tools/llm-extractor-eval/out/responses.jsonl")):
    x = json.loads(l)
    if x["turn"] != 12 or not x["ok"]: continue
    u = sorted(bt[x["session"]], key=lambda t: t["turn"])
    S.append(dict(src="track2", sid=x["session"], pid=x["persona"], group=bt["_g"][x["session"]],
                  z=[t["scores"].get("z") if t["scores"].get("z") is not None else 0.3 for t in u], text=[t["text"] for t in u],
                  answer=parse(json.loads(x["raw"])["message"]["content"]), seen=12))


def synth(s, d, rep):
    e = SIM.EegSynth(os.path.join(SIMR, "eeg-synth"), EH, d, "consumer", seed=SIM.stable_int(s["sid"], "rr", rep),
                     user_seed=SIM.stable_int(s["pid"], "head"))
    rows = [e.turn(z, 20.0, len(t), len(t) / 5.0 + 2.0)["eeg.engagementIndex"] for z, t in zip(s["z"][:s["seen"]], s["text"][:s["seen"]])]
    e.close(); return rows


def lead_eeg(ans, ei):
    """python mirror of eegReorder (final-guesses.ts); cross-checked against the TS code below"""
    ln = [math.log(max(1e-6, x)) for x in ei]
    labels = [a[0] for a in ans]
    if len(ln) < MIN_TURNS: return labels
    mu = statistics.mean(ln); sd = statistics.stdev(ln)
    if not sd > 1e-9: return labels
    st = []
    for _, _, turns in ans:
        zz = [(ln[t - 1] - mu) / sd for t in dict.fromkeys(turns) if 1 <= t <= len(ln)]
        st.append((statistics.mean(zz), len(zz)) if zz else None)
    idx = list(range(len(ans)))
    for i in range(1, len(idx)):
        for j in range(i, 0, -1):
            a, b = st[idx[j - 1]], st[idx[j]]
            if not a or not b or b[0] - a[0] <= Z * math.sqrt(1 / a[1] + 1 / b[1]): break
            idx[j - 1], idx[j] = idx[j], idx[j - 1]
    return [labels[i] for i in idx]


def proto(ans, ei, w=0.25):
    l = [math.log(max(1e-6, x)) for x in ei]; m = statistics.mean(l); sd = statistics.pstdev(l) or 1; z = [(x - m) / sd for x in l]
    def sc(i):
        _, conf, turns = ans[i]; tt = [t for t in turns if 1 <= t <= len(z)]
        return conf + w * (statistics.mean(z[t - 1] for t in tt) if tt else 0.0)
    return [ans[i][0] for i in sorted(range(len(ans)), key=lambda i: (-sc(i), i))]


groups = {}
for i, s in enumerate(S): groups.setdefault((s["src"], s["group"]), []).append(i)
res, xcheck = [], []
CONDS = ("eeg", "yoked", "shuffle", "noise")
for i, s in enumerate(S):
    g = groups[(s["src"], s["group"])]; yi = g[(g.index(i) + 1) % len(g)]
    for rep in range(REPS):
        own = synth(s, 1.25, rep); noise = synth(s, 0.0, rep)
        y = synth(S[yi], 1.25, rep); y = (y + [y[-1]] * len(own))[:len(own)]
        perm = SIM.derangement(len(own), SIM.stable_int(s["sid"], "sh", rep)); sh = [own[k] for k in perm]
        row = dict(src=s["src"], sid=s["sid"], rep=rep, lead=ok(s["pid"], s["answer"][0][0]),
                   lead3=any(ok(s["pid"], a[0]) for a in s["answer"][:3]))
        for c, ei in zip(CONDS, (own, y, sh, noise)):
            o = lead_eeg(s["answer"], ei)
            row[c] = ok(s["pid"], o[0]); row[c + "3"] = any(ok(s["pid"], l) for l in o[:3]); row[c + "_moved"] = o[0] != s["answer"][0][0]
            row["proto_" + c] = ok(s["pid"], proto(s["answer"], ei)[0])
            if rep < 3: xcheck.append(dict(ranked=[a[0] for a in s["answer"]], cites=[a[2] for a in s["answer"]], ei=ei, py=o))
        res.append(row)
    print("  done %s" % s["sid"], file=sys.stderr, flush=True)

# cross-check the python mirror against the real TS eegReorder
import subprocess, tempfile
tf = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False); json.dump(xcheck, tf); tf.close()
js = ("import fs from 'node:fs'; import { eegReorder } from '%s/packages/core/src/final-guesses.ts';"
      "const X = JSON.parse(fs.readFileSync(%s, 'utf8')); let bad = 0;"
      "for (const x of X) { const h = x.ei.map((v) => ({ turn: 0, hypothesis: null, top: [], eegLn: Math.log(Math.max(1e-6, v)) }));"
      " if (JSON.stringify(eegReorder(x.ranked, x.cites, h)) !== JSON.stringify(x.py)) bad++; } console.log(bad + '/' + X.length);") % (HE, json.dumps(tf.name))
xc = subprocess.run(["npx", "tsx", "--input-type=module", "-e", js], cwd=HE, capture_output=True, text=True).stdout.strip()

m = lambda v: sum(v) / len(v) if v else float("nan")
print("lead-eeg (LEAD_EEG_Z=%.3f, preset; min %d EEG turns) on synthetic EEG, %d reps; python mirror vs TS eegReorder mismatches: %s" % (Z, MIN_TURNS, REPS, xc))
print("")
print("| set | sessions | top-1 lead | top-1 lead-eeg: eeg | yoked | shuffle | noise | eeg - yoked | top-1 moved (eeg / noise) | top-3 lead -> lead-eeg eeg | proto w=.25: eeg | yoked |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|")
for src in ("track2",):
    rr = [r for r in res if src == "all" or r["src"] == src]; n = len({r["sid"] for r in rr})
    print("| %s | %d | %.3f | %.3f | %.3f | %.3f | %.3f | %+.3f | %.3f / %.3f | %.3f -> %.3f | %.3f | %.3f |" % (
        src, n, m([r["lead"] for r in rr]), *[m([r[c] for r in rr]) for c in CONDS], m([r["eeg"] - r["yoked"] for r in rr]),
        m([r["eeg_moved"] for r in rr]), m([r["noise_moved"] for r in rr]), m([r["lead3"] for r in rr]), m([r["eeg3"] for r in rr]),
        m([r["proto_eeg"] for r in rr]), m([r["proto_yoked"] for r in rr])))
print("\nper session where lead-eeg ever changes #1 (mean over reps): lead -> eeg / yoked / noise")
for sid in dict.fromkeys(r["sid"] for r in res):
    rr = [r for r in res if r["sid"] == sid]
    if any(r["eeg_moved"] or r["yoked_moved"] or r["noise_moved"] for r in rr):
        print("  %-45s %d -> %.2f / %.2f / %.2f  (moved: eeg %.2f, noise %.2f)" % (sid[-45:], rr[0]["lead"], m([r["eeg"] for r in rr]),
              m([r["yoked"] for r in rr]), m([r["noise"] for r in rr]), m([r["eeg_moved"] for r in rr]), m([r["noise_moved"] for r in rr])))
