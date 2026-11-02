#!/usr/bin/env python3
"""Phase C tagger check: OFFLINE replay of the Phase B transcripts through the real sidecar, same method as
eeg-harness-sim/phaseC/replay_b.py (user text + logged EEG features re-fed in order, provider=mock, same seed and
eegWeight; final top-3 scored with the sim's rescore.py). Reads the sim dir only; writes under docs/sweeps/.

  python3 tools/phaseC-tagger-eval/replay_taggers.py                 # track 1: keyphrase-only vs keyphrase-idf, all 144
  python3 tools/phaseC-tagger-eval/replay_taggers.py --sessions tools/llm-extractor-eval/sessions.json \\
      --responses tools/llm-extractor-eval/out/responses.jsonl --tag llm   # track 2 matched subset (no network)
  python3 tools/phaseC-tagger-eval/replay_taggers.py --idf-freq-file research/wordfreq/wordfreq_small_en_zipf10.txt \
      --tag idf_cc0_vs_wordfreq   # bundled CC0 table vs the dev-only wordfreq research table, all 144
"""
import argparse, collections, json, os, subprocess, sys
sys.dont_write_bytecode = True
HE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SIM = os.environ.get("SIM_ROOT", "/workspace/eeg-harness-sim")
sys.path.insert(0, SIM)
import rescore as RS  # noqa: E402  (read-only import; bytecode disabled)

SIDECAR = os.path.join(HE, "packages/sim/dist/sidecar.js")
DIRS = ["runs_b/full_w025", "runs_b/w05"]


class Side:
    def __init__(self):
        env = dict(os.environ)
        env.pop("OLLAMA_API_KEY", None)  # replay never spends calls, even if a key is set
        env.pop("BH_IDF_FREQ_FILE", None)  # columns choose their frequency table explicitly (freqFile)
        self.p = subprocess.Popen(["node", SIDECAR], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, text=True, env=env, cwd=HE)

    def call(self, m):
        self.p.stdin.write(json.dumps(m) + "\n"); self.p.stdin.flush()
        r = json.loads(self.p.stdout.readline())
        if not r.get("ok"):
            raise RuntimeError(r)
        return r

    def close(self):
        self.p.stdin.close(); self.p.wait(10)


def load(p):
    return [json.loads(l) for l in open(p) if l.strip()]


def cases(only=None):
    out = []
    for d in DIRS:
        dd = os.path.join(SIM, d)
        runs = load(os.path.join(dd, "runs.jsonl")); ids = {r["run_id"] for r in runs}
        ut = {}
        for t in load(os.path.join(dd, "turns.jsonl")):
            if t["run_id"] in ids and t["speaker"] == "user":
                ut[(t["run_id"], t["turn"])] = t
        for r in runs:
            key = d + "/" + r["run_id"]
            if only is not None and key not in only:
                continue
            u = [ut[k] for k in sorted(k for k in ut if k[0] == r["run_id"])]
            out.append((d, r, u))
    return out


def replay(side, r, u, spec):
    ew = (r.get("eeg") or {}).get("eeg_weight", 0.25)
    side.call({"cmd": "start", "options": {"provider": "mock", "seed": r["seed"], "tagger": spec, "eegWeight": ew}})
    finals = []
    for t in u:
        m = {"cmd": "reply", "text": t["text"]}
        f = t["scores"].get("eeg_features")
        if f:
            m["features"] = f
        side.call(m)
    hud = side.call({"cmd": "hud"})
    fin = side.call({"cmd": "final_guesses", "k": 3})["guesses"]
    side.call({"cmd": "end"})
    return [g["label"] for g in fin], hud.get("ledger") or {}, hud.get("tagger") or {}


def parse_llm(raw):
    """Python mirror of parseExtractorResponse: /api/chat JSON -> message.content -> {"interests":[...]}"""
    try:
        content = json.loads(raw).get("message", {}).get("content", "")
    except Exception:
        content = raw
    content = content or ""
    i, j = content.find("{"), content.rfind("}")
    try:
        items = json.loads(content[i:j + 1]).get("interests", []) if i >= 0 < j else []
    except Exception:
        items = []
    return [str(x.get("label", "")).strip() for x in items if isinstance(x, dict) and str(x.get("label", "")).strip()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sessions", help="JSON list of '<dir>/<run_id>' (matched subset)")
    ap.add_argument("--responses", help="llm-extractor responses.jsonl (cache-only, never calls the network)")
    ap.add_argument("--llm-models", default="gemma4:cloud", help="comma list; one llm-extract column per model")
    ap.add_argument("--llm-turns", default="12", help="user turns the extractor was called at (must match the prepared prompts)")
    ap.add_argument("--tag", default="track1")
    ap.add_argument("--idf-freq-file", help="extra keyphrase-idf column with this external zipf10 table (e.g. research/wordfreq/...)")
    a = ap.parse_args()
    only = set(json.load(open(a.sessions))["sessions"]) if a.sessions else None
    taggers = {"keyphrase-only (af1bbbe baseline)": {"kind": "keyphrase-only"}, "keyphrase-idf (bundled CC0 table)": {"kind": "keyphrase-idf"}}
    if a.idf_freq_file:
        taggers["keyphrase-idf (freqFile %s)" % os.path.basename(a.idf_freq_file)] = {"kind": "keyphrase-idf", "freqFile": os.path.abspath(a.idf_freq_file)}
    if a.responses:
        turns = [int(x) for x in a.llm_turns.split(",")]
        for m in a.llm_models.split(","):
            # promptVersion pinned to v1: responses.jsonl was made with the v1 prompt (the core default is v2 since
            # Nov 2 2026); unpinned, every cached answer would miss and the replay would change silently
            b = {"kind": "llm-extract", "model": m, "atTurns": turns, "responsesFile": os.path.abspath(a.responses), "promptVersion": "v1"}
            # merge variants (core LlmExtractorOptions.rank / observeScale); "lead" is the core default
            taggers["llm-extract %s alone, old merge (reference)" % m] = dict(b, base="none", rank="none")
            taggers["llm-extract %s + keyphrase-idf, old merge (rank none)" % m] = dict(b, rank="none")
            taggers["llm-extract %s + keyphrase-idf, evidence x3 (rank none)" % m] = dict(b, rank="none", observeScale=3)
            taggers["llm-extract %s + keyphrase-idf, soft prior 0.5" % m] = dict(b, rank="soft", priorWeight=0.5)
            taggers["llm-extract %s + keyphrase-idf, lead (DEFAULT)" % m] = dict(b, rank="lead")
            taggers["llm-extract %s + keyphrase-idf, lead-eeg (z 1.645)" % m] = dict(b, rank="lead-eeg")
            taggers["llm-extract %s alone, lead" % m] = dict(b, base="none", rank="lead")
    direct = {}
    if a.responses:
        for l in open(a.responses):
            if l.strip():
                j = json.loads(l)
                if j.get("ok") is not False and j.get("turn", 12) == max(int(x) for x in a.llm_turns.split(",")):
                    direct[(j["model"], j["session"])] = parse_llm(j["raw"])  # the end-of-session call
    rs = RS.Rescorer([os.path.join(SIM, "personas.json")])
    side = Side()
    rows = []
    try:
        for d, r, u in cases(only):
            pid = r["persona_id"]
            row = {"dir": d, "run_id": r["run_id"], "persona_id": pid, "condition": r["condition"],
                   "persona_group": r.get("persona_group"),
                   "mentioned": any(rs.touches(pid, t["text"]) or rs.level(pid, t["text"]) in ("exact", "close") for t in u),
                   "replay": {}}
            for name, spec in taggers.items():
                labels, ledger, tg = replay(side, r, u, spec)
                sc = rs.score_case(pid, labels, [])
                said = " ".join(t["text"] for t in u).lower()
                prov = all(w in said for l in labels for w in l.lower().split()) if "llm" not in spec["kind"] else None
                row["replay"][name] = {"final": labels, "top1": sc["rescore_top1"], "top3": sc["rescore_top3"],
                                       "category": sc["rescore_category"],
                                       "ledger_hits": [v["label"] for v in ledger.values() if rs.level(pid, v["label"]) in ("exact", "close")][:5],
                                       "x_ids": sorted(k for k in ledger if k.startswith("x:")),
                                       "calls": tg.get("calls"), "freq": tg.get("freq"), "labels_from_user_text": prov}
            if a.responses:
                for m in a.llm_models.split(","):
                    labels = direct.get((m, d + "/" + r["run_id"]), [])[:3]
                    sc = rs.score_case(pid, labels, [])
                    row["replay"]["llm %s direct (its own top-3 at the last turn, no session)" % m] = {
                        "final": labels, "top1": sc["rescore_top1"], "top3": sc["rescore_top3"], "category": sc["rescore_category"],
                        "ledger_hits": [], "x_ids": [], "calls": None, "labels_from_user_text": None, "answered": (m, d + "/" + r["run_id"]) in direct}
            rows.append(row)
            print(r["run_id"], {k[:18]: v["top3"] for k, v in row["replay"].items()}, flush=True)
    finally:
        side.close()
    out = os.path.join(HE, "docs/sweeps/phaseC_tagger_%s" % a.tag)
    with open(out + ".jsonl", "w") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")
    names = list(taggers) + (["llm %s direct (its own top-3 at the last turn, no session)" % m for m in a.llm_models.split(",")] if a.responses else [])
    write_md(rows, names, out + ".md", a)


def pc(k, n):
    return "%d/%d (%.0f%%)" % (k, n, 100.0 * k / n if n else 0)


def write_md(R, names, path, a):
    L = ["# Phase C tagger replay: %s" % a.tag, "",
         "Method = eeg-harness-sim/phaseC/replay_b.py: Phase B user text + logged EEG features re-fed in order into the real",
         "sidecar (provider=mock, same seed and eegWeight), final top-3 scored with the sim's rescore.py (exact|close = hit).",
         "Generated by tools/phaseC-tagger-eval/replay_taggers.py at HE commit `%s`." % subprocess.run(
             ["git", "rev-parse", "--short", "HEAD"], cwd=HE, capture_output=True, text=True).stdout.strip(), ""]
    groups = [("ALL sessions", R), ("bh_typing only", [r for r in R if r["condition"] == "bh_typing"]),
              ("sessions where the persona mentioned the passion", [r for r in R if r["mentioned"]])]
    for g in ("chatty", "medium", "terse"):
        groups.append(("persona group %s" % g, [r for r in R if r["persona_group"] == g]))
    for label, S in groups:
        n = len(S)
        if not n:
            continue
        L += ["## %s (n=%d)" % (label, n), "", "| tagger | top-1 | **top-3** | category (incl. broad) | ledger holds exact/close | curated x: ids |",
              "|---|---|---|---|---|---|"]
        for nm in names:
            L.append("| %s | %s | %s | %s | %s | %s |" % (nm, pc(sum(r["replay"][nm]["top1"] for r in S), n), pc(sum(r["replay"][nm]["top3"] for r in S), n),
                     pc(sum(r["replay"][nm]["category"] for r in S), n), pc(sum(bool(r["replay"][nm]["ledger_hits"]) for r in S), n),
                     pc(sum(bool(r["replay"][nm]["x_ids"]) for r in S), n)))
        L.append("")
    L += ["## Per persona (top-3 hits / sessions)", "", "| persona | group | mentioned | " + " | ".join(names) + " |", "|---|---|---|" + "---|" * len(names)]
    for pid in sorted({r["persona_id"] for r in R}):
        S = [r for r in R if r["persona_id"] == pid]
        L.append("| %s | %s | %d/%d | %s |" % (pid, S[0]["persona_group"], sum(r["mentioned"] for r in S), len(S),
                 " | ".join(str(sum(r["replay"][n]["top3"] for r in S)) for n in names)))
    L += ["", "## Obvious cases: p07_helen (Justinian / Constantinople / Basil II)", ""]
    for r in [r for r in R if r["persona_id"] == "p07_helen"]:
        L.append("- %s/%s: " % (r["dir"].split("/")[-1], r["run_id"]) + "; ".join("%s -> %s%s" % (nm.split(" (")[0], r["replay"][nm]["final"], " HIT" if r["replay"][nm]["top3"] else "") for nm in names))
    L += ["", "Label provenance (every final-label word occurs in that session's user text; n/a for LLM labels): " + "; ".join(
        "%s %s" % (nm.split(" (")[0], pc(sum(bool(r["replay"][nm]["labels_from_user_text"]) for r in R), len(R)))
        for nm in names if "llm" not in nm)]
    for nm in names:
        cnt = collections.Counter(l for r in R for l in r["replay"][nm]["final"])
        L += ["", "Most common final labels, %s: " % nm + ", ".join("%s (%d)" % kv for kv in cnt.most_common(15))]
    calls = [r["replay"][nm].get("calls") for r in R for nm in names if r["replay"][nm].get("calls")]
    if calls:
        tot = collections.Counter()
        for c in calls:
            tot.update({k: v for k, v in c.items() if isinstance(v, (int, float)) and not isinstance(v, bool)})
        L += ["", "Extractor call accounting during scoring (network must be 0): %s" % dict(tot)]
    open(path, "w").write("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
