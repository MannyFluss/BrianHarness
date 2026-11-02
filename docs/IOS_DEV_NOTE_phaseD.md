# Note for IOS Dev: Phase D dogfood build (ratings, keystroke audit, blinded study, export)

**Build from ios-prep at the commit given in the report** (web bundle: `npm run build:web`, then copy
`apps/desktop/dist-web` into the Capacitor app as before). No Swift changes are needed beyond the
plugins you already have; JS matches your simulator-verified contracts.

## Plugins JS uses

- **BHExport.share({files:[{name, content, mimeType?}]})**: "Export logs" in the sidebar. Sends every
  session JSONL (`bh-session-<idx>-<startISO>.jsonl`, `application/x-ndjson`) plus the interest map
  (`<user>.json`, `application/json`). `completed:false` is treated as a cancel (no error shown).
- **BHExport.saveToDocuments({files:[{name, content}]})**: called automatically at every session end
  (New chat, coming back after 20+ min away) with that session's JSONL, ratings included. Names are
  stable per session (`bh-session-03-20261102T220612Z.jsonl`), so a re-save overwrites only its own file.
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

## Export contract (what the files contain)

One JSONL per session: `session_start` (with `study: {id, index, total, scheduleHash}` in study
sessions, never the mode), `director_turn` (plan/stateNote sealed in study sessions), `user_turn`
(features incl. `typing.latencyToFirstKeyMs`, `typing.latencyToSubmitMs`, `typing.gap*`, `typing.dictated`,
`typing.pasted`, `typing.autocorrections`, `typing.predictive`, `typing.timingReliability`; `keyGaps` =
raw inter-key gaps in ms; never key identities), `rating` (`{scope, turn, value, shownAt, answeredAt,
dismissed, reason?, hooked?, blindGuess?}`), `interest_update`, `final` (session top-1/top-3 labels),
`session_end`. Desktop analysis: `npm run export-ratings -- <dir> -o ratings.csv`.
