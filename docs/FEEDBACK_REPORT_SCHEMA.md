# In-app bug report: `brianharness-feedback/1`

The client side of `POST /v1/feedback`. The transport contract (auth, limits, status codes, and the read API) is
brianharness-worker **docs/FEEDBACK.md** (branch `feedback`, 4d0d36b). This document defines the **report**: the
envelope fields the client fills in and what goes inside `payload`, which the Worker treats as opaque.

Code: `packages/core/src/flight-recorder.ts` (recorder, redaction, study safety, builder),
`packages/core/src/upload-queue.ts` (queue kind `feedback`), `apps/desktop/src/transport/feedback.ts` (delivery and
export), `apps/desktop/src/feedback/*` (UI hooks), `apps/desktop/src/components/FeedbackSheet.tsx` (sheet).

## Opening a report

| Trigger | `payload.header.trigger` |
|---|---|
| Sidebar row **Report** (`data-feedback-row`), below Sign in with Apple | `sidebar` |
| **Cmd+Shift+R** (Ctrl+Shift+R off macOS). No Alt. It works while typing in the composer. | `shortcut` |
| `window.__bhReport({source})` from native, e.g. a shake (docs/IOS_DEV_NOTE_feedback.md) | `source`, else `hook` |

The sheet has one optional note (the Worker's `summary` gets the first 500 chars) and two buttons: **Send** and
**Cancel** (then **Done** after a result). Escape closes the sheet. Opening it takes a fresh screen snapshot. It doesn't start a chat, end a
session or count as time away: the page stays visible, so AWAY_MS never runs. The row only appears when the
transport has a `feedback` bridge, which means the in-process transport (web and iOS). Electron isn't wired.

**Session log:** the sheet is bracketed in the current session's JSONL by `feedback_open`, then `feedback_sent
{report_id}` (on Send), then `feedback_closed {sent}`. Details are in docs/PHASE_D_LOG_SCHEMA.md, "Report sheet
events", with a sample at docs/samples/feedback_events_sample.jsonl. These are the only log changes. A report's
content never goes into the session log.

## Flight recorder

A ring buffer of the last **200** events, `{ts, type, data}`, with `ts` in epoch ms. Recording never throws and never
blocks the UI. It hooks into two layers only:

| type | Source | `data` |
|---|---|---|
| `screen` | DOM snapshot, debounced 600 ms after a mutation, and once when the sheet opens | `screen`, `overlays[]`, `layout`, `busy`, `title` (null in study), `controls[]` (≤60 labelled controls with `control`, `label`, `pressed`/`disabled` when set), `messages[]` (`role`, `text` ≤500 chars, `cutOff`/`failed`), `notices[]`. Values of password and secret-looking inputs read `[hidden]`. |
| `tap` | click capture on **named** controls only (`data-*` hooks or an aria-label) | `name`, `control`, `screen`. Rating UI controls are recorded generically, in every session (see "Absorption ratings" below). |
| `chat` | the model-backend wrapper (`recordingBackend`), one per generate() call | `backend`, `model`, `max_tokens`, `status` (HTTP, null for mock), `ms`, `finish_reason`, `usage {prompt_tokens, completion_tokens, reasoning_tokens}`, `truncated` (finish_reason `length`, or a failure after part of the reply streamed: the director_turn rule), `error` (`{code, message}`; `{code}` in study), `streamed`, `chars` |
| `error` | stream errors (`source: "stream"`), `window.onerror`, `unhandledrejection`, rejected native plugin calls (`source: "native"`, `plugin`, `method`) | `source`, `code`, `message` (redacted, ≤300 chars; **never in study**), `status?`, `partial?`, `where?` |
| `state` | transport | `backend` (the backend built), `provider` (provider change), `mock_fallback`, `report_open`, `feedback_delivery` (the last send's result) |

Study state is recorded as `{inStudy, index}` only.

## Envelope (Worker-validated)

```
schema       "brianharness-feedback/1"
report_id    uuid v4, made once per report and kept across retries and the export file (the idempotency key)
kind         "bug"
created_at   ISO, client clock
summary      the note, redacted, ≤500 chars (omitted when empty)
app          {bundle_id?, version?, build?, commit?}  all strings; omitted when unknown
filters      {inStudy, truncated_turns, last_error_code?, platform: ios|desktop|web}
payload      {header, events, chat_turns}
```

Unknown optional values are **omitted**, never sent as null (the Worker treats null as absent anyway).
`filters.truncated_turns` counts the included `chat` events with `truncated: true`. `filters.last_error_code` is
the code of the newest error, or its `source` when it has no code.

## Payload

```
header {
  report_id, build, commit, app_version, device, os, orientation, platform,
  app_state {visibility, online, layout, busy, sidebarOpen, hudOpen, overlays[], backend, provider, model, uploads},
  note,                 full note, redacted, ≤4000 chars
  last_error_summary,   "error[<source>] <message> (<age> ago)", newest error within 10 min, or null
  sessionId,
  study {inStudy, index},
  trigger,
  counts {events_recorded, events_included, events_dropped, text_cap, bytes}
}
events      the recorder's events, oldest first
chat_turns  the last 6 chat turns: {role, text, cutOff?, failed?, streaming?, error?}
```

### Size budget

The client budget is **100 KB** of serialized JSON (the Worker accepts 256 KB). When the report is over budget:

1. Drop the **oldest events** first, keeping the newest 20.
2. Then cap message text at 300, 200, 120, 80 and finally 40 chars (`counts.text_cap` records the cap).
3. Then drop more events until it fits.

`counts.bytes` is the final size. Anything over 256 KB never reaches the network; it goes straight to export.

## Redaction (every report)

- **Strings:** `bhd_…`, `bhr_…`, `sk-…`, `Bearer …`, JWTs (`eyJ….….…`, such as an Apple identity token), Ollama
  keys, GitHub, Slack, AWS and Google keys, and private keys are replaced with `[REDACTED]`. So are the Worker
  scan's generic runs: 40+ char base64 with mixed case, ≥4 digits and entropy ≥4, and 48+ char hex (except
  exactly 64 chars, a sha256).
- **Fields:** any key named `*token` (not `*tokens`), `*key`, `*secret`, `*nonce` or `*password`, plus
  `identityToken`, `appleUser`, `authorization`, `cookie`, `credential(s)`, `passcode`, `otp`. The value becomes
  `[***]`. It is shorter than 8 chars on purpose, so the redacted report never trips the scan's `secret_field`
  rule.
- The client also runs the session-upload secret pre-check (`findUploadSecret`) on the final bytes. A hit marks
  the report needs-export and never sends it. A redacted report passes the check (test: `flight-recorder.test.ts`).

## Absorption ratings (every report, study and practice)

The 1–5 absorption ratings are study outputs, so no report carries a rating value, in any session. That covers the
per-turn probe (`[data-rating-probe='turn']`) and the session rating card (`[data-rating-probe='session']`, with
its 1–5 row `[data-rating-option]`, "What hooked you?" and the blinding check `[data-blind]`).

- **UI layer** (`feedback/snapshot.ts` `ratingHidden` / `ratingControl`, also part of `studyHidden`): every control
  inside the rating UI is recorded as a generic label and `control` only. The labels are `rating option`,
  `blinding-check option`, `rating text field` and `rating control` (Skip / Done). There's no value, name, text,
  aria-label, checked/selected/pressed/disabled state or index. All five options look the same, so their order
  says nothing. Picking an option doesn't change the snapshot, so it doesn't even add a `screen` event. Notices
  inside the rating UI aren't read. Keyboard Enter/Space on a rating button reaches the recorder as the same click.
  No keydown or focus events are recorded.
- **Core backstop** (`ratingScrubEvent`, at record time and again at build time): it drops `rating`, `ratings`,
  `absorption`, `hooked` and `blindGuess` keys. Any tap or control named with a 1–5 digit on a rating screen
  becomes `rating option`. Generic rating controls are cut back to `{label|name, control, screen}`.
- **Ratings reach the recorder by no other path.** `rate()` records nothing, a failed `rate()` is only
  `console.warn`ed, and the overlay names (`turn-probe`, `session-rating`) carry no value.
- `tools/phaseD/check_blinding.mjs` checks every report it finds: a `feedback_report` line, or an exported
  `bh-feedback-*.json`. It flags rating keys, a 1–5 digit as a tap name or radio label, any state on a generic
  rating control, and checked radios on a rating screen.
- Tests: `apps/desktop/test/feedback-rating.test.ts` renders the real `Rating.tsx` markup, rates the probe and the
  session rating (with the blinding check and "What hooked you?"), opens Report, and checks the report in study
  and practice.

## Study safety

When `study.inStudy` is true, the report is passed through `studySafe` after redaction:

- **Dropped keys:** `plan`, `stateNote`, `mode`, `hypothesis`, `topTopics`, `topStyles`, `interestMap`,
  `blindGuess`, `adaptation`, `arm`, `condition`, `assignment`, `schedule`, `scheduleHash`, `order` and `seed`.
- **Nulled keys** (they stay in place, so both arms have the same shape): `usage.prompt_tokens`, `input_tokens`,
  `total_tokens`, `cached_tokens`, and every prompt, state-note, system-prompt or messages size (`*_chars`,
  `*_len`, `*_size`, `*_bytes`, `*_tokens`). The adaptive Director prompt carries the plan and state note, so its
  size would tell the arms apart. This matches the session log.
- **Arm words:** any string that is exactly `adaptive`, `baseline`, `explore`, `exploit` or `relax` becomes
  `[omitted]`.
- **Errors: short code only, the same as the session log's `director_turn.error`** (ee99b5a, `shortErrorCode`:
  `err.code`, `aborted`, `http_<status>`, else `stream_error`). An HTTP error message can quote up to 300 chars of
  the response body, so in study:
  - `error` events keep only `source`, `code`, `plugin`, `method`, `status`, `partial` and `where`.
  - `chat.error` is `{code}`.
  - On-screen `⚠ …` messages in `screen` events and `chat_turns` become `⚠ [error text omitted]`.
  - Notices other than the fixed reply notes ("Reply cut off…", "Reply interrupted…") become `[notice omitted]`.
  - `last_error_summary` is built from the scrubbed events, e.g. `error[stream] http_502 (8s ago)`.
- **Applied at record time, and again when the report is built.** While a study session is live (the UI's
  `hud.study`, and the transport probing the host's session, so the first turn is covered too), the recorder
  stores only scrubbed events, so the raw text never sits in memory. The builder scrubs every event again, which
  covers events recorded before the flag flipped.
- **Study state** is `{inStudy, index}` only. The conversation title is null. The HUD is never read, and its taps
  aren't recorded. Rating and blinding-check controls are generic in every session (above).
- **Kept:** `completion_tokens`, `reasoning_tokens`, `ms`, `chars` and `finish_reason`. Both arms produce these
  from the same chat path, and they are already in director_turn.

`apps/desktop/test/feedback-app.test.ts` writes mid-study reports in both arms, runs
`tools/phaseD/check_blinding.mjs` on them (0 leaks), and checks that the two reports have identical key paths.
Sending a report doesn't touch the schedule, timing, ratings, session records or the study-log upload summary.
The same test proves that.

## Delivery

`bridge().feedback.send(report)` puts the exact report bytes in the UploadQueue as kind **`feedback`** and runs one
**non-forced** flush, so any existing pause still applies. It sends `POST /v1/feedback` with
`Authorization: Bearer <Spider Cloud device token>` and `Content-Type: application/json`. Session and study_start
items, and their bodies, are unchanged (byte-identical test in `upload-feedback.test.ts`). Feedback items are left
out of the study-log upload summary, so the "Export logs" prompt is unchanged.

| Response | Queue state | Sheet |
|---|---|---|
| 201 `{id, received_at}` | done | "Report sent. Thank you!" |
| 409 `report_exists` (`same_content` either way) | done | same as 201 (it was already delivered) |
| 404 (Worker not deployed yet) | needs-export, never retried | "Saved as a file instead (the report server isn't live yet)." |
| 400 `invalid_feedback`, 413 `feedback_too_large`, 422 `invalid_feedback_envelope` (`field`), 422 `upload_rejected` (`reason`), 403 `insufficient_scope`, any other 4xx | needs-export, never retried | "Saved as a file instead (the server didn't accept it)." |
| 401 `missing_token` / `invalid_token` / `session_expired`, or no token | stays pending (the queue's global token pause, unchanged) | "Saved as a file instead (it couldn't be sent right now); it will also upload later." A later resend that hits 409 counts as done. |
| 429 `feedback_daily_cap_*` | pending, with **this item's** next attempt at `Retry-After` (seconds to the next 00:00 UTC, uncapped). Session uploads don't pause. | same as 401 |
| 5xx or offline | pending, with the queue's usual backoff | same as 401 |
| over 256 KB, or the client secret pre-check hits | needs-export without sending | exports |

**Export** is one pretty-printed file, `bh-feedback-YYYYMMDD-HHMM-<id8>.json`. On iOS it goes to the BHExport share
sheet; elsewhere it downloads.

## Worked example

A cut-off reply (finish_reason `length`), a native plugin error whose message carried a token, an HTTP 502 whose
message quotes the response body, and then **Report** from the sidebar. Not in a study session.

The same report made mid-study is in `docs/samples/feedback_report_study.json`. There, `usage.prompt_tokens` is
null, `plan` and `mode` are gone, the title is null, and every error carries its code only. The ⚠ turn reads
`⚠ [error text omitted]` and `last_error_summary` is `error[stream] http_502 (8s ago)`. Wrapped as a study JSONL,
`tools/phaseD/check_blinding.mjs` reports 1 study file and 0 leaks.

```json
{
  "schema": "brianharness-feedback/1",
  "report_id": "3f0c1e9a-6b1d-4c4e-9a53-2b7d8f1e0c11",
  "kind": "bug",
  "created_at": "2026-11-03T17:41:20.000Z",
  "summary": "reply stopped halfway, and the cut-off note was hidden",
  "app": {
    "bundle_id": "com.manny.brianharness",
    "version": "0.4.0",
    "build": "20261103.0940",
    "commit": "b413996"
  },
  "filters": {
    "inStudy": false,
    "truncated_turns": 1,
    "last_error_code": "http_502",
    "platform": "ios"
  },
  "payload": {
    "header": {
      "report_id": "3f0c1e9a-6b1d-4c4e-9a53-2b7d8f1e0c11",
      "build": "20261103.0940",
      "commit": "b413996",
      "app_version": "0.4.0",
      "device": "iPhone",
      "os": "iOS 18.1",
      "orientation": "portrait",
      "platform": "ios",
      "app_state": {
        "visibility": "visible",
        "online": true,
        "layout": "phone",
        "busy": false,
        "sidebarOpen": true,
        "hudOpen": false,
        "overlays": [
          "sidebar"
        ],
        "backend": "spider-cloud",
        "provider": "spider-cloud",
        "model": "grok-4-fast",
        "uploads": {
          "pending": 0,
          "needsExport": 0
        }
      },
      "note": "reply stopped halfway, and the cut-off note was hidden",
      "last_error_summary": "error[stream] http_502: HTTP 502: {\"error\":{\"message\":\"upstream overloaded, retry\"}} (8s ago)",
      "sessionId": "s-20261103-0938-7f2a",
      "study": {
        "inStudy": false,
        "index": null
      },
      "trigger": "sidebar",
      "counts": {
        "events_recorded": 10,
        "events_included": 10,
        "events_dropped": 0,
        "text_cap": 500,
        "bytes": 3798
      }
    },
    "events": [
      {
        "ts": 1793727600000,
        "type": "state",
        "data": {
          "event": "backend",
          "backend": "spider-cloud",
          "provider": "spider-cloud",
          "model": "grok-4-fast"
        }
      },
      {
        "ts": 1793727600900,
        "type": "screen",
        "data": {
          "screen": "chat",
          "overlays": [],
          "layout": "phone",
          "busy": false,
          "title": "Rust lifetimes",
          "controls": [
            {
              "control": "composer-send",
              "label": "Send"
            }
          ],
          "messages": [
            {
              "role": "user",
              "text": "explain lifetimes in depth"
            }
          ],
          "notices": []
        }
      },
      {
        "ts": 1793727604100,
        "type": "tap",
        "data": {
          "control": "composer-send",
          "label": "Send"
        }
      },
      {
        "ts": 1793727661300,
        "type": "chat",
        "data": {
          "backend": "spider-cloud",
          "model": "grok-4-fast",
          "max_tokens": 4096,
          "status": 200,
          "ms": 57200,
          "finish_reason": "length",
          "usage": {
            "prompt_tokens": 1832,
            "completion_tokens": 4096,
            "reasoning_tokens": 0
          },
          "truncated": true,
          "error": null,
          "streamed": true,
          "chars": 15230
        }
      },
      {
        "ts": 1793727661900,
        "type": "screen",
        "data": {
          "screen": "chat",
          "overlays": [],
          "layout": "phone",
          "busy": false,
          "title": "Rust lifetimes",
          "messages": [
            {
              "role": "assistant",
              "text": "Lifetimes describe how long a reference is valid… (reply ends mid-sentence)",
              "cutOff": true
            }
          ],
          "notices": [
            "Reply cut off at the length limit"
          ]
        }
      },
      {
        "ts": 1793727670000,
        "type": "error",
        "data": {
          "source": "native",
          "plugin": "BHAppleAuth",
          "method": "credentialState",
          "code": "ESTATE",
          "message": "state check failed for Bearer [REDACTED]"
        }
      },
      {
        "ts": 1793727672000,
        "type": "chat",
        "data": {
          "backend": "spider-cloud",
          "model": "grok-4-fast",
          "max_tokens": 4096,
          "status": 502,
          "ms": 900,
          "finish_reason": null,
          "usage": {
            "prompt_tokens": null,
            "completion_tokens": null,
            "reasoning_tokens": null
          },
          "truncated": false,
          "error": {
            "code": "http_502",
            "message": "HTTP 502: {\"error\":{\"message\":\"upstream overloaded, retry\"}}"
          },
          "streamed": true,
          "chars": 0
        }
      },
      {
        "ts": 1793727672001,
        "type": "error",
        "data": {
          "source": "stream",
          "code": "http_502",
          "message": "HTTP 502: {\"error\":{\"message\":\"upstream overloaded, retry\"}}",
          "status": 502,
          "partial": false
        }
      },
      {
        "ts": 1793727672600,
        "type": "screen",
        "data": {
          "screen": "chat",
          "overlays": [],
          "layout": "phone",
          "busy": false,
          "title": "Rust lifetimes",
          "messages": [
            {
              "role": "assistant",
              "text": "⚠ HTTP 502: {\"error\":{\"message\":\"upstream overloaded, retry\"}}"
            }
          ],
          "notices": []
        }
      },
      {
        "ts": 1793727675000,
        "type": "tap",
        "data": {
          "control": "sidebar-report",
          "label": "Report"
        }
      }
    ],
    "chat_turns": [
      {
        "role": "user",
        "text": "explain lifetimes in depth"
      },
      {
        "role": "assistant",
        "text": "Lifetimes describe how long a reference is valid… (reply ends mid-sentence)",
        "cutOff": true
      },
      {
        "role": "user",
        "text": "keep going"
      },
      {
        "role": "assistant",
        "text": "⚠ HTTP 502: {\"error\":{\"message\":\"upstream overloaded, retry\"}}",
        "error": true
      }
    ]
  }
}
```
