#!/usr/bin/env python3
"""BOX-SIDE scorer for the Mac run. Takes the returned out/responses.jsonl, restricts to the MATCHED subset
(sessions that have an OK response from every model in it), writes that subset to <out>/matched_sessions.json
and runs the offline replay (no network; OLLAMA_API_KEY is stripped) for keyphrase-only (baseline),
keyphrase-idf, llm-extract+keyphrase-idf, llm-extract alone, and the LLM's own top-3 per model.

  python3 tools/llm-extractor-eval/score.py [--out tools/llm-extractor-eval/out] [--tag track2]
  -> docs/sweeps/phaseC_tagger_<tag>.{md,jsonl}
"""
import argparse, json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
HE = os.path.dirname(os.path.dirname(HERE))
ap = argparse.ArgumentParser()
ap.add_argument("--out", default=os.path.join(HERE, "out"))
ap.add_argument("--tag", default="track2")
a = ap.parse_args()
resp = os.path.join(a.out, "responses.jsonl")
R = [json.loads(l) for l in open(resp) if l.strip()]
models = sorted({r["model"] for r in R if r.get("ok") is not False}, key=lambda m: (m != "gemma4:cloud", m))
if not models:
    sys.exit("no OK responses in %s" % resp)
chosen = json.load(open(os.path.join(HERE, "sessions.json")))
# matched = the sessions whose turn-12 response is OK for every model (turn-6 responses are used where present)
last = max(chosen.get("turns", [12]))
have = {m: {r["session"] for r in R if r["model"] == m and r.get("turn", last) == last and r.get("ok") is not False} for m in models}
for m in models:
    print("  %s: turn-6/early responses OK for %d sessions" % (m, len({r["session"] for r in R if r["model"] == m and r.get("turn", last) != last and r.get("ok") is not False})))
matched = [s for s in chosen["sessions"] if all(s in have[m] for m in models)]
print("models: %s; OK responses per model: %s; matched sessions: %d" % (models, {m: len(v) for m, v in have.items()}, len(matched)))
calls = os.path.join(a.out, "calls.json")
if os.path.exists(calls):
    print("network calls used on the Mac (counter): %s / 50" % json.load(open(calls))["calls"])
ms = os.path.join(a.out, "matched_sessions.json")
json.dump({"models": models, "sessions": matched}, open(ms, "w"), indent=1)
sys.exit(subprocess.call([sys.executable, os.path.join(HE, "tools/phaseC-tagger-eval/replay_taggers.py"), "--sessions", ms,
                          "--responses", resp, "--llm-models", ",".join(models), "--llm-turns", ",".join(str(t) for t in chosen.get("turns", [12])),
                          "--tag", a.tag]))
