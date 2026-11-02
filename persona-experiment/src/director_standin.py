"""STAND-IN DIRECTOR — NOT the real EEG Harness Director.

No Director implementation existed in /workspace (checked /workspace/harness2,
which is the unrelated open-source "Harness²" agent-optimization framework, and
/workspace/grokbot, which holds only a webhook env file). This minimal stand-in
exists so the persona playtest can run. Replace it with the real Director by
implementing the same 3 methods: opening(), respond(user_text), final_guesses().

Modes
  baseline : generic friendly chat. No profiling, no steering.
  typing   : typing-only adaptation. Each user reply is scored for engagement
             from text signals (length vs. this user's own running median,
             questions asked back, exclamation marks, warmth words, whether the
             user introduced a topic unprompted). Engagement is credited to the
             topics in that reply (an "interest ledger"); the Director then
             steers toward the hottest topics while still exploring.
"""
import math, re, statistics

WARMTH = ["love", "honestly", "actually", "oh", "favorite", "favourite", "obsessed", "fun",
          "amazing", "cool", "can't stop", "hours", "fascinat", "really"]

BASELINE_SYS = (
    "You are a friendly conversational companion. Chat naturally and warmly about everyday "
    "topics. Keep replies to 1-3 sentences and end with a light question. Do NOT try to "
    "figure out the user's hobbies or passions on purpose; just keep a pleasant, generic "
    "conversation going, moving between common small-talk topics.")

TYPING_SYS = (
    "You are the 'Director', an adaptive conversational companion whose goal is to make the "
    "conversation as absorbing as possible for THIS user by discovering what they are most "
    "passionate about, using only how they type. You are given an engagement readout for "
    "their last message and an interest ledger (topics -> accumulated engagement). Strategy: "
    "turns 1-3 explore varied topics; afterwards spend most turns steering toward and drilling "
    "into the highest-engagement topic (and its more specific sub-areas), with an occasional "
    "adjacent probe. Be specific and curious; avoid bluntly asking 'what is your passion'. "
    "Keep replies to 1-3 sentences.\n"
    "Return ONLY JSON: {\"topics_in_last_user_msg\": [short topic labels], "
    "\"user_initiated_topics\": [topics the user raised without being asked], "
    "\"reply\": \"your next message to the user\", "
    "\"top3_guesses\": [your current 3 best guesses of their passion, most specific first]}")

FINAL_SYS = (
    "You just finished a conversation. Based on it, guess the ONE specific hobby/topic this "
    "user is most passionate about. Be as specific as the evidence allows. Return ONLY JSON: "
    "{\"top3_guesses\": [g1, g2, g3], \"rationale\": \"one sentence\"}")


def text_signals(text):
    words = len(text.split())
    low = text.lower()
    return {
        "words": words,
        "questions": text.count("?"),
        "exclaims": text.count("!"),
        "warmth_hits": sum(low.count(w) for w in WARMTH),
    }


class StandInDirector:
    def __init__(self, llm, model, mode, seed=None, mock_ctx=None):
        assert mode in ("baseline", "typing")
        self.llm, self.model, self.mode, self.seed = llm, model, mode, seed
        self.history = []          # chat messages from the Director's point of view
        self.lengths = []
        self.ledger = {}           # topic -> engagement credit
        self.last_signals = None
        self.mock_ctx = mock_ctx or {}

    # --- public interface -------------------------------------------------
    def opening(self):
        msg = "Hey! I'm here to chat about whatever. How's your week been going?"
        self.history.append({"role": "assistant", "content": msg})
        return msg, None

    def respond(self, user_text):
        """Returns (reply_text, internal_top3_or_None, signals_dict_or_None)."""
        self.history.append({"role": "user", "content": user_text})
        if self.mode == "baseline":
            reply = self.llm.chat(self.model, [{"role": "system", "content": BASELINE_SYS}] + self.history,
                                  role="director_baseline", seed=self.seed, ctx=self.mock_ctx).strip()
            self.history.append({"role": "assistant", "content": reply})
            return reply, None, None
        return self._respond_typing(user_text)

    def final_guesses(self):
        transcript = "\n".join(f"{'DIRECTOR' if m['role']=='assistant' else 'USER'}: {m['content']}" for m in self.history)
        extra = ""
        if self.mode == "typing":
            extra = "\n\nEngagement ledger (topic: credit): " + self._ledger_str()
        from llm import parse_json
        out = self.llm.chat(self.model, [{"role": "system", "content": FINAL_SYS},
                                         {"role": "user", "content": transcript + extra}],
                            role="director_final", json_mode=True, seed=self.seed, temperature=0.2, ctx=self.mock_ctx)
        g = parse_json(out).get("top3_guesses", [])
        return [str(x) for x in g][:3]

    # --- typing-mode internals ---------------------------------------------
    def _engagement(self, sig, initiated):
        med = statistics.median(self.lengths) if self.lengths else max(sig["words"], 1)
        rel = math.log((sig["words"] + 1) / (med + 1))          # >0 = longer than this user's norm
        return round(rel + 0.3 * min(sig["questions"], 2) + 0.15 * min(sig["exclaims"], 3)
                     + 0.2 * min(sig["warmth_hits"], 4) + (0.5 if initiated else 0.0), 3)

    def _ledger_str(self, k=8):
        top = sorted(self.ledger.items(), key=lambda kv: -kv[1])[:k]
        return ", ".join(f"{t}: {v:+.2f}" for t, v in top) or "(empty)"

    def _respond_typing(self, user_text):
        from llm import parse_json
        sig = text_signals(user_text)
        self.lengths.append(sig["words"])
        med = statistics.median(self.lengths)
        readout = (f"[engagement readout for last user msg] words={sig['words']} (this user's median={med}), "
                   f"questions_back={sig['questions']}, exclaims={sig['exclaims']}, warmth_words={sig['warmth_hits']}\n"
                   f"[interest ledger] {self._ledger_str()}")
        msgs = [{"role": "system", "content": TYPING_SYS}] + self.history[:-1] + [
            {"role": "user", "content": user_text + "\n\n---\n" + readout}]
        ledger_top = [t for t, _ in sorted(self.ledger.items(), key=lambda kv: -kv[1])]
        ctx = dict(self.mock_ctx, ledger_top=ledger_top, hot_topic=ledger_top[0] if ledger_top else None)
        raw = self.llm.chat(self.model, msgs, role="director_typing", json_mode=True, seed=self.seed, ctx=ctx)
        try:
            out = parse_json(raw)
        except Exception:
            out = {"reply": raw.strip(), "topics_in_last_user_msg": [], "user_initiated_topics": [], "top3_guesses": []}
        initiated = [t.lower() for t in out.get("user_initiated_topics", []) if isinstance(t, str)]
        score = self._engagement(sig, bool(initiated))
        for t in set([t.lower() for t in out.get("topics_in_last_user_msg", []) if isinstance(t, str)] + initiated):
            self.ledger[t] = self.ledger.get(t, 0.0) + score + (0.5 if t in initiated else 0.0)
        reply = str(out.get("reply", "")).strip() or "Tell me more?"
        self.history.append({"role": "assistant", "content": reply})
        sig.update(engagement=score, ledger_top3=sorted(self.ledger, key=lambda t: -self.ledger[t])[:3])
        guesses = [str(x) for x in out.get("top3_guesses", [])][:3]
        return reply, guesses, sig
