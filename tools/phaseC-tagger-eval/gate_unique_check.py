#!/usr/bin/env python3
"""uniqueLabels regression check on the 8 Phase C gate sessions (runs_c/gate_x, bh_typing), NO LLM calls and NO scoring
(the gate stays held out: only label strings are compared, never judged). Same replay as the sim's
phaseC/gate/replay_gate_eeg.py typing arm: provider=mock, seed 11, user turns 1..11, llm-extract (rank lead) cache-only on a
/tmp copy of the gate's extractor_cache, maxCalls 0. Runs two HE builds (OLD = before uniqueLabels, NEW = after) and also
compares with the live run's recorded final_top3.

  python3 tools/phaseC-tagger-eval/gate_unique_check.py /tmp/he_old /tmp/he_new
"""
import json, os, re, shutil, subprocess, sys, tempfile
sys.dont_write_bytecode = True
SIM = os.environ.get("SIM_ROOT", "/workspace/eeg-harness-sim"); GATE = os.path.join(SIM, "runs_c/gate_x")


class Side:
    def __init__(self, root):
        env = {k: v for k, v in os.environ.items() if k not in ("OLLAMA_API_KEY", "BH_IDF_FREQ_FILE")}
        self.p = subprocess.Popen(["node", os.path.join(root, "packages/sim/dist/sidecar.js")], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, cwd=root, env=env)
    def call(self, m):
        self.p.stdin.write(json.dumps(m) + "\n"); self.p.stdin.flush()
        r = json.loads(self.p.stdout.readline())
        if not r.get("ok"): raise RuntimeError(r)
        return r
    def close(self): self.p.stdin.close(); self.p.wait(10)


runs = [json.loads(l) for l in open(os.path.join(GATE, "runs.jsonl"))]
turns = [json.loads(l) for l in open(os.path.join(GATE, "turns.jsonl"))]
key = lambda s: re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def replay(root, r, tmp):
    cdir = os.path.join(tmp, os.path.basename(root) + "_" + r["run_id"])
    shutil.copytree(os.path.join(GATE, "extractor_cache", r["run_id"]), cdir)
    t = {"kind": "llm-extract", "provider": "ollama", "baseUrl": "http://127.0.0.1:11434", "model": "gemma4:cloud",
         "atTurns": [6, 11], "numPredict": 768, "base": "keyphrase-idf", "cacheDir": cdir, "maxCalls": 0, "rank": "lead",
         "promptVersion": "v1"}  # the gate cache holds v1-prompt answers (core default is v2 since Nov 2 2026)
    sp = Side(root)
    try:
        sp.call({"cmd": "start", "options": {"provider": "mock", "seed": r["seed"], "tagger": t}})
        u = sorted([x for x in turns if x["run_id"] == r["run_id"] and x["speaker"] == "user"], key=lambda x: x["turn"])
        for x in u[:11]: sp.call({"cmd": "reply", "text": x["text"]})
        calls = (sp.call({"cmd": "hud"}).get("tagger") or {}).get("calls")
        fin = [g["label"] for g in sp.call({"cmd": "final_guesses", "k": 3})["guesses"]]
        sp.call({"cmd": "end"})
    finally:
        sp.close()
    return fin, calls


old, new = sys.argv[1], sys.argv[2]
tmp = tempfile.mkdtemp(prefix="gate_unique_")
same = live_same = net = 0
print("| session | OLD == NEW | NEW == live final_top3 | dup keys in OLD | NEW calls (network/cached) |\n|---|---|---|---|---|")
for r in runs:
    fo, co = replay(old, r, tmp); fn, cn = replay(new, r, tmp)
    dup = len(fo) - len({key(x) for x in fo})
    same += fo == fn; live_same += fn == r["final_top3"]; net += (cn or {}).get("network", 0) + (co or {}).get("network", 0)
    print("| %s | %s | %s | %d | %s/%s |" % (r["run_id"], fo == fn, fn == r["final_top3"], dup, (cn or {}).get("network"), (cn or {}).get("cached")))
shutil.rmtree(tmp)
print("\nOLD == NEW finals: %d/%d; NEW == live recorded: %d/%d; network calls: %d" % (same, len(runs), live_same, len(runs), net))
