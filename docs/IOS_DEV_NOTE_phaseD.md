# Note for IOS Dev: Phase D dogfood build (ratings, keystroke audit, blinded study, export)

**Build from ios-prep at the commit given in the report** (web bundle: `npm run build:web`, then copy
`apps/desktop/dist-web` into the Capacitor app as before). No Swift changes are needed beyond the
plugins you already have; JS matches your simulator-verified contracts.

## Plugins JS uses

- **BHExport.share({files:[{name, content, mimeType?}]})**: "Export logs" in the sidebar. Sends every
  session JSONL (`bh-session-<idx>-<startISO>-<tag>.jsonl`, `application/x-ndjson`) plus the interest map
  (`<user>.json`, `application/json`). `completed:false` is treated as a cancel (no error shown).
- **BHExport.saveToDocuments({files:[{name, content}]})**: called automatically at every session end
  (New chat, coming back after 20+ min away) with that session's JSONL, ratings included. Names are
  unique and stable per session (`bh-session-03-20261102T220612Z-5Zab12.jsonl`; `<tag>` = last 6
  alphanumerics of the sessionId), generated in JS, so a re-save overwrites only its own file and two sessions
  started in the same second (e.g. a quick reissue of the same index) never collide. Native code: write the
  name as given; no collision handling needed.
- Names are sanitized in JS before every call (plain, non-empty, no leading dot, no `/` or `\`, unique
  within the call), so EINVAL should never happen; if it does it is our bug. EINVAL / EWRITE / EPRESENT /
  ESHARE are shown as friendly messages. A failing saveToDocuments only logs a warning.
- **BHKeychain**: the study schedule is stored under the raw key **`study/phaseD/schedule`** (credentials
  stay under `credentials/*`). -34018 (`code:"-34018"`, `data:{status:-34018}`) means the study cannot
  start ("Study not started: ..."; the session runs normally, unblinded, with no study fields); API keys
  keep the existing in-memory fallback. `code:"EINVAL"` with no data is rethrown as a programming error
  and never triggers the fallback. The schedule is never shown in the UI; the dev-only hash lives on
  `window.__bhStudy.hash()` when `localStorage["bh.debug"]="1"` (Safari Web Inspector).

## Please verify on a real device (TestFlight)

Keyboard events in WKWebView (what JS expects; the simulator's Mac keyboard does not count):

| Input | Expected events | Logged as |
|---|---|---|
| soft keyboard letter | keydown key "Unidentified"/229, beforeinput insertText (1 char) | soft-keyboard |
| hardware keyboard (iPad) | keydown with a real key, insertText | hardware-key |
| autocorrect on space | beforeinput **insertReplacementText** (or delete + insert) | autocorrect |
| predictive bar pick | unkeyed insertText of one word + space | predictive |
| dictation | **insertFromDictation**? or unkeyed multi-word insertText, or marked-text composition | dictation |
| Japanese/Chinese IME | compositionstart, insertCompositionText..., compositionend | composition (not counted as deletions) |
| paste | insertFromPaste | paste |
| undo shake | historyUndo | delete or insert by length change |

What to check, with Safari Web Inspector on the device, `localStorage["bh.debug"]="1"`, HUD open:
1. Type a sentence on the soft keyboard. HUD: "to first key", "to submit", "key gap (median)" are filled,
   timing reliability 100%, no flags.
2. Accept an autocorrection and a predictive word. HUD flags: "autocorrect ×n" / "predictive ×n"; timing
   reliability < 100%.
3. Dictate a sentence (mic key). HUD flag "dictated". **Tell us which inputType arrived** (log
   `e.inputType` on the textarea in the inspector): this decides whether the multi-word heuristic is needed.
4. Paste text. Flag "pasted".
5. Turn probe ("How absorbed are you right now?") appears on about 1 in 5 replies (never the first);
   typing dismisses it.
6. New chat after a few replies: the session card (1-5, "What hooked you?") appears; after Done, a
   `bh-session-*.jsonl` file is in Files > On My iPhone > (app) Documents.
7. Export logs: share sheet opens with all session files; dismissing it shows no error.
8. Sidebar "Start study" (tap twice): on a signed build it starts (sidebar shows "Study 1/10"); on an
   unsigned simulator build it reports -34018 and stays off. HUD then shows "Study session i/10" and hides
   the interest map / plan.

## Interest extractor (new in this build: llm-extract, prompt v2 by default)

- With **Ollama Cloud / OpenAI / Anthropic** selected **and an Ollama Cloud API key saved**, sessions tag
  topics with llm-extract (`gemma4:cloud`, prompt **v2**, rank lead) every 6th user turn, through the same
  CapacitorHttp `fetchImpl` as the backends (POST `https://ollama.com/api/chat`, Bearer key). Mock, a LAN
  Ollama without a `:cloud` model, or OpenAI/Anthropic without an Ollama Cloud key -> keyphrase-idf (no call).
  A failed / refused call keeps keyphrase-idf labels; the session never breaks.
- Non-study sessions: one hard cap of **50 extractor calls** shared on the device (study sessions use a per-session budget, see Freeze build (E)) (settings KV key
  `llm-extract/calls`). Model picker -> "interest extractor prompt: v2 / v1 (rollback)"; the line below it
  names the tagger the next session uses.
- Each session JSONL now ends with `{type:"final", top1, top3, top3Ids, tagger, extractorPromptVersion?, model?}`
  just before `session_end`, and `interest_update` carries the running `top1`. No study mode in either.
- To check on device: pick Ollama Cloud with a key, send 6 replies, end the session; the Files copy of
  `bh-session-*.jsonl` should contain one `final` line with `"extractorPromptVersion":"v2"`.

**Extractor outcome + fallback warning (Nov 2 2026).** `final` and `session_end` now carry the extractor's real
per-session outcome: `extractorCalls {attempted, ok, failed, capped}`, `effectiveTagger` (`llm-extract` only if
at least one call returned an answer, else `keyphrase-idf`), `fallback` and `fallbackReason`
(`no_key` | `mock_or_local` = the app never built an extractor; `cap_reached` | `call_failed` | `offline` = built,
but no call answered; `not_due` = the session ended before the first extractor turn, no warning). In study
sessions the HUD and a small banner above the composer (`data-testid="extractor-warning"`) show e.g.
"Interest AI unavailable this session (cap reached)" from session start (no key / mock) or from the failing
turn; it is identical in adaptive and baseline sessions (the tagger runs in both), so it reveals no mode.
Electron and the sidecar print it to stderr once per session/reason. Exporter CSV columns: `effective_tagger,
extractor_fallback, extractor_fallback_reason, extractor_calls_{attempted,ok,failed,capped}`. iOS: nothing to
do beyond rebuilding; the banner is in the shared web UI. Screenshots (offline, fake Ollama returning 503
to every extractor call): `docs/screenshot-fallback-banner-iphone.png`, `docs/screenshot-fallback-banner-desktop.png`
(`apps/desktop/scripts/fallback-banner-shot.mjs`).

## Export contract (what the files contain)

One JSONL per session: `session_start` (with `study: {id, index, total, scheduleHash}` in study
sessions, never the mode), `director_turn` (plan/stateNote sealed in study sessions), `user_turn`
(features incl. `typing.latencyToFirstKeyMs`, `typing.latencyToSubmitMs`, `typing.gap*`, `typing.dictated`,
`typing.pasted`, `typing.autocorrections`, `typing.predictive`, `typing.timingReliability`; `keyGaps` =
raw inter-key gaps in ms; never key identities), `rating` (`{scope, turn, value, shownAt, answeredAt,
dismissed, reason?, hooked?, blindGuess?}`), `interest_update`, `final` (session top-1/top-3 labels),
`session_end`. Desktop analysis: `npm run export-ratings -- <dir> -o ratings.csv`.

**Researcher blocker fixes (Nov 2 2026, after build 1438).** Rebuild; nothing native changes.
- **Build 1438 was practice.** On launch the app discards a study schedule sealed without `protocol` (or with
  `protocol` < 2) plus the study progress, so tap "Start study" again: a new schedule and hash are sealed in
  BHKeychain `study/phaseD/schedule` with `"protocol":2`. Session files in Documents and the pending-upload
  queue are left alone. Study sessions log `study.protocol`; those without it are practice and are excluded.
- **Index reissue.** A study session counts only with >= 8 replies and an answered end-of-session rating.
  Otherwise the next session repeats its index (same mode) and logs `reissueOf: <previous sessionId>`.
- **File names.** Study sessions save as `bh-session-<idx>-<startISO>-<tag>.jsonl` (e.g.
  `bh-session-03-20261102T220612Z-5Zab12.jsonl`); non-study sessions have no index
  (`bh-session-20261102T223724Z-6Zq7xw.jsonl`). The 1438 sample files in
  `bh-phaseD-sample/` have no index because they are **non-study sessions** (no `study` in session_start, plan
  logged): the study was not started (or the Keychain failed) when they were recorded.
- `user_turn.features` gains `extractor.enthusiasm`, `extractor.top1_turns`, `extractor.n_labels` (logging only).
- Field reference: `docs/PHASE_D_LOG_SCHEMA.md`. Leak check: `node tools/phaseD/check_blinding.mjs <dir>`.

## Freeze build: keyboard header + unique file names

- Keyboard up on iPhone: the header no longer slides under the status bar. `.eeg-app` is pinned to the visual
  viewport (`position: fixed`, `top = visualViewport.offsetTop`, `height = visualViewport.height`), html/body
  never scroll. Works with any Capacitor Keyboard resize mode; recommended in `capacitor.config.ts`:
  `plugins: { Keyboard: { resize: "native", resizeOnFullScreen: true } }`, `ios.contentInset: "never"`.
  Emulated check: `apps/desktop/scripts/keyboard-shots.mjs` -> `docs/screenshot-iphone-keyboard.png`,
  `docs/screenshot-iphone-keyboard-native.png`. Please confirm on a device (focus the composer, type, scroll the chat).
- Session file names now carry a 6-char session tag (above), so `saveToDocuments` collisions can't happen.

## Spider Cloud preset

New provider row "Spider Cloud" (details in `IOS_PORTING.md` → Spider Cloud). On device: set the `bhd_` device
token once via model picker → Spider Cloud → key (Keychain `credentials/spider`). It needs native fetch (no CORS)
and works only after Manny deploys the Worker; until then it fails with a clear message and the study extractor
falls back (banner "Interest AI unavailable this session (…)"). Nothing to add natively beyond BHStream.

## Freeze build (E): auto-upload, manual redo, extractor budget

- **Auto-upload.** Ended study sessions and the study_start record (with `protocol`) are POSTed to
  `<Spider Cloud URL>/v1/sessions` with the `bhd_` device token, through the same native `fetchImpl`
  (CapacitorHttp). Practice sessions never upload. Retry rules and the "N logs waiting to upload" /
  "M need Export logs" row: `PHASE_D_LOG_SCHEMA.md` → Auto-upload queue. The Documents session file
  (saveToDocuments) is written first and never removed, so BHExport always has every log.
- **Queue storage (native contract, optional).** By default the queue lives in the WebView's IndexedDB
  (`brianharness-uploads`). To keep it in `Documents/pending-uploads/` instead, pass
  `uploadKV` to `createInProcessTransport` in `nativeTransportOptions`: a `KeyValueStore`
  (`get/set/remove/keys`) over Capacitor Filesystem, one UTF-8 file per key,
  file name = `encodeURIComponent(key)` (keys: `uploads/index`, `uploads/pause`, `uploads/body/<id>`), mark
  the folder excluded from iCloud backup if you prefer. Also pass `appVersion` (CFBundleShortVersionString)
  and `build` (CFBundleVersion) so the Worker rows say which TestFlight build sent them.
- **Queue storage is now wired (freeze, after E).** If `BHExport.kvGet` exists, `nativeTransportOptions`
  uses BHExport's kv API as the upload KV (Documents/pending-uploads, one file per `encodeURIComponent(key)`):
  `kvGet({key}) → {value: string|null}`, `kvSet({key, value})`, `kvRemove({key})`, `kvKeys({prefix?}) → {keys}`.
  Older shells (no kv*) keep IndexedDB. `window.__BH_APP_INFO__ = {appVersion, build}` injected at document
  start supplies the Worker's `appVersion` / `build` (`build` may be a number; it is sent as a string).
  `BHExport.appInfo()` is not called by JS.
- **Study progress in the Keychain (freeze, after E).** The progress (enabled, next index, last session,
  pending redo; never the mode) moved from WebView storage to BHKeychain key **`study/phaseD/progress`**,
  next to `study/phaseD/schedule`, written with a read-back check. First launch of this build migrates the old
  copy and removes it. If WebView storage was evicted before that (schedule in the Keychain, progress gone),
  the next index is rebuilt from the session logs left and the pending-uploads ledger in Documents and the next
  `session_start` logs `progressRecovered: true`; if nothing is left, a red "Study progress lost; contact the
  Researcher" notice blocks study sessions until Settings → "Set next study session…" (`SET NEXT N`). Please
  verify on device: start the study, run a session, delete website data (or reinstall keeping the Keychain),
  relaunch: the study must continue at the right index (Settings shows "Study N/10"), never at 1.
- **Manual redo.** Settings → "Redo a study session…": pick N (only already assigned), optional reason
  (≤ 120 chars), type `REISSUE N`. The next study session reuses index N; `session_start` logs
  `reissueOf:"manual"`, `manualReissue:true`, `reissueReason?`. Pending redo shows "Next study session redoes N · cancel".
- **Validity.** A session counts as rated only if its **last** session rating has a value (a later dismissal undoes it).
- **Extractor budget.** Study sessions: 10 logical calls per session, 1 retry each, 20 HTTP attempts max; no
  device-wide counter. Practice sessions keep the device-wide 50-call counter (`llm-extract/calls`).
