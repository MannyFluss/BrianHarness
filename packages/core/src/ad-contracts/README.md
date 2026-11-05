# Actor/Director shared contracts

**Version: contract-v1.2** (additive over contract-v1 and v1.1; see Changes) · **Frozen: 2026-11-04** · schema tag `bh-ad/1` · owner: Harness Engineer

Branch `actor-director` (from release-p4 `a7e49fd`), folder `packages/core/src/ad-contracts/`, published copy at
`/workspace/actor-director/contracts/`. Import in TS from `@brianharness/core/ad-contracts` (subpath export, added in E1; nothing is re-exported from the core index, so protocol-4 is untouched), or use the JSON Schemas.

## Changes

### contract-v1.0.1 (2026-11-04, patch; no field semantics change; included in contract-v1.1)
1. `gaze-plugin.schema.json`: `StatusResult` (what `getStatus()` resolves to) is now `GazeStatus` itself, matching
   `gaze-plugin.ts` (`getStatus(): Promise<GazeStatus>`), which IOS Dev built to. The old schema wrongly wrapped it
   as `{status}`. The `{status}` wrapper that `stop()`, `pause()` and `resume()` return is `StopPauseResumeResult`.
2. README / examples only: the example iPad is the confirmed 11-inch iPad Pro, `iPad13,4` (1194 x 834 pt landscape).
3. README only: the unsealing sentence now states the Researcher's ruling (see Resolved with Researcher, 3).

### contract-v1.1 (2026-11-04, additive; every contract-v1 line still validates)
1. `blinding.json` + `blinding.ts`: the ONE shared blinding list (arm-key patterns = protocol 4's `ARM_KEYS` exactly,
   TAB-ONLY fields, sealed-only types, sealed-only health codes, the `.sealed` suffix). `tools/phaseD/check_blinding.mjs`
   reads the same file, so the client guard and the checker can't drift. Exports: `ARM_KEY_PATTERNS`, `armKeyRegExp()`,
   `BLINDED_GUARD_CODES`, `blindedGuard()`, `blindedMainLineViolation()`, `findArmKey()`, `SEALED_ONLY_HEALTH_CODES`.
2. Health code `upload.blinded_guard` (check `upload`): the client guard refused an upload; `detail` is the guard code
   only (never an event type or arm).
3. `session_start.contract` accepts `"contract-v1"` or `"contract-v1.1"` (new logs write v1.1).
4. Optional prompt-slot ids (DirectorBot decision, Nov 4): `session_start.director_format_id` (`fmt1-<sha8>` over
   `DIRECTOR_OUTPUT_FORMAT_TEXT`), `director_examples_id` (`dex1-<sha8>` over the examples slot),
   `director_assembled_sha8` (sha256[:8] of the assembled Director system message). `director_prompt_id` stays
   `dir1-b1d2fd77` over R3's `system_prompt_v1.txt` only.
5. Optional `director_call.assembled_prompt_sha8` and `director_call.input_tokens_by_slot {system, format, examples,
   digest}` (o200k_base; the four add up to `input_tokens`).

### contract-v1.2 (2026-11-04, additive; every contract-v1 / v1.1 line still validates)
1. New event `leak_judge` (**sealed-only**; added to `SEALED_ONLY_TYPES` and `blinding.json` `sealedOnlyTypes`): the
   pre-display leak gate on the as-if-injected Actor reply of every rail-passing note, in every arm with the same
   deadline: `{turn, note_id, decision inject|shadow, judge_prompt_id "lj1-<sha8>", model, deadline_ms, ms,
   status ok|timeout|error|unparseable, regex, uncertain, judge (null unless ok), codes, answered_first,
   verdict pass|flagged|uncertain, dropped, reply_sha256, error?}`. The as-if-injected reply text itself is never
   logged unless it is the displayed reply.
2. `note_dropped.reason` gains `"leak_judge"`: any verdict but `pass` drops the note (fail safe).
3. `session_start.contract` accepts `"contract-v1.2"` too (new logs write v1.2).
4. Semantics (no field change): a flagged or uncertain gate verdict counts toward the leak breaker in every arm; a
   dropped note gets no `note_outcome` and reads `blocked` in the Director footprint.
5. Gaze plugin API (IOS Dev I4 feedback): optional `GazeTracker.lookAt?(x, y)`, simulator/synthetic only, absent or a
   no-op on device. Detect with `typeof tracker.lookAt === "function"`. No schema or event change; native trackers
   need no change.
6. New event `tab_occluded {turn, msg, t0, t1, ms}` (tab_visible; **sealed-only** in a blinded session, which has no
   tab; added to `SEALED_ONLY_TYPES` and `blinding.json`). Phone behaviour (IOS Dev I4): while the Director sheet
   covers the chat, gaze is not attributed to paragraphs and that time is excluded from per-paragraph reading
   features; a paragraph that was only ever covered is left out of the digest rather than labelled `skipped`.

## Change policy

- contract-v1 is frozen. **Any** change to a type, a JSON Schema, an enum, a constant listed here, or the actor_text
  byte rule bumps the version (contract-v2, ...). The change is announced to DirectorBot, IOS Dev, the Harness Researcher
  and InfrastructureBot **before** it merges, with a migration note.
- Fixes to comments or README wording that change no field, value or rule don't bump the version.
- `node schemas/build-schemas.mjs` is the source of the `*.schema.json` files, and `npx tsx scripts/ad-contracts-sync.ts`
  writes `examples/*.json` (`--publish` refreshes `/workspace/actor-director/contracts/`).
  `packages/core/test/ad-contracts.test.ts` fails if a schema, an example, this README's examples or a TS enum drifts.

## Files

| Contract | TypeScript | JSON Schema (draft-07) |
|---|---|---|
| GazeSample | `gaze.ts` | `schemas/gaze-sample.schema.json` |
| Gaze plugin API | `gaze-plugin.ts` | `schemas/gaze-plugin.schema.json` (every argument, result and event, plus the replay file) |
| Note schema (Director output, rails, leaks, actor_text rule) | `note.ts` | `schemas/note.schema.json` |
| bh-ad/1 log events | `events.ts`, `health.ts` | `schemas/bh-ad-events.schema.json` (one line; dispatches on `type`) |
| Worker (X-BH-Role, upload envelope, errors) | `worker.ts` | `schemas/worker.schema.json` |

All objects are closed (`additionalProperties: false`), so an extra field fails validation. That's how
"numbers only, never images" is enforced on the gaze side.

## Size budget: 1 MiB per upload

`POST /v1/ad-sessions` takes the **whole request body (envelope + jsonl) ≤ 1,048,576 bytes**; above that the Worker
answers 413 `ad_log_too_large`. InfrastructureBot measured a synthetic 20-minute session at about 827 KB. The contracts
test builds a worst case at the caps below (20 minutes, every gaze_l1 batch full, 20 full turns) at about 989 KB (94%).
- Fixations are logged at no more than about 4 Hz: `gaze_l1` batches cover ≤ 5 s with ≤ 20 fixations, ≤ 10 back/jump
  saccades (forward saccades are implied by consecutive fixations) and ≤ 10 gaps. Above 20 fixations, adjacent
  fixations on the same AOI are merged first.
- Raw `GazeSample`s are **off by default**. `gaze_raw` lines exist only when `session_start.consent.rawGaze` is true
  (local research sessions), and such a log is local-only and never uploaded.
- If a log would still exceed the limit, the client drops the oldest `gaze_l1` lines first. L2 and above, the chat
  and all Director events are kept, and a `health` line {check "upload", code "upload.too_large", detail "dropped N
  gaze_l1 lines"} records the drop.

## 1. GazeSample

One gaze estimate from an on-device tracker (ARKit on iOS, MediaPipe on the Mac, or synthetic/replay):
`{t, x, y, conf, face, blink, lids?, head?, cal, src}`.
- `t`: ms on the web layer's monotonic clock (`performance.now()`). Native trackers anchor it with `start({webNow})`
  and `syncClock()`.
- `x, y`: **screen points**. Origin is the top-left of the screen in the current interface orientation, +x right,
  +y down, not clamped (off-screen gaze falls outside the screen). They're null when there's no estimate, and then
  `conf` is 0. Convert to webview CSS px with `ScreenInfo.webview`.
- `conf`: 0..1. `face`: face present. `blink`: both eyes closed (ARKit eyeBlink > 0.5 / MediaPipe EAR threshold).
  `lids`: optional per-eye closure. `head`: yaw, pitch and roll in degrees, plus `distCm`, only with a face.
- `cal` says whether a calibration has been applied. `src` is `arkit | mediapipe | synthetic | replay`.
- Rates: 30 Hz normal, 15 Hz hot (thermalState serious or critical).

<!-- example: gaze-sample -->
```json
{
  "t": 81234.5,
  "x": 212.4,
  "y": 388.9,
  "conf": 0.94,
  "face": true,
  "blink": false,
  "lids": {
    "l": 0.08,
    "r": 0.11
  },
  "head": {
    "yaw": -4.2,
    "pitch": 6.1,
    "roll": 1.3,
    "distCm": 34.5
  },
  "cal": false,
  "src": "arkit"
}
```
<!-- example: gaze-sample-no-face -->
```json
{
  "t": 81267.8,
  "x": null,
  "y": null,
  "conf": 0,
  "face": false,
  "blink": false,
  "cal": false,
  "src": "arkit"
}
```

## 2. Gaze plugin API

`GazeTracker` is implemented by the iOS Capacitor plugin (jsName `BHGaze`, `BHGazePlugin.swift`) and by the Mac
MediaPipe tracker (Electron Web Worker). The methods are `getStatus`, `requestPermission`, `getScreenInfo`,
`start({mode: camera|synthetic, synthetic?, webNow, maxHz?})`, `stop`, `pause`/`resume` (the tab's one-tap pause),
`calibrate({phase: begin|target|end|cancel})`, `restoreCalibration`, `syncClock`, and the events `gaze` (a batch of
samples about every 100 ms) and `status`. v1.2: optional `lookAt?(x, y)` is a **simulator-only aid** (the synthetic
tracker's simulated gaze point, called by the calibration screens). Device trackers omit it or make it a no-op;
detect it with `typeof tracker.lookAt === "function"` (not `"lookAt" in tracker`: the Capacitor proxy answers `in`
for any name).
- Permission states: `prompt | granted | denied | restricted`. An unsupported device has `supported:false` with
  `gaze.arkit_unsupported` or `gaze.model_missing`.
- Tracker states: `idle | starting | running | calibrating | paused | stopped | error`. Pause reasons:
  `background | user | interrupted | permission_revoked`. The tracker pauses in the background by itself and resumes
  in the foreground. Only `user` needs `resume()`.
- Synthetic mode replays a `bh-gaze-replay/1` file (a bundle-relative path or inline samples) through the same `gaze`
  event path, with t rebased to the live clock, for the Simulator, the sim and the replay CLI.
- Every result and event is numbers, booleans and short enums: no image, frame, pixel buffer, mesh or path to one.

<!-- example: plugin-start-options -->
```json
{
  "mode": "synthetic",
  "synthetic": {
    "file": "gaze-replays/ipadpro-m1-landscape-01.json",
    "loop": true,
    "speed": 1
  },
  "webNow": 80012.25,
  "maxHz": 30
}
```
<!-- example: plugin-start-result -->
```json
{
  "status": {
    "supported": true,
    "unsupportedCode": null,
    "permission": "granted",
    "state": "running",
    "pauseReason": null,
    "tracker": "arkit",
    "mode": "synthetic",
    "hz": 30,
    "code": null
  },
  "screen": {
    "deviceModel": "iPad13,4",
    "platform": "ios",
    "orientation": "landscape_right",
    "widthPt": 1194,
    "heightPt": 834,
    "scale": 2,
    "webview": {
      "x": 0,
      "y": 0,
      "width": 1194,
      "height": 834
    },
    "widthMm": 230
  }
}
```
<!-- example: plugin-status-paused -->
```json
{
  "supported": true,
  "unsupportedCode": null,
  "permission": "granted",
  "state": "paused",
  "pauseReason": "background",
  "tracker": "arkit",
  "mode": "camera",
  "hz": null,
  "code": null
}
```
<!-- example: plugin-calibrate-begin -->
```json
{
  "phase": "begin",
  "orientation": "landscape_right",
  "targets": [
    {
      "id": "c1",
      "x": 80,
      "y": 80
    },
    {
      "id": "c2",
      "x": 597,
      "y": 80
    },
    {
      "id": "c3",
      "x": 1114,
      "y": 80
    },
    {
      "id": "c4",
      "x": 80,
      "y": 417
    },
    {
      "id": "c5",
      "x": 597,
      "y": 417
    },
    {
      "id": "c6",
      "x": 1114,
      "y": 417
    },
    {
      "id": "c7",
      "x": 80,
      "y": 754
    },
    {
      "id": "c8",
      "x": 597,
      "y": 754
    },
    {
      "id": "c9",
      "x": 1114,
      "y": 754
    }
  ]
}
```
<!-- example: plugin-calibrate-end -->
```json
{
  "phase": "end",
  "ok": true,
  "fit": "core",
  "model": null,
  "samples": 412,
  "code": null
}
```
<!-- example: plugin-gaze-event -->
```json
{
  "seq": 1207,
  "hz": 30,
  "samples": [
    {
      "t": 81234.5,
      "x": 212.4,
      "y": 388.9,
      "conf": 0.94,
      "face": true,
      "blink": false,
      "lids": {
        "l": 0.08,
        "r": 0.11
      },
      "head": {
        "yaw": -4.2,
        "pitch": 6.1,
        "roll": 1.3,
        "distCm": 34.5
      },
      "cal": false,
      "src": "arkit"
    },
    {
      "t": 81267.8,
      "x": 214,
      "y": 390.2,
      "conf": 0.93,
      "face": true,
      "blink": false,
      "lids": {
        "l": 0.08,
        "r": 0.11
      },
      "head": {
        "yaw": -4.2,
        "pitch": 6.1,
        "roll": 1.3,
        "distCm": 34.5
      },
      "cal": false,
      "src": "arkit"
    },
    {
      "t": 81301.2,
      "x": 215.1,
      "y": 389.7,
      "conf": 0.6,
      "face": true,
      "blink": true,
      "lids": {
        "l": 0.08,
        "r": 0.11
      },
      "head": {
        "yaw": -4.2,
        "pitch": 6.1,
        "roll": 1.3,
        "distCm": 34.5
      },
      "cal": false,
      "src": "arkit"
    }
  ]
}
```
<!-- example: gaze-replay-file -->
```json
{
  "schema": "bh-gaze-replay/1",
  "layout": "ipadpro-m1-landscape",
  "src": "synthetic",
  "hz": 30,
  "screen": {
    "deviceModel": "iPad13,4",
    "platform": "ios",
    "orientation": "landscape_right",
    "widthPt": 1194,
    "heightPt": 834,
    "scale": 2,
    "webview": {
      "x": 0,
      "y": 0,
      "width": 1194,
      "height": 834
    },
    "widthMm": 230
  },
  "samples": [
    {
      "t": 0,
      "x": 402,
      "y": 210,
      "conf": 0.9,
      "face": true,
      "blink": false,
      "head": {
        "yaw": 18,
        "pitch": 2,
        "roll": 0,
        "distCm": 45
      },
      "cal": true,
      "src": "synthetic"
    },
    {
      "t": 33.3,
      "x": 405,
      "y": 211,
      "conf": 0.9,
      "face": true,
      "blink": false,
      "head": {
        "yaw": 18,
        "pitch": 2,
        "roll": 0,
        "distCm": 45
      },
      "cal": true,
      "src": "synthetic"
    }
  ]
}
```

## 3. Note schema

The Director returns strict JSON `DirectorOutput {context_update, intent, note | null, no_note_reason}`, where
`note === null` ⇔ `no_note_reason` is a non-empty string. A `DirectorNote` is `{id "n<k>", rationale (tab and log
only, never sent to the Actor), observation?, suggestion? {move, target?, text}, value, evidence ≥ 1, confidence 0..1,
expires_after_turns: 1}`, with at least one of observation or suggestion. Moves: `go_deeper | broaden | return_to |
clarify | simplify | give_example | check_in | slow_down | other`.

**actor_text is code-built** (`renderActorText`), and the model never writes it:
```
[Context for your next reply. Soft hints: answer the person first, use only what fits.
Don't quote this or say where it came from.]
- {observation}
- If it fits after answering them: {suggestion.text}. (h:{all evidence ids, in order})
```
It's appended to the Actor's leading system message after `"\n\n"`. The length cap is ≤ 60 words of the lines,
counting the lead-in and excluding the bullets and the tag.

**Safety rejection (rail) codes**, in `rail_check.blocked_by`: `kill_switch, consent, data_validity, evidence_missing,
evidence_unknown, schema_invalid, lint_sensor, lint_provenance, lint_answer_first, length_cap, duplicate, leak_breaker`.

**Leak codes**, in `note_outcome.leaks`: `sensor, provenance, mind_reading` are safety leaks (they count toward the
leak breaker: 1 = flagged, 2 = injection paused for the session). `pivot_first, verbatim, forced_move` are quality
failures that the eval measures.

**Prompt-embeddable form.** Ollama Cloud ignores a JSON-schema `format`, so `DIRECTOR_OUTPUT_FORMAT_TEXT` (note.ts)
is the compact text the Director prompt embeds. E3 strips code fences, validates against `note.schema.json`, and
retries once with the errors. A second failure means no note (`director.schema_invalid`).

<!-- example: director-output-note -->
```json
{
  "context_update": {
    "summary": "Manny is planning his first rye sourdough. He engages most with the why of fermentation; recipe numbers get skimmed.",
    "hypotheses": [
      {
        "label": "fermentation science",
        "conf": 0.7,
        "evidence": [
          "e31",
          "e19"
        ]
      },
      {
        "label": "oven hardware",
        "conf": 0.4,
        "evidence": [
          "e33"
        ]
      }
    ],
    "changed": [
      "raised fermentation science 0.55 -> 0.70"
    ]
  },
  "intent": "See whether the fermentation thread keeps holding when the Actor goes deeper.",
  "note": {
    "id": "n5",
    "rationale": "Deep read + 2 rereads on the rye-fermentation paragraph (e31), look-back to oven hot spots (e33); hydration skimmed (e32).",
    "observation": "They seem most drawn to why rye ferments faster; the hydration numbers landed flat.",
    "suggestion": {
      "move": "go_deeper",
      "target": "why rye ferments faster",
      "text": "go deeper on why rye ferments faster, and skip more ratios"
    },
    "value": "Two turns of signal agree; a generic next reply would likely repeat ratios he skimmed.",
    "evidence": [
      "e31",
      "e32",
      "e33"
    ],
    "confidence": 0.78,
    "expires_after_turns": 1
  },
  "no_note_reason": null
}
```
<!-- example: director-output-no-note -->
```json
{
  "context_update": {
    "summary": "Manny asked for a weekday bake schedule; he is reading everything at his usual pace.",
    "hypotheses": [
      {
        "label": "fermentation science",
        "conf": 0.66,
        "evidence": [
          "e31"
        ]
      }
    ],
    "changed": []
  },
  "intent": "Let the schedule question play out before steering.",
  "note": null,
  "no_note_reason": "He asked a concrete scheduling question; the Actor should just answer it, and nothing new stands out."
}
```

## 4. bh-ad/1 log events

Every line has `{schema "bh-ad/1", type, t ISO, mono ms (GazeSample clock), sessionId, seq}`. Turn 0 is the opener.
`aT` is the Actor message of turn T, and `uT` is the user message answering it. Director-side events carry the turn
of the Actor request they affect. Types: `session_start, gaze_quality, aoi_layout, scroll, gaze_l1, gaze_raw (off by
default), tab_occluded (v1.2), aoi_dwell, attention_digest, user_turn, director_call (with the director footprint), rail_check, injection,
note_dropped, leak_judge (v1.2), context_share, actor_turn, note_outcome, session_share, health, session_end`.

**Context share** (`context_share` per Actor request, `session_share` at the end) uses o200k_base token counts of
each segment's content: `system` S, `history` H, `history_echo` E, `user` U, `director` D (the hint block including
the header and the "\n\n" separator; 0 without a note). `total = S+H+U+D`, `share = D/total`, `dynamic_share =
D/(H+U+D)`. `provider_prompt_tokens` is logged to reconcile the chat-template overhead.

**Health codes**: `gaze.camera_denied, gaze.arkit_unsupported, gaze.model_missing, gaze.calibration_stale,
gaze.thermal_degraded, gaze.tracker_interrupted, gaze.low_quality, gaze.no_consent, net.worker_unreachable,
auth.no_token, model.route_unverified, model.empty_completion, model.length_cutoff, budget.director_cap,
budget.actor_cap, budget.judge_cap, budget.daily_cap_device, budget.daily_cap_global, upload.too_large,
upload.rejected, upload.cap, director.schema_invalid, director.timeout, director.kill_switch, director.leak_breaker`.
A role-cap hit (429 `role_cap_<role>`) is logged as `health {check "budget", ok false, code budget.<role>_cap,
http_status 429, worker_code "role_cap_<role>", role}` (`WORKER_CAP_TO_HEALTH`).

### Session types, and the fields that never appear in a blinded main log

| | `tab_visible` (legibility/dogfood, excluded from the A/B) | `blinded` (on/off A/B) |
|---|---|---|
| `session_start.session_type` / `tab` | `tab_visible` / `visible` | `blinded` / `hidden` |
| `session_start.arm`, `p_inject` | present | **TAB-ONLY**: sealed log only |
| `session_start.sealed`, `blind {index,total,scheduleHash}` | absent | present |
| `actor_turn.note_id`, `actor_request_sha256` | present | **TAB-ONLY**: sealed log only; main has `sealed:true` |
| `actor_turn.usage.prompt_tokens` | number or null | **null** in the main log |
| `director_call, rail_check, injection, note_dropped, leak_judge, tab_occluded, context_share, note_outcome, session_share` | written | **sealed log only** |
| `health` with `director.leak_breaker` | written | sealed log only |

The Director runs and the 1.5 s hold applies in every arm of a blinded session, so timing and request counts match.
From v1.2 the same holds for the leak gate: every rail-passing note gets both Actor requests and the judge, with one
deadline, whatever the arm.
The sealed log is the full record, the same shape as a tab_visible log. It's stored in the sealed namespace, never
shown in the app, and uploaded as its own envelope with `sessionId + ".sealed"`. The field lists are in
`TAB_ONLY_FIELDS` and `SEALED_ONLY_TYPES` (events.ts).

<!-- example: event-session-start-tab-visible -->
```json
{
  "schema": "bh-ad/1",
  "t": "2026-11-04T23:10:00.000Z",
  "mono": 0,
  "sessionId": "ad-2026-11-04-7f3a",
  "seq": 0,
  "type": "session_start",
  "profile": "actor-director",
  "contract": "contract-v1.2",
  "userId": "manny",
  "actor_prompt_id": "ap1-3c9e1b07",
  "director_prompt_id": "dir1-b1d2fd77",
  "pipeline_version": "gp1.0.0",
  "tokenizer": "o200k_base",
  "models": {
    "actor": "gpt-oss:20b-cloud",
    "director": "gpt-oss:120b-cloud"
  },
  "consent": {
    "camera": true,
    "rawGaze": false
  },
  "gaze": {
    "tracker": "arkit",
    "permission": "granted"
  },
  "device": {
    "deviceModel": "iPhone18,1",
    "platform": "ios",
    "orientation": "portrait",
    "widthPt": 402,
    "heightPt": 874
  },
  "director_enabled": true,
  "session_type": "tab_visible",
  "tab": "visible",
  "arm": "on",
  "p_inject": 0.5
}
```
<!-- example: event-session-start-blinded-main -->
```json
{
  "schema": "bh-ad/1",
  "t": "2026-11-04T23:10:00.000Z",
  "mono": 0,
  "sessionId": "ad-2026-11-04-7f3a",
  "seq": 0,
  "type": "session_start",
  "profile": "actor-director",
  "contract": "contract-v1.2",
  "userId": "manny",
  "actor_prompt_id": "ap1-3c9e1b07",
  "director_prompt_id": "dir1-b1d2fd77",
  "pipeline_version": "gp1.0.0",
  "tokenizer": "o200k_base",
  "models": {
    "actor": "gpt-oss:20b-cloud",
    "director": "gpt-oss:120b-cloud"
  },
  "consent": {
    "camera": true,
    "rawGaze": false
  },
  "gaze": {
    "tracker": "arkit",
    "permission": "granted"
  },
  "device": {
    "deviceModel": "iPhone18,1",
    "platform": "ios",
    "orientation": "portrait",
    "widthPt": 402,
    "heightPt": 874
  },
  "director_enabled": true,
  "session_type": "blinded",
  "tab": "hidden",
  "sealed": true,
  "blind": {
    "index": 3,
    "total": 10,
    "scheduleHash": "9f2c4e1a7b3d5c6e8f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e"
  }
}
```
<!-- example: event-session-start-blinded-sealed -->
```json
{
  "schema": "bh-ad/1",
  "t": "2026-11-04T23:10:00.000Z",
  "mono": 0,
  "sessionId": "ad-2026-11-04-7f3a",
  "seq": 0,
  "type": "session_start",
  "profile": "actor-director",
  "contract": "contract-v1.2",
  "userId": "manny",
  "actor_prompt_id": "ap1-3c9e1b07",
  "director_prompt_id": "dir1-b1d2fd77",
  "pipeline_version": "gp1.0.0",
  "tokenizer": "o200k_base",
  "models": {
    "actor": "gpt-oss:20b-cloud",
    "director": "gpt-oss:120b-cloud"
  },
  "consent": {
    "camera": true,
    "rawGaze": false
  },
  "gaze": {
    "tracker": "arkit",
    "permission": "granted"
  },
  "device": {
    "deviceModel": "iPhone18,1",
    "platform": "ios",
    "orientation": "portrait",
    "widthPt": 402,
    "heightPt": 874
  },
  "director_enabled": true,
  "session_type": "blinded",
  "tab": "hidden",
  "sealed": true,
  "blind": {
    "index": 3,
    "total": 10,
    "scheduleHash": "9f2c4e1a7b3d5c6e8f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e"
  },
  "arm": "off",
  "p_inject": 0
}
```
<!-- example: event-director-call -->
```json
{
  "schema": "bh-ad/1",
  "t": "2026-11-04T23:16:53.510Z",
  "mono": 413510,
  "sessionId": "ad-2026-11-04-7f3a",
  "seq": 108,
  "type": "director_call",
  "turn": 12,
  "msg": "a11",
  "input_sha256": "4b1d6e0f9a8c7b2e3d4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
  "input_tokens": 2910,
  "model": "mock:director",
  "genMs": 3820,
  "usage": {
    "prompt_tokens": null,
    "completion_tokens": null,
    "reasoning_tokens": null
  },
  "footprint": {
    "actor_turns": 11,
    "notes_injected": 4,
    "notes_shadowed": 3,
    "notes_blocked": 1,
    "session_share": 0.016,
    "session_dynamic_share": 0.021,
    "recent": [
      {
        "note_id": "n4",
        "turn": 9,
        "kind": "suggestion",
        "move": "go_deeper",
        "decision": "inject",
        "followed": true,
        "next_dwell_ratio": 1.3
      }
    ]
  },
  "repaired": false,
  "deadline_missed": false,
  "output": {
    "context_update": {
      "summary": "Manny is planning his first rye sourdough. He engages most with the why of fermentation; recipe numbers get skimmed.",
      "hypotheses": [
        {
          "label": "fermentation science",
          "conf": 0.7,
          "evidence": [
            "e31",
            "e19"
          ]
        },
        {
          "label": "oven hardware",
          "conf": 0.4,
          "evidence": [
            "e33"
          ]
        }
      ],
      "changed": [
        "raised fermentation science 0.55 -> 0.70"
      ]
    },
    "intent": "See whether the fermentation thread keeps holding when the Actor goes deeper.",
    "note": {
      "id": "n5",
      "rationale": "Deep read + 2 rereads on the rye-fermentation paragraph (e31), look-back to oven hot spots (e33); hydration skimmed (e32).",
      "observation": "They seem most drawn to why rye ferments faster; the hydration numbers landed flat.",
      "suggestion": {
        "move": "go_deeper",
        "target": "why rye ferments faster",
        "text": "go deeper on why rye ferments faster, and skip more ratios"
      },
      "value": "Two turns of signal agree; a generic next reply would likely repeat ratios he skimmed.",
      "evidence": [
        "e31",
        "e32",
        "e33"
      ],
      "confidence": 0.78,
      "expires_after_turns": 1
    },
    "no_note_reason": null
  }
}
```
<!-- example: event-injection -->
```json
{
  "schema": "bh-ad/1",
  "t": "2026-11-04T23:16:53.513Z",
  "mono": 413513,
  "sessionId": "ad-2026-11-04-7f3a",
  "seq": 110,
  "type": "injection",
  "turn": 12,
  "note_id": "n5",
  "decision": "inject",
  "kind": "both",
  "move": "go_deeper",
  "actor_text": "[Context for your next reply. Soft hints: answer the person first, use only what fits.\nDon't quote this or say where it came from.]\n- They seem most drawn to why rye ferments faster; the hydration numbers landed flat.\n- If it fits after answering them: go deeper on why rye ferments faster, and skip more ratios. (h:e31,e32,e33)",
  "evidence": [
    "e31",
    "e32",
    "e33"
  ],
  "trigger_features": {
    "e31.z": 2.6,
    "e32.z": -1.9,
    "e33.ms": 3100
  },
  "confidence": 0.78
}
```
<!-- example: event-leak-judge -->
```json
{
  "schema": "bh-ad/1",
  "t": "2026-11-04T23:17:01.410Z",
  "mono": 421410,
  "sessionId": "ad-2026-11-04-7f3a",
  "seq": 111,
  "type": "leak_judge",
  "turn": 12,
  "note_id": "n5",
  "decision": "inject",
  "judge_prompt_id": "lj1-11631f45",
  "model": "gemma4:cloud",
  "deadline_ms": 2500,
  "ms": 912,
  "status": "ok",
  "regex": [],
  "uncertain": [],
  "judge": [],
  "codes": [],
  "answered_first": true,
  "verdict": "pass",
  "dropped": false,
  "reply_sha256": "5d1c2b3a4f5e6d7c8b9a0f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6b7a8f9e0d1c"
}
```
<!-- example: event-leak-judge-timeout -->
```json
{
  "schema": "bh-ad/1",
  "t": "2026-11-04T23:17:01.410Z",
  "mono": 421410,
  "sessionId": "ad-2026-11-04-7f3a",
  "seq": 111,
  "type": "leak_judge",
  "turn": 13,
  "note_id": "n7",
  "decision": "shadow",
  "judge_prompt_id": "lj1-11631f45",
  "model": "gemma4:cloud",
  "deadline_ms": 2500,
  "ms": 2500,
  "status": "timeout",
  "regex": [],
  "uncertain": [],
  "judge": null,
  "codes": [],
  "answered_first": null,
  "verdict": "uncertain",
  "dropped": true,
  "reply_sha256": "6e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6d7c8b9a0f1e2d"
}
```
<!-- example: event-context-share -->
```json
{
  "schema": "bh-ad/1",
  "t": "2026-11-04T23:16:53.520Z",
  "mono": 413520,
  "sessionId": "ad-2026-11-04-7f3a",
  "seq": 111,
  "type": "context_share",
  "turn": 12,
  "note_id": "n5",
  "opener": false,
  "system": 230,
  "history": 1420,
  "history_echo": 310,
  "user": 60,
  "director": 41,
  "total": 1751,
  "share": 0.023415191319246145,
  "dynamic_share": 0.02695595003287311,
  "provider_prompt_tokens": 1788
}
```
<!-- example: event-actor-turn-blinded-main -->
```json
{
  "schema": "bh-ad/1",
  "t": "2026-11-04T23:17:01.400Z",
  "mono": 421400,
  "sessionId": "ad-2026-11-04-7f3a",
  "seq": 112,
  "type": "actor_turn",
  "turn": 12,
  "msg": "a12",
  "text": "Give it 4 to 6 hours at room temperature, until it's domed and bubbly...",
  "model": "gpt-oss:20b-cloud",
  "genMs": 7880,
  "firstTokenMs": 640,
  "usage": {
    "prompt_tokens": null,
    "completion_tokens": 212,
    "reasoning_tokens": 64
  },
  "finish_reason": "stop",
  "opener_cue": false,
  "sealed": true
}
```
<!-- example: event-session-share -->
```json
{
  "schema": "bh-ad/1",
  "t": "2026-11-04T23:30:00.000Z",
  "mono": 1200000,
  "sessionId": "ad-2026-11-04-7f3a",
  "seq": 400,
  "type": "session_share",
  "turns": 21,
  "notes": 6,
  "shadow_notes": 5,
  "blocked_notes": 1,
  "injection_rate": 0.2857142857142857,
  "session_share": 0.0158,
  "session_dynamic_share": 0.0209,
  "mean_turn_share": 0.0231,
  "max_turn_share": 0.0312,
  "echo_share": 0.091
}
```
<!-- example: event-health -->
```json
{
  "schema": "bh-ad/1",
  "t": "2026-11-04T23:10:01.200Z",
  "mono": 1200,
  "sessionId": "ad-2026-11-04-7f3a",
  "seq": 5,
  "type": "health",
  "check": "budget",
  "ok": false,
  "code": "budget.director_cap",
  "detail": "Director paused: daily cap reached; chat continues without notes",
  "http_status": 429,
  "worker_code": "role_cap_director",
  "role": "director"
}
```

Every other event type has an example in `examples/event-*.json`, and all of them are validated by the test.

## 5. Worker contract (adopted from InfrastructureBot's Worker branch `actor-director` @ 9bc90f1, not deployed)

- Every chat request sends **`X-BH-Role: actor | director | judge`**. A missing header counts as actor, and anything
  else gets 400 `invalid_role`. The per-device daily caps are actor 200, director 100 and judge 100, counted inside the
  device cap. A cap hit returns **429 `role_cap_<role>`** with `{limit, used, reset_at, role, scope:"role"}` and a
  `retry-after` header.
- `POST /v1/ad-sessions` takes the envelope `{schema "bh-ad/1", sessionId, appVersion, platform, build?, jsonl}`. The
  server checks only the envelope, that each line is a JSON object, and the secret scan. It stores the log opaquely
  and answers 201 `{id, kind "ad_session", schema, received_at, bytes, lines, sha256}`. Errors: 413
  `ad_log_too_large`, 400 `invalid_json | invalid_ad_upload | invalid_jsonl`, 422 `upload_rejected`, 409
  `session_exists`, 429 `upload_cap_device | upload_cap_global`.

<!-- example: upload-envelope -->
```json
{
  "schema": "bh-ad/1",
  "sessionId": "ad-2026-11-04-7f3a",
  "appVersion": "0.1.0",
  "platform": "ios",
  "build": "20261105.0900",
  "jsonl": "{\"schema\":\"bh-ad/1\",\"t\":\"2026-11-04T23:10:00.000Z\",\"mono\":0,\"sessionId\":\"ad-2026-11-04-7f3a\",\"seq\":0,\"type\":\"session_start\",\"profile\":\"actor-director\",\"contract\":\"contract-v1.2\",\"userId\":\"manny\",\"actor_prompt_id\":\"ap1-3c9e1b07\",\"director_prompt_id\":\"dir1-b1d2fd77\",\"pipeline_version\":\"gp1.0.0\",\"tokenizer\":\"o200k_base\",\"models\":{\"actor\":\"gpt-oss:20b-cloud\",\"director\":\"gpt-oss:120b-cloud\"},\"consent\":{\"camera\":true,\"rawGaze\":false},\"gaze\":{\"tracker\":\"arkit\",\"permission\":\"granted\"},\"device\":{\"deviceModel\":\"iPhone18,1\",\"platform\":\"ios\",\"orientation\":\"portrait\",\"widthPt\":402,\"heightPt\":874},\"director_enabled\":true,\"session_type\":\"tab_visible\",\"tab\":\"visible\",\"arm\":\"on\",\"p_inject\":0.5}\n{\"schema\":\"bh-ad/1\",\"t\":\"2026-11-04T23:10:01.200Z\",\"mono\":1200,\"sessionId\":\"ad-2026-11-04-7f3a\",\"seq\":5,\"type\":\"health\",\"check\":\"budget\",\"ok\":false,\"code\":\"budget.director_cap\",\"detail\":\"Director paused: daily cap reached; chat continues without notes\",\"http_status\":429,\"worker_code\":\"role_cap_director\",\"role\":\"director\"}\n{\"schema\":\"bh-ad/1\",\"t\":\"2026-11-04T23:30:00.100Z\",\"mono\":1200100,\"sessionId\":\"ad-2026-11-04-7f3a\",\"seq\":401,\"type\":\"session_end\",\"turns\":21,\"reason\":\"user\"}\n"
}
```
<!-- example: worker-role-cap-error -->
```json
{
  "error": {
    "message": "daily director request cap reached for this device (100 director requests per UTC day); resets at 2026-11-05T00:00:00.000Z",
    "type": "rate_limit_error",
    "code": "role_cap_director",
    "limit": 100,
    "used": 100,
    "reset_at": "2026-11-05T00:00:00.000Z",
    "role": "director",
    "scope": "role"
  }
}
```

## Engineer decisions (where the spec is silent or ambiguous)

1. **Screen points, uncalibrated at the tracker.** The spec's `GazeSample` comment says "CSS px in the webview
   viewport (after calibration)", while the dispatch says screen points. Trackers emit screen points, and
   `ScreenInfo.webview` converts them to CSS px (1 pt = 1 CSS px on iOS at zoom 1). The `cal` flag says whether a
   calibration has been applied.
2. **Calibration fitting lives in shared TS**, not in Swift. iOS returns `fit:"core"`: it emits raw points, and core
   L0 fits and applies the per-orientation affine. The Mac tracker returns `fit:"native"`: it applies its own ridge
   regression on iris features. Core stores calibrations per orientation in the actor-director storage. The plugin
   holds the full 30 Hz during calibration.
3. **x/y are null when there's no estimate** (no face or tracking lost), and then conf is 0. Head pose appears only
   with a face. Optional per-eye `lids` was added for R1 blink features.
4. **Clock**: the web monotonic clock. Native anchors it via `start({webNow})` and `syncClock()` (on foreground and
   every 60 s).
5. **Batched gaze events** arrive about every 100 ms (3 samples at 30 Hz), which keeps bridge calls at 10 Hz, the
   live-tier rate.
6. **Head pose signs**: yaw + toward screen right, pitch + toward screen top, roll + clockwise as the person sees it,
   all in degrees. `distCm` is measured from the screen plane.
7. **Thermal**: 15 Hz at serious *and* critical (no pause), per the spec. Background, interruption and permission
   revocation pause the tracker. Only a user pause needs `resume()`.
8. **Synthetic file paths** are bundle-relative `.json` files only (no absolute paths, no `..`), or the samples
   inline.
9. **Evidence tag renders ALL of the note's evidence ids, in the order given**, comma-separated with no ranges:
   `(h:e31,e32,e33)`. The spec's `(h:e31,e32)` example was wrong. The tag is appended to the last line, observation or
   suggestion.
10. **Header bytes**: two lines, with no leading space before "Don't". Text is trimmed and inner whitespace collapsed.
    A "." is added to the suggestion only when it doesn't already end in `. ! ?`.
11. **Length cap counting**: words in the lines, including the 6-word lead-in, excluding the bullets and the tag.
12. **Rail codes**: the sensor/provenance lint is split into `lint_sensor` and `lint_provenance`, and evidence
    validity into `evidence_missing` and `evidence_unknown`. The lint lexicon itself is E2 code, tuned on R4 dev, not
    part of the contract (whole-word matching).
13. **Turn numbering** follows the existing harness, with turn 0 as the opener. Director-side events carry the
    affected Actor request's turn, and `director_call.msg` names the message whose reading window triggered it.
14. **Events the spec lacked but replay needs**: `user_turn` (text, `hold_ms`), `aoi_layout`, `scroll`, `gaze_l1`,
    `aoi_dwell`, `note_dropped` (late, superseded, session_end, or leak_judge from v1.2), `session_end`, and `gaze_raw` (off by default).
    Added fields: `director_call.footprint/repaired/deadline_missed`, `context_share.note_id/opener`,
    `session_share.shadow_notes/blocked_notes/session_dynamic_share`, `note_outcome.decision/leak_source`,
    `health.detail/http_status/worker_code/role`.
15. **Judge-dependent outcome fields can be null** in Phase 1 (mock judge): `followed`, `answered_first`,
    `pushback`. `used` is the 0..1 fraction of the hint's content words that appear in the reply.
16. **Blinding** follows protocol 4: a sealed full log plus a redacted main log (see the table above). The Director
    runs and the hold applies in every arm. The blinded main log contains no key that `tools/phaseD/check_blinding.mjs`
    treats as an arm key.
17. **Prompt ids**: Actor `ap<k>-<8 hex>`. Director `dir<k>-<8 hex>`, which matches the Researcher's R3 proposed id
    `dir1-b1d2fd77` (= sha256 of `system_prompt_v1.txt`, checked). The Director prompt id never uses `dp` (that's
    protocol 4's chat prompt, `dp4-23e5a648`).
18. **Shares are logged unrounded** in 0..1 (not %). `mean_turn_share` and `max_turn_share` are taken over injected
    turns and are null when no note was injected.
19. **New health codes** beyond the spec: `gaze.tracker_interrupted, gaze.low_quality, gaze.no_consent,
    budget.actor_cap, budget.judge_cap, budget.daily_cap_global, upload.too_large, upload.rejected, upload.cap,
    director.timeout, director.kill_switch, director.leak_breaker`.
20. **JSON Schema draft-07**, which iOS, Python and Worker tooling all read. Ajv validates it in the test (`strict`
    on, except `strictRequired`, because closed sub-schemas use `required` to forbid fields).
21. **iOS gaze plugin choices (IOS Dev, accepted):**
    - `conf` is a heuristic from the ARKit tracking state: 0.95 normal, 0.5 limited, reduced for closed eyes,
      |head| over 30°, or a distance outside 15-90 cm. It is not a calibrated probability.
    - `start()` rejects with the health code as the error code, or `EINVAL` / `EREPLAY` for bad input.
    - A calibrate target with no face samples returns `ok:false` with `gaze.low_quality`.
    - Replayed data is always `src:"synthetic"`.
    - No bridge-delay correction in the clock anchor (v1).
    - Synthetic files resolve from `public/<file>`, then the bundle root.
    - Head-pose signs (decision 6) are unverified until a real-device check, so Phase 1 features must not depend on the
      sign of head pose.


## Resolved with Researcher (Nov 4 2026)

1. **Blinded guard: APPROVED with changes** (implemented client-side in E1; contract-v1.1).
   - Fail closed: an upload the guard can't prove clean is rejected with a code (`BLINDED_GUARD_CODES`), and the
     client writes a health line `upload.blinded_guard` (detail = the code).
   - Besides the field and type rules below, any key that `check_blinding.mjs` treats as an arm key, at any depth
     in a line, is rejected (`arm_key`).
   - ONE shared arm-key list (`blinding.json`, exported from ad-contracts) is read by both check_blinding and the guard.
   - A `.sealed` upload whose base session (or its own session_start) isn't blinded is rejected (`sealed_base_not_blinded`).
   - The server side is InfrastructureBot's (see Requests below).
2. **All differences from the R3 draft are accepted; contract-v1 is authoritative.** The Researcher aligns
   `validate.py` to `note.schema.json` and `renderActorText`. (The differences, for the record: draft-07 vs 2020-12;
   `u<k>` ids have no paragraphs and hypothesis evidence follows the id pattern; length limits rationale ≤ 800,
   observation ≤ 400, suggestion.text ≤ 280, target ≤ 160, value ≤ 500, evidence ≤ 24, changed ≤ 8 × 200; rendering
   per decisions 9-11.)
3. **Unsealing and judge results.** Unsealing is dataset-level, after the R5 stopping rule is met and the analysis
   code is hash-frozen. Judge results go in a separate judge file keyed by sessionId, note id or turn, judge prompt
   id, model and run id. The sealed log is never re-uploaded and stays immutable and hash-pinned. Judge output
   computed on sealed logs is stored sealed too. Judge fields stay null in the main log. A judge-file type can wait
   for contract-v2.
   - Per session, only the participant-side steps come first: the session survey and the blind guess. The app never
     reveals the arm. Analyst unsealing is dataset-level only, after the R5 stopping rule is met and the analysis code
     is hash-frozen. Interim reports never read sealed logs.
4. A survey/rating event for bh-ad/1 comes in contract-v2.

## Blinded guard rules (shared by the client guard and check_blinding)

For an upload whose `session_start.session_type` is `blinded` and whose sessionId doesn't end in `.sealed`, reject if
any line has: `session_start.arm` or `p_inject`; `actor_turn.note_id` or `actor_request_sha256`; a non-null
`actor_turn.usage.prompt_tokens`; a line of type `director_call | rail_check | injection | note_dropped | leak_judge | tab_occluded | context_share |
note_outcome | session_share`; `health.code` `director.leak_breaker`; or any key matching the shared arm-key list at any
depth. Fail closed: every line must be a bh-ad/1 object of this session and the first line its session_start, else
reject. A `<id>.sealed` upload is accepted only when its own session_start and the base `<id>` main log are blinded.
The sealed log needs a read key the app never holds and is unsealed only at dataset level: analyst unsealing happens only after the R5 stopping rule is met and the analysis code is
hash-frozen; per session only the participant-side survey and blind guess come first, the app never reveals the arm,
and interim reports never read sealed logs (ruling 3).
check_blinding.mjs applies the same per-line rules to every bh-ad/1 blinded main log in a folder (sealed files are
counted, not checked; tab_visible logs carry the arm by design).

## Requests to InfrastructureBot (no divergence; the contract adopts 9bc90f1 as-is)

1. Accept the `<sessionId>.sealed` companion upload as a normal `ad_session` (it already passes `ID_RE`). Optionally,
   restrict reading it to a separate key.
2. Implement the server side of the blinded guard (approved by the Researcher): same rules, read from `blinding.json`, fail closed, and reject a `.sealed` upload whose base session isn't blinded. Proposed error: 422 with a code per `BLINDED_GUARD_CODES` (naming is yours).

## contract-v2 backlog (not implemented; collected for v2)

From R5 (`research/R5/`: PREREG_EVAL_DRAFT.md §10, SURVEY_EVENT_PROPOSAL.md, PILOT_ACCURACY.md):
1. A `survey` event with `blind_guess`; `probe_trigger` and `note_id` are sealed-only (TAB_ONLY_FIELDS.survey).
2. Pilot events: `pilot_target`, `pilot_page`, `pilot_run`.
3. `director_would_be` tokens for held-back (shadow / blocked) notes, for the would-be share.
4. `session_start` pins: the format id and assembled prompt sha8 (v1.1 has them as optional `director_format_id` /
   `director_assembled_sha8`; v2 makes them required), plus `judge_prompt_id`, `gaze_config_hash`, `survey_id`.
5. The per-turn injection draw `u` on `injection`, sealed only (coin provenance for the audit).
6. A judge-file schema (`bh-ad-judge/1`: sessionId, note id or turn, judge prompt id, model, run id; stored sealed for
   sealed logs).
7. `check_blinding` exempts `survey.blind_guess` (its value is an arm word) and masks arm words in survey free text.

From E6 (Director tab v1; rulings 2026-11-04 4:00 PM PT):
1. `signals.ts`: add `"gaze"` to `SignalSource.kind` (protocol-4 file; needs an approved change). Until then the
   ad module uses `AdSignalSource` / `asSignalSource(GazeSource)` (structural adapter).
2. Keystroke timing on `user_turn` (R1 item 2): the web composer records key TIMES only (`KeystrokeTimes`, never the
   key) and keeps them local; v1 logs nothing from them and only uses the first key time to close the reading window.
3. `composer_hesitation` events fed from those intervals (v1 never emits them from the web app).

From R1 (`research/R1/FEATURES.md`, "What R1 needs that contract-v1 lacks"):
1. Drift anchors: an event for taps / known-gaze moments `{t, x, y}` (composer-tap drift correction).
2. Keystroke timing: first-key time and pause count (or inter-key intervals, never key identity) on `user_turn`.
3. Paragraph streaming / visibility: `aoi_layout` box `complete_t` (stream-complete time).
4. Line height per AOI box (`line_h`).
5. A fixed paragraph split rule for excerpts, in the contract.
6. Calibration validation error (`errDeg` / `errParas` from a validation-dot check) from `calibrate`.
7. A Mac meaning for `Orientation`.
8. Measured delivery rate (fps) next to the nominal `gaze_quality.hz`.
9. `aoi` on `gaze_l1` fixations.
(R1 item 9, streaming state across ~100 ms batches, and item 10, `lids`, are implementation notes, not contract needs.)
