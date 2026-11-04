// E4: o200k_base in pure TS (parity with python tiktoken 0.14.0), and the context share tracker against the spec's
// arithmetic and hand-worked sessions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { ContextShareTracker, loadO200k, O200K_RANKS_SHA256 } from "../src/actor-director/index.ts";
import { renderActorText } from "../src/ad-contracts/index.ts";
import type { TokenCounter } from "../src/actor-director/index.ts";

const FIX = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "o200k-parity.json"), "utf8")) as { cases: Array<{ text: string; count: number; ids?: number[] }> };

test("vendored o200k_base rank file: sha256 pinned", () => {
  const raw = gunzipSync(readFileSync(join(import.meta.dirname, "..", "vendor", "o200k_base.tiktoken.gz")));
  assert.equal(createHash("sha256").update(raw).digest("hex"), O200K_RANKS_SHA256);
  assert.equal(loadO200k().size, 199998);
});

test(`o200k_base parity with python tiktoken on ${FIX.cases.length} texts (R4 dev, R3 prompt slots, synthetic unicode)`, () => {
  const t = loadO200k();
  let ids = 0;
  for (const c of FIX.cases) {
    assert.equal(t.count(c.text), c.count, JSON.stringify(c.text.slice(0, 60)));
    if (c.ids) { assert.deepEqual(t.encode(c.text), c.ids, JSON.stringify(c.text)); ids++; }
  }
  assert.ok(ids > 100);
});

// a counter whose numbers are given by hand: each text is "<n tokens>" -> n
const fake: TokenCounter = { name: "fake", count: (s) => (s ? Number(/^#(\d+)/.exec(s)?.[1] ?? NaN) : 0) };
const tok = (n: number) => `#${n}`;

test("spec arithmetic: S 230, H 1420, U 60, D 41 -> share 41/1751 = 2.3 %, dynamic 41/1521 = 2.7 %", () => {
  const tr = new ContextShareTracker(fake);
  const r = tr.measure(12, "n5", false, { system: tok(230), history: [{ role: "user", text: tok(1420) }], user: tok(60), hint: tok(41) });
  assert.equal(r.total, 1751);
  assert.equal(r.share, 41 / 1751);
  assert.equal(r.dynamic_share, 41 / 1521);
  assert.equal(r.share.toFixed(3), "0.023");
  assert.equal(r.dynamic_share.toFixed(3), "0.027");
});

test("hand-worked 4-request session (fake counts): session, dynamic, echo, injection rate, mean / max", () => {
  const tr = new ContextShareTracker(fake);
  // t1 opener: S100 H0 U5 D0
  tr.measure(1, null, true, { system: tok(100), history: [], user: tok(5), hint: null });
  // t2: H = a1(40) ; U 10 ; D 20 (n1)          total 170, share 20/170, dyn 20/70
  tr.measure(2, "n1", false, { system: tok(100), history: [{ role: "assistant", text: tok(40) }], user: tok(10), hint: tok(20) });
  // t3: H = a1 40 + u2 10 + a2 60 (under n1) = 110, echo 60 ; U 10 ; D 0     total 220
  tr.measure(3, null, false, { system: tok(100), history: [{ role: "assistant", text: tok(40) }, { role: "user", text: tok(10) }, { role: "assistant", text: tok(60), noteId: "n1" }], user: tok(10), hint: null });
  // t4: H = 110 + u3 10 + a3 50 = 170, echo 60 ; U 30 ; D 30 (n2)   total 330, share 30/330
  const r4 = tr.measure(4, "n2", false, { system: tok(100), history: [{ role: "assistant", text: tok(40) }, { role: "user", text: tok(10) }, { role: "assistant", text: tok(60), noteId: "n1" }, { role: "user", text: tok(10) }, { role: "assistant", text: tok(50) }], user: tok(30), hint: tok(30) });
  assert.deepEqual([r4.history, r4.history_echo, r4.total], [170, 60, 330]);
  const s = tr.summary({ shadow_notes: 1, blocked_notes: 2 });
  // ΣD = 50, Σtotal = 105 + 170 + 220 + 330 = 825, Σ(total - S) = 425, ΣE = 60 + 60 = 120, ΣH = 0 + 40 + 110 + 170 = 320
  assert.deepEqual(s, {
    type: "session_share", turns: 4, notes: 2, shadow_notes: 1, blocked_notes: 2, injection_rate: 0.5,
    session_share: 50 / 825, session_dynamic_share: 50 / 425, mean_turn_share: (20 / 170 + 30 / 330) / 2, max_turn_share: 20 / 170, echo_share: 120 / 320,
  });
  assert.equal(tr.rows[0]!.note_id, null);
});

test("no notes: share 0, mean / max null; a note id without a hint block is not counted", () => {
  const tr = new ContextShareTracker(fake);
  const r = tr.measure(1, "n9", false, { system: tok(10), history: [], user: tok(2), hint: null });
  assert.equal(r.note_id, null);
  const s = tr.summary({ shadow_notes: 0, blocked_notes: 0 });
  assert.deepEqual([s.notes, s.session_share, s.mean_turn_share, s.max_turn_share, s.echo_share, s.injection_rate], [0, 0, null, null, 0, 0]);
});

test("hand-worked 3-request session with real o200k_base counts (python tiktoken: S 9, cue 3, a1 8, u2 5, a2 25, u3 6, D 58)", () => {
  const tr = new ContextShareTracker(loadO200k());
  const system = "You are a warm, friendly chat partner.";
  const a1 = "Hi! What's on your mind today?", u2 = "tell me about rye bread";
  const a2 = "Rye bread is dense and tangy. A starter schedule: feed at 8am, bake at 6pm.", u3 = "how long does it rise?";
  const hint = "\n\n" + renderActorText({ id: "n1", rationale: "r", suggestion: { move: "give_example", text: "give one concrete example of a rye starter schedule" }, value: "v", evidence: ["e3", "a1.p1"], confidence: 0.6, expires_after_turns: 1 });
  const r1 = tr.measure(1, null, true, { system, history: [], user: "(session start)", hint: null });
  const r2 = tr.measure(2, "n1", false, { system, history: [{ role: "assistant", text: a1 }], user: u2, hint });
  const r3 = tr.measure(3, null, false, { system, history: [{ role: "assistant", text: a1 }, { role: "user", text: u2 }, { role: "assistant", text: a2, noteId: "n1" }], user: u3, hint: null });
  assert.deepEqual([r1.system, r1.user, r1.total], [9, 3, 12]);
  assert.deepEqual([r2.history, r2.user, r2.director, r2.total], [8, 5, 58, 80]);
  assert.equal(r2.share, 58 / 80); assert.equal(r2.share, 0.725); assert.equal(r2.dynamic_share, 58 / 71);
  assert.deepEqual([r3.history, r3.history_echo, r3.user, r3.total], [38, 25, 6, 53]);
  const s = tr.summary({ shadow_notes: 0, blocked_notes: 0 });
  assert.equal(s.session_share, 0.4); // 58 / (12 + 80 + 53)
  assert.equal(s.session_dynamic_share, 58 / 118);
  assert.equal(s.echo_share, 25 / 46);
  assert.equal(s.injection_rate, 1 / 3);
  assert.equal(s.mean_turn_share, 0.725); assert.equal(s.max_turn_share, 0.725);
});
