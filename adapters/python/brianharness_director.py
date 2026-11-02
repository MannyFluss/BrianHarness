"""
BrianHarness Director adapter for the Harness Researcher's persona sim (sim.py, Python stdlib only).

Drop-in for sim.py's StandInDirector: opening(), respond(user_text) -> (reply, top3 | None, signals),
final_guesses(), and a .ledger dict. It drives the real Director through the JSON-lines sidecar
(packages/sim/dist/sidecar.js); see docs/SIDECAR.md.

    from brianharness_director import BrianHarnessDirector
    d = BrianHarnessDirector(provider="ollama", model="gemma3:4b", ollama_url="http://127.0.0.1:11434",
                             seed=11, temperature=0.7)
    first = d.opening()
    reply, top3, signals = d.respond("I spent the weekend on a ham radio contest")
    reply, top3, signals = d.respond("ok", features={"eeg.engagementIndex": 0.8, "eeg.quality": 1})  # optional EEG
    print(d.final_guesses(), d.ledger)
    d.close()

Final guesses come from the Director's anti-drift final-guess API (no extra LLM call), so the final
answer cannot regress away from a lead the Director held mid-session.
Paid backends (ollama "*:cloud", openai, anthropic, claude-code) need allow_paid=True; local
Ollama and the offline mock never do.
"""
import json, os, re, statistics, subprocess, threading

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SIDECAR = os.path.normpath(os.path.join(HERE, "..", "..", "packages", "sim", "dist", "sidecar.js"))
_WARM = re.compile(r"\b(love|loved|amazing|awesome|favorite|favourite|obsessed|fascinating|great|fun|wow|cool|passion|excited)\b", re.I)


def _text_signals(text):
    return {"words": len(text.split()), "questions": text.count("?"), "exclaims": text.count("!"),
            "warmth_hits": len(_WARM.findall(text))}


class SidecarError(RuntimeError):
    pass


class BrianHarnessDirector:
    director_impl = "brianharness"

    def __init__(self, provider="mock", model=None, ollama_url=None, base_url=None, seed=1, temperature=None,
                 allow_paid=False, eeg_weight=None, engagement=None, tagger=None, user_id=None,
                 data_dir=None, node="node", sidecar=DEFAULT_SIDECAR, text_signals=None, timeout_s=300):
        if not os.path.exists(sidecar):
            raise SidecarError("sidecar not built: %s (run `npm install && npm run build` in the repo)" % sidecar)
        args = [node, sidecar] + (["--allow-paid"] if allow_paid else [])
        self._p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, bufsize=1)
        self._err = []
        threading.Thread(target=lambda: [self._err.append(l) for l in self._p.stderr], daemon=True).start()
        self._timeout = timeout_s
        self._signals_fn = text_signals or _text_signals
        self.lengths, self.ledger, self.last_top3, self._opening = [], {}, [], None
        # tagger: a spec dict, or a kind string, e.g. "keyphrase-only" / "keyphrase-idf" (leak-free; see docs/SIDECAR.md).
        # "llm-extract" = keyphrase-idf + a cloud LLM interest extractor every N turns (paid: needs allow_paid and
        # OLLAMA_API_KEY in the env; calls https://ollama.com/api/chat, hard cap BH_LLM_MAX_CALLS, default 50,
        # persisted in BH_LLM_CACHE/calls.json). Without a key it runs offline (base tagger only, cache hits).
        if tagger == "llm-extract":
            tagger = {"kind": "llm-extract", "model": os.environ.get("BH_LLM_MODEL", "gemma4:cloud"),
                      "everyN": int(os.environ.get("BH_LLM_EVERY", "6")),
                      "cacheDir": os.environ.get("BH_LLM_CACHE", os.path.join(os.getcwd(), "llm_extract_cache")),
                      "maxCalls": int(os.environ.get("BH_LLM_MAX_CALLS", "50"))}
            # BH_LLM_PROMPT_VERSION=v1|v2 pins the extractor prompt (unset = the sidecar default, v2 since Nov 2 2026)
            if os.environ.get("BH_LLM_PROMPT_VERSION"):
                tagger["promptVersion"] = os.environ["BH_LLM_PROMPT_VERSION"]
        elif isinstance(tagger, str):
            tagger = {"kind": tagger}
        opts = {"provider": provider, "seed": seed, "allowPaid": bool(allow_paid)}
        for k, v in (("model", model), ("ollamaUrl", ollama_url), ("baseUrl", base_url), ("temperature", temperature),
                     ("eegWeight", eeg_weight), ("engagement", engagement), ("tagger", tagger),
                     ("userId", user_id), ("dataDir", data_dir)):
            if v is not None:
                opts[k] = v
        self.start_info = self._call({"cmd": "start", "options": opts})
        self.backend = self.start_info.get("backend")

    # -- sidecar plumbing
    def _call(self, msg):
        if self._p.poll() is not None:
            raise SidecarError("sidecar exited: %s" % "".join(self._err)[-500:])
        self._p.stdin.write(json.dumps(msg) + "\n")
        self._p.stdin.flush()
        line = self._p.stdout.readline()
        if not line:
            raise SidecarError("sidecar closed stdout: %s" % "".join(self._err)[-500:])
        out = json.loads(line)
        if not out.get("ok"):
            raise SidecarError(out.get("error", "unknown sidecar error"))
        return out

    def _refresh_ledger(self, ledger):
        self.ledger = {v["label"]: round(v["mean"], 3) for v in ledger.values()}

    # -- StandInDirector interface
    def opening(self):
        self._opening = self.start_info["director"]["text"]
        return self._opening

    def respond(self, user_text, features=None, events=None, sent_at=None):
        """-> (reply, internal_top3 labels, signals dict). features: optional EEG FeatureMap for this turn."""
        msg = {"cmd": "reply", "text": user_text}
        if features:
            msg["features"] = features
        if events is not None:
            msg["events"] = events
        if sent_at is not None:
            msg["sentAt"] = sent_at
        out = self._call(msg)
        hud = self._call({"cmd": "hud"})
        self._refresh_ledger(hud["ledger"])
        sig = self._signals_fn(user_text)
        self.lengths.append(sig["words"])
        top3 = [g["label"] for g in out["top3"]]
        self.last_top3 = top3
        sig.update(engagement=round(out["user"]["engagement"], 3), user_median_words=statistics.median(self.lengths),
                   ledger_top3=top3, hypothesis=out["user"]["hypothesis"] and out["user"]["hypothesisLabel"],
                   eeg=out["user"].get("eeg") or {})
        return out["director"]["text"], top3 or None, sig

    def final_guesses(self, k=3):
        return [g["label"] for g in self._call({"cmd": "final_guesses", "k": k})["guesses"]]

    def close(self):
        if self._p.poll() is None:
            try:
                self._call({"cmd": "end"})
            except Exception:
                pass
            self._p.stdin.close()
            self._p.wait(timeout=10)

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass


if __name__ == "__main__":  # smoke test: python3 brianharness_director.py
    d = BrianHarnessDirector(seed=3)
    print("DIRECTOR:", d.opening())
    for u in ["eh, not much. work.", "I did a ham radio contest all weekend, worked 40 stations in Morse code!",
              "yeah ham radio is the best, DX contacts with Japan on a tiny antenna", "sure"]:
        r, top3, sig = d.respond(u)
        print("USER:", u, "\nDIRECTOR:", r, "\n  top3:", top3, "engagement:", sig["engagement"])
    print("FINAL:", d.final_guesses(), "\nLEDGER:", d.ledger)
    d.close()
