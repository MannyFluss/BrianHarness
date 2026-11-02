"""LLM clients: real Ollama Cloud + deterministic mock for dry runs.

Ollama Cloud API (verified 2026-11-01 against https://docs.ollama.com/cloud):
  POST https://ollama.com/api/chat
  Authorization: Bearer $OLLAMA_API_KEY
  body: {"model": ..., "messages": [...], "stream": false, "format"?: "json", "options"?: {...}}
  answer: response["message"]["content"]
Model names must match https://ollama.com/api/tags (e.g. "gemma4:31b", "gpt-oss:120b").
"""
import json, os, random, re, time, urllib.request, urllib.error, threading



class CallCounter:
    def __init__(self):
        self.lock = threading.Lock()
        self.calls = 0
        self.by_role = {}

    def add(self, role):
        with self.lock:
            self.calls += 1
            self.by_role[role] = self.by_role.get(role, 0) + 1


class OllamaClient:
    """Configurable chat client. Defaults to Ollama Cloud, but can point at any
    endpoint that speaks Ollama's /api/chat format (e.g. a Hermes Bridge proxy)
    or an OpenAI-compatible /v1/chat/completions endpoint.

    Config (constructor args override env vars):
      LLM_BASE_URL   default "https://ollama.com"
      LLM_CHAT_PATH  default "/api/chat"  (use "/v1/chat/completions" with LLM_API_FORMAT=openai)
      LLM_API_FORMAT "ollama" (default) | "openai"
      LLM_TOKEN_ENV  name of the env var holding a bearer token; default "OLLAMA_API_KEY".
                     Token is OPTIONAL — if unset, no Authorization header is sent.
    """
    def __init__(self, base_url=None, chat_path=None, token_env=None, api_format=None,
                 timeout=180, max_retries=4):
        self.base_url = (base_url or os.environ.get("LLM_BASE_URL", "https://ollama.com")).rstrip("/")
        self.chat_path = chat_path or os.environ.get("LLM_CHAT_PATH", "/api/chat")
        self.api_format = api_format or os.environ.get("LLM_API_FORMAT", "ollama")
        self.token_env = token_env or os.environ.get("LLM_TOKEN_ENV", "OLLAMA_API_KEY")
        self.token = os.environ.get(self.token_env) or None
        self.url = self.base_url + self.chat_path
        self.timeout, self.max_retries = timeout, max_retries
        self.counter = CallCounter()

    def describe(self):
        return {"url": self.url, "api_format": self.api_format, "token_env": self.token_env,
                "token_present": bool(self.token)}

    def _body(self, model, messages, json_mode, seed, temperature):
        if self.api_format == "openai":
            body = {"model": model, "messages": messages, "stream": False, "temperature": temperature}
            if seed is not None:
                body["seed"] = seed
            if json_mode:
                body["response_format"] = {"type": "json_object"}
            return body
        body = {"model": model, "messages": messages, "stream": False, "options": {"temperature": temperature}}
        if seed is not None:
            body["options"]["seed"] = seed
        if json_mode:
            body["format"] = "json"
        return body

    def _content(self, out):
        if self.api_format == "openai":
            return out["choices"][0]["message"]["content"]
        return out["message"]["content"]

    def chat(self, model, messages, role, json_mode=False, seed=None, temperature=0.8, ctx=None):
        data = json.dumps(self._body(model, messages, json_mode, seed, temperature)).encode()
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        last = None
        for attempt in range(self.max_retries):
            req = urllib.request.Request(self.url, data=data, method="POST", headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    out = json.loads(r.read())
                self.counter.add(role)
                return self._content(out)
            except urllib.error.HTTPError as e:
                last = f"HTTP {e.code}: {e.read()[:300]!r}"
                if e.code in (400, 401, 403, 404):
                    raise RuntimeError(last)
            except Exception as e:  # timeouts, connection resets
                last = repr(e)
            time.sleep(2 ** attempt * 3)
        raise RuntimeError(f"LLM call failed after retries: {last}")


class MockLLM:
    """Deterministic fake used for the dry run. It is NOT a model of anything —
    it only exercises the pipeline end to end. Behaviour is keyword-driven.
    `ctx` carries structured hints (e.g. persona keywords) so the mock can be
    crude-but-coherent without parsing prompts."""

    TOPICS = ["weekend plans", "music", "travel", "food", "work", "nature and outdoors",
              "games", "history", "art", "technology", "animals", "fixing things"]

    def __init__(self):
        self.counter = CallCounter()

    def chat(self, model, messages, role, json_mode=False, seed=None, temperature=0.8, ctx=None):
        self.counter.add(role)
        ctx = ctx or {}
        rng = random.Random(f"{seed}-{role}-{len(messages)}-{ctx.get('persona_id')}")
        last = messages[-1]["content"].lower() if messages else ""
        if role == "persona":
            kws = ctx["keywords"]
            hit = any(k in last for k in kws) or any(h in last for h in ctx.get("adjacent", []))
            base = {"terse": 6, "medium": 18, "chatty": 40}[ctx["talkativeness"]]
            if hit:
                return (f"Oh, honestly that's close to something I really like. "
                        f"I could talk about {rng.choice(kws)} for hours — " + "it is so great " * (base // 4 + 3)
                        + "What made you ask?")
            return " ".join(["sure", "fine", "yeah", "ok", "it's alright"][rng.randrange(5)] for _ in range(max(2, base // 3)))
        if role == "persona_rating":
            return json.dumps({"rating": rng.randint(2, 6), "reason": "mock rating"})
        if role == "director_typing":
            hot = ctx.get("hot_topic")
            topic = hot if (hot and rng.random() < 0.7) else rng.choice(self.TOPICS)
            user_topics = [t for t in self.TOPICS if any(w in last for w in t.split())][:2]
            m = re.search(r"i could talk about (\w+)", last)
            if m:
                user_topics.append(m.group(1))
            return json.dumps({"topics_in_last_user_msg": user_topics or ["small talk"],
                               "user_initiated_topics": [m.group(1)] if m else [],
                               "reply": f"Tell me more about {topic}? Anything there you enjoy?",
                               "top3_guesses": (ctx.get("ledger_top") or ["unknown", "unknown", "unknown"])[:3]})
        if role == "director_baseline":
            return f"Nice. So how about {rng.choice(self.TOPICS)} — anything going on there?"
        if role == "director_final":
            words = re.findall(r"i could talk about (\w+)", " ".join(m["content"].lower() for m in messages))
            g = (list(dict.fromkeys(words)) + ["music", "travel", "food"])[:3]
            return json.dumps({"top3_guesses": g, "rationale": "mock"})
        if role == "judge":
            kws = ctx["keywords"]
            matches = [any(k in g.lower() or g.lower() in k for k in kws) for g in ctx["guesses"]]
            first_dir = next((i + 1 for i, t in enumerate(ctx["director_turns"]) if any(k in t.lower() for k in kws)), None)
            first_int = next((i + 1 for i, t in enumerate(ctx["internal_top1"]) if t and any(k in t.lower() or t.lower() in k for k in kws)), None)
            return json.dumps({"guess_match_levels": ["exact" if m else "none" for m in matches],
                               "first_director_turn_touching_passion": first_dir,
                               "first_internal_guess_correct_turn": first_int, "notes": "mock judge"})
        raise ValueError(role)


def parse_json(text):
    """Tolerant JSON extraction (models sometimes wrap JSON in prose/fences)."""
    try:
        return json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, re.S)
        if m:
            return json.loads(m.group(0))
        raise
