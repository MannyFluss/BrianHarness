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

A study session is **valid** when it has >= 8 `user_turn` records **and** a session-scope `rating` with a
`value` (1..5; a dismissed card does not count). When the previous study session is invalid, the next session
gets the **same index** (so the same mode) and logs `reissueOf: <previous sessionId>` in `session_start`.
`reissueOf` is a **top-level** `session_start` field, omitted when the session is not a reissue. A reissue never
advances the index; the index never exceeds 10, and after 10 valid sessions the study is finished (`assign()`
returns null: later sessions are ordinary non-study sessions). Dedupe on the last valid session per index.
CSV column: `reissue_of`. Reissued sessions share `bh-session-<idx>-…`, but the `<tag>` keeps their file names
distinct even within the same second, so no file overwrites another (`exportFiles()` also suffixes `-2` as a
last-resort guard). Native code needs no collision handling.

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
  reissueOf?: string }                                     // study only: the invalid previous session

// director_turn
{ type: "director_turn", t: string, turn: number /*0-based, = user replies so far*/, text: string, backend: string,
  genMs: number, firstTokenMs?: number, streamed?: true,
  sealed?: true,                                           // study sessions: no plan, no stateNote
  plan?: { turn: number, mode: "explore"|"exploit"|"relax" /*pacing*/, topic: string, altTopic?: string, style: string, reason: string, scout?: boolean },
  stateNote?: string }                                     // non-study only

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
  protocol: number }                                       // local record; see the upload note
```

No record carries API keys, device tokens or the Authorization header.

## Upload body (`POST /v1/sessions`)

See the Worker's `docs/SESSIONS_API.md` (allowlist as of Worker f71cc53; builders: core `sessionUploadBody` /
`studyStartUploadBody`, which emit exactly the allowed keys). Session: `{kind:"session", sessionId, studyIndex?, scheduleHash?,
appVersion, platform, build?, jsonl}` with `jsonl` = the file bytes above. study_start:
`{kind:"study_start", id, scheduleHash, nSessions, appVersion, build, platform, createdAt}`. The Worker rejects
unknown fields, so `protocol` is **not** in the study_start upload body until the Worker allowlists it; sessions
carry it inside `jsonl` (`session_start.study.protocol`).
