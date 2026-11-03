# Phase D session log schema

One JSONL file per session (`bh-session-<idx>-<startISO>-<tag>.jsonl` for study sessions, `<idx>` = 2-digit
study index, never the mode; `bh-session-<startISO>-<tag>.jsonl` otherwise; `<startISO>` = session_start.t as
`YYYYMMDDTHHMMSSZ`; `<tag>` = the last 6 alphanumerics of `sessionId`, i.e. its milliseconds + random suffix,
e.g. `2026-11-02T22-52-09-849Z-ogfj` -> `9Zogfj`; the first 6 would only repeat the year). Names are generated
in JS for every platform, unique per session and stable (re-saving a session replaces only its own file). One JSON object per line, `\n`-terminated, in this order:

```
session_start
director_turn (turn 0, the opener)
( user_turn, interest_update, director_turn )  x N user replies
rating*            (anywhere after a director_turn; turn-scope probes and at most one answered session rating)
final
session_end
```

The file in Documents (iOS autosave), the BHExport share/AirDrop copy, "Export logs" and the
`/v1/sessions` upload `jsonl` field are the same bytes (`HarnessHost.sessionFile(id).content`).

Every record has `type` and `t` (ISO-8601 UTC, `Date.toISOString()`). Times named `*At` without a
`t` prefix are epoch ms from the renderer clock.

## Blinding

- The study arm (adaptive / baseline) is never written: no `adaptation`, `mode`, `order`, `seed` or
  `schedule` in any study-session record, the export CSV, the upload body or the HUD.
- **`director_turn.plan.mode` is pacing, not the study arm.** It is the Director's per-turn plan
  (`"explore" | "exploit" | "relax"`) and appears **only in non-study sessions**. Study sessions log
  `director_turn {sealed:true}` without `plan` or `stateNote` (test: `rating-study.test.ts` "study reissue").
  The key keeps its name because sidecar protocol `brianharness-sidecar/1` and Phase C replays read it.
  A naive `grep '"mode"'` therefore hits non-study logs only; use `node tools/phaseD/check_blinding.mjs <dir>`,
  which fails on a plan / mode / arm key / arm value in a study session.
- `rating.blindGuess` may be `"adaptive"` or `"baseline"`: it is the participant's guess (a study outcome),
  not the assignment.

## Schedule hash

`scheduleHash` = lowercase sha256 hex of the **raw** string stored in the secure store (iOS BHKeychain
`study/phaseD/schedule`; desktop: the safeStorage credentials file). The raw string is
`JSON.stringify({study, version, seed, order, createdAt, protocol})`, keys in exactly that order, with
`createdAt` from `Date.toISOString()` (e.g. `"2026-11-02T22:48:23.889Z"`). Practice schedules (build 1438) had no
`protocol` key: `JSON.stringify({study, version, seed, order, createdAt})`. After session 10,
`StudyController.unseal("UNSEAL phaseD")` returns `{...schedule, scheduleHash, raw}`; verify with
`sha256(raw) === scheduleHash` (no re-serialisation needed). `raw` has **no trailing newline** (and no BOM / pretty-printing);
hash the UTF-8 bytes exactly as stored.

Exported schedule file: `scheduleExportFile(unsealed)` (core; desktop dev hook `window.__bhStudy.exportSchedule("UNSEAL phaseD")`)
writes `phaseD-schedule-<hash[0:12]>.json` whose content is `raw` byte-for-byte, so `shasum -a 256 <file>` prints the
`scheduleHash`. iOS: write the Keychain string as-is (`Data(raw.utf8)`), never `raw + "\n"`.
`brianharness-export-ratings --schedule <file>` accepts that file (hash = sha256 of the file) or an `unseal()` JSON
(its `raw` is re-hashed and must match its `scheduleHash`).

## Study protocol

`STUDY_PROTOCOL_VERSION = 2` (the freeze). It is sealed into the schedule as `protocol` and logged in
`session_start.study.protocol`, `final.protocol` and `study_start.protocol` (local record; see the upload note
below). On launch a schedule with no or a lower `protocol` is discarded together with the study progress
(enabled/next/last), so "Start study" seals a new schedule with a new hash. Session files and the upload
queue are never touched. **Study sessions without `study.protocol` come from practice build 1438 and are
excluded.** Export CSV column: `study_protocol`.

## Index reissue (validity)

A study session is **valid** when it has >= 8 `user_turn` records **and** its **last** session-scope `rating`
has a non-null `value` (1..5). A later dismissal / null rating replaces an earlier answer (same rule as the box
analysis: the last session rating wins). When the previous study session is invalid, the next session
gets the **same index** (so the same mode) and logs `reissueOf: <previous sessionId>` in `session_start`.
`reissueOf` is a **top-level** `session_start` field, omitted when the session is not a reissue. A reissue never
advances the index; the index never exceeds 10, and after 10 valid sessions the study is finished (`assign()`
returns null: later sessions are ordinary non-study sessions). Dedupe on the last valid session per index.
CSV column: `reissue_of`. Reissued sessions share `bh-session-<idx>-…`, but the `<tag>` keeps their file names
distinct even within the same second, so no file overwrites another (`exportFiles()` also suffixes `-2` as a
last-resort guard). Native code needs no collision handling.

## Manual reissue (Settings > Study > "Redo a study session…")

The participant picks an already assigned index N (1..`next-1`, never above 10), may type a short reason
(free text, trimmed, whitespace collapsed, **<= 120 chars**) and must type the exact phrase `REISSUE N`. The
request is stored in the study progress (`manualReissue: N`, `manualReissueReason?`), shown as "Next study
session redoes N · cancel", and consumed by the **next** study session, which gets index N (so N's mode, never
shown) and logs, top-level in `session_start`:

```ts
{ type: "session_start", …, study: { id, index: N, total, scheduleHash, protocol }, reissueOf: "manual", manualReissue: true, reissueReason?: string }
```

It never changes the schedule or its hash, and the index sequence continues where it was (the redo is an extra
session). Analysis: dedupe on the last valid session per index, as for automatic reissues. CSV columns
`reissue_of` (= `manual`) and `reissue_reason`. **Worker note:** `reissueReason` is free text; it must be on the
Worker's blinding exemption list (like `reason`), otherwise a reason that is exactly "baseline"/"adaptive" would
be rejected as `blinding:arm_value`. (Done in the Worker at b1c8955.)

## Study progress storage and recovery (`progressRecovered`)

The study progress (`{enabled, next, last?: {sessionId, index}, manualReissue?, manualReissueReason?}`; never
the mode) is stored in the **same secure store as the schedule**, key `study/phaseD/progress` (iOS: BHKeychain;
Electron: the safeStorage credentials file; plain web: localStorage, as the schedule), each write verified by
read-back. Builds up to E kept it in the settings KV (iOS: WebView storage): on first read it is copied into
the secure store (read-back verified) and the old copy is removed.

If the schedule exists but the progress does not (WKWebView storage eviction, partial restore), the app never
restarts at index 1. It rebuilds the progress from the study sessions still on the device, for the current
`scheduleHash` only: the local session logs and the upload ledger (`uploads/index` items carry
`study: {index, scheduleHash, valid}`; on iOS with BHExport kv* it is `Documents/pending-uploads`, which
survives eviction). Rule: h = the highest study index found; next = h + 1 if any session with index h is valid
(>= 8 user turns and the last session rating answered), else h. A valid index is never handed out again. The
next study session logs, top-level in `session_start`:

```ts
{ type: "session_start", …, study: { id, index, total, scheduleHash, protocol }, progressRecovered: true }
```

If nothing can be found, the study is blocked: a notice "Study progress lost; contact the Researcher" is shown
above the chat and in Settings, no session gets study fields, and Start study / Redo are refused, until the
participant uses Settings → "Set next study session…" (pick N 1..10, type `SET NEXT N`, as the Researcher
says). That next study session also logs `progressRecovered: true`. Analysis: a `progressRecovered` session
marks a point where the device's own progress was rebuilt; check its index against the Worker's rows.
`progressRecovered` is a boolean, so the Worker's blinding scan accepts it (checked against Worker b1c8955
`checkJsonl`). A failing secure store (Keychain -34018) behaves as before: the study cannot start and sessions
run with no study fields.

## Interest extractor budget

- **Study sessions:** a per-session budget of **10 logical extractor calls** (every 6th user turn: enough for 60
  turns), counted per session. A logical call = one cache miss sent to the network; its HTTP retry does not count.
  At most **1 retry** per logical call (5xx only), and a hard per-session ceiling of **20 HTTP attempts**. No
  device-wide counter: practice can never use study budget.
- **Non-study sessions:** the existing device-wide counter (50, settings key `llm-extract/calls`; desktop
  `<userData>/llm-extract-calls.json`), each HTTP attempt reserved, up to 2 retries. Study sessions never read
  or write it.
- `final/session_end.extractorCalls` as before; `fallbackReason: "cap_reached"` in a study session now means the
  per-session budget (or the HTTP ceiling) was exhausted.

## Samples

`docs/samples/phaseD_sample_export.jsonl` (a BHExport/Files session file) and `docs/samples/phaseD_sample_upload.json`
(its `POST /v1/sessions` body; `jsonl` is the export byte-for-byte) are generated from the freeze code by
`npx tsx tools/phaseD/make_sample.ts`: a protocol-2 study session (index 1), 10 user turns, 2 turn probes, a session
rating, the extractor answering via a fake Spider Cloud Worker (so `extractor.*` features appear from user turn 6),
and the final outcome fields (`extractorCalls`, `effectiveTagger`, `fallback`, `protocol`). The script validates the
body against the Worker's own `checkJsonl` / `scanValue` (local checkout, read-only).

## Records (typed examples)

```ts
// session_start
{ type: "session_start", t: string, sessionId: string, userId: string, backend: string, // e.g. "spider-cloud:gemma4:cloud"
  sources: string[],                                       // ["typing:typing"]
  study?: { id: "phaseD", index: number /*1..10*/, total: 10, scheduleHash: string /*64 hex*/, protocol?: number /*2*/ },
  reissueOf?: string,                                      // study only: the invalid previous session, or "manual"
  manualReissue?: true, reissueReason?: string,            // manual redo only (see Manual reissue)
  progressRecovered?: true }                               // first study session after a progress rebuild / Set next

// director_turn
{ type: "director_turn", t: string, turn: number /*0-based, = user replies so far*/, text: string, backend: string,
  genMs: number, firstTokenMs?: number, streamed?: true,
  sealed?: true,                                           // study sessions: no plan, no stateNote
  plan?: { turn: number, mode: "explore"|"exploit"|"relax" /*pacing*/, topic: string, altTopic?: string, style: string, reason: string, scout?: boolean },
  stateNote?: string,                                      // non-study only
  // reply metadata (Addendum 4, builds after 20261102.2031; absent in older logs). Same keys on every
  // director_turn in both arms; null = not reported by the backend (mock, providers without usage)
  model: string,                                           // model name sent, e.g. "gpt-oss:20b-cloud" (mock: "mock")
  max_tokens: number | null,                               // the max_tokens sent (providers/max-tokens.ts table)
  finish_reason: string | null,                            // "stop" | "length" (hit max_tokens) | provider value; null on a failed stream
  usage: { prompt_tokens: number | null, completion_tokens: number | null,
           reasoning_tokens: number | null },              // Spider Cloud never reports reasoning_tokens -> null
  truncated: boolean,                                      // finish_reason "length" (app shows "Reply cut off"), or the stream failed after partial text
  error?: string }                                         // only on a failed stream: "stream_incomplete" | "aborted" | "stream_error";
                                                           // text = what was shown; the transcript does not keep it and the next
                                                           // director_turn reuses the same turn number

// user_turn (turn = 0-based index of this reply; the rating card's turn = user_turn.turn + 1)
{ type: "user_turn", t: string, turn: number, text: string,
  features: {
    "text.words": number, "text.chars": number, "text.questions": number, "text.exclaims": number, "text.topicHits": number,
    "text.relWords"?: number,
    "typing.latencyToFirstKeyMs": number, "typing.latencyToSubmitMs": number, "typing.gapCount": number,
    "typing.gapMeanMs": number, "typing.gapMedianMs": number, "typing.gapP90Ms": number,
    "typing.dictated": 0|1, "typing.pasted": 0|1, "typing.autocorrections": number, "typing.predictive": number,
    "typing.timingReliability": number, /* ...other typing.* */
    // logging only (never fed to engagement, ranking or the Director); absent before the first non-empty
    // extractor answer, then carried forward until the next one; identical logic in both arms
    "extractor.enthusiasm"?: number,   // 0..1 confidence of the top-ranked label of the latest answer
    "extractor.top1_turns"?: number,   // user turns that label cites (deduped, within range)
    "extractor.n_labels"?: number,     // labels in that answer
  },
  engagement: number, baseline: number, mentionedTopics: string[],
  prompt: { firstTokenAt?: number, completeAt: number },
  rawEvents?: Array<{ t: number, kind: "insert"|"delete"|"paste"|"submit"|..., len: number, source?: string }>,  // no key identities
  keyGaps: number[] }

// interest_update
{ type: "interest_update", t: string, turn: number, topTopics: Array<[topicId: string, mean: number]>, hypothesis: string|null, top1: string|null }

// rating
{ type: "rating", t: string, scope: "turn"|"session", turn: number, value: 1|2|3|4|5|null,
  shownAt: number, answeredAt: number|null, dismissed: boolean, reason?: string,
  hooked?: string,                                         // session scope
  blindGuess?: "adaptive"|"baseline"|"no-idea"|null }      // session scope, study sessions

// final (just before session_end)
{ type: "final", t: string, turns: number, top1: string|null, top3: string[], top3Ids: string[], tagger: string,
  extractorPromptVersion?: "v1"|"v2", model?: string,
  protocol?: number,                                       // study sessions
  extractorCalls: { attempted: number, ok: number, failed: number, capped: number },
  effectiveTagger: "llm-extract"|"keyphrase-idf"|string, fallback: boolean,
  fallbackReason?: "no_key"|"mock_or_local"|"cap_reached"|"call_failed"|"offline"|"not_due" }

// session_end
{ type: "session_end", t: string, turns: number, extractorCalls: {...}, effectiveTagger: string, fallback: boolean, fallbackReason?: string }

// study_start (one per sealed schedule, written when "Start study" runs; uploaded, not part of a session file)
{ kind: "study_start", id: string /* "phaseD-<scheduleHash[0:16]>" */, scheduleHash: string, nSessions: 10,
  appVersion: string, build: string|number|null, platform: "ios"|"desktop"|"web", createdAt: string /* schedule createdAt */,
  protocol: number }                                       // uploaded since Worker 2ef027e (optional int 1..100)
```

No record carries API keys, device tokens or the Authorization header.

## Upload body (`POST /v1/sessions`)

See the Worker's `docs/SESSIONS_API.md` (allowlist as of Worker 2ef027e; builders: core `sessionUploadBody` /
`studyStartUploadBody`, which emit exactly the allowed keys). Session: `{kind:"session", sessionId, studyIndex?, scheduleHash?,
appVersion, platform, build?, jsonl}` with `jsonl` = the file bytes above. study_start:
`{kind:"study_start", id, scheduleHash, nSessions, appVersion, build, platform, createdAt, protocol?}` (`protocol`
= the sealed STUDY_PROTOCOL_VERSION). Sessions carry the protocol inside `jsonl` (`session_start.study.protocol`).

### Auto-upload queue (core `UploadQueue`)

Only **study** sessions (session_start has `study`) and the `study_start` record are queued; practice sessions
never upload. A session is queued when it ends, the study_start when "Start study" seals a schedule; the queue
is flushed then, at launch, when a Spider Cloud device token is saved, and on its own backoff timer. It needs
the device token (`credentials/spider`) and native fetch (the Worker sends no CORS headers). Rules:

| Response | Action |
|---|---|
| 201, 409 `session_exists` | done (queued body deleted) |
| 401 | stays queued; the whole queue pauses until a different token is saved |
| 429 | stays queued; the whole queue pauses for `Retry-After` (default 60 s) |
| any other 4xx (400, 413, 422 `upload_rejected`, …) | **needs export**: never retried, body deleted, the session file is untouched for BHExport |
| 5xx | backoff 30 s doubling to 30 min; after 5 consecutive 5xx on a body > 500 KB: needs export |
| network error / no token | stays queued |

Client pre-check before queueing: a body with a secret pattern (`findUploadSecret`) or > 1 MiB is needs-export
without being sent. Storage: desktop `<userData>/pending-uploads/` (one 0600 file per key: `uploads/index`,
`uploads/pause`, `uploads/body/<id>`); web/iOS IndexedDB `brianharness-uploads` unless the native shell passes
`uploadKV` (iOS: Documents/pending-uploads, see IOS_DEV_NOTE_phaseD.md). Settings > Study shows
"N logs waiting to upload (reason)" and "M need Export logs"; tapping it retries now.
