# E6: Director tab v1 (notes)

## What it is
- A separate web entry: `apps/desktop/ad.html` → `src/ad/main.ad.tsx`, built with
  `vite --config vite.ad.config.ts --mode web` (dev at :5175) or `vite build --config vite.ad.config.ts --mode web`
  (→ `dist-ad/`). It wraps the protocol-4 `vite.config.ts` without changing it. Protocol-4's `main.web.tsx` and `App`
  never import `src/ad/`. CSP: `connect-src 'self'` (mock backends run in-process; the rank file is a bundled asset).
- `src/ad/controller.ts`: `LiveAdController` (real `ActorDirectorSession`, a `GazeTracker`, DOM paragraph boxes,
  composer taps → drift anchors, key TIMES only) and `staticController(view)` for demos and screenshots.
  `AdView = VisibleView | BlindedView`. A BlindedView has no tab, pending note, live gaze or events by type, and its
  chat is copied as `{id, role, text}` only. `buildTabModel` is never called for a blinded session.
- `src/ad/DirectorTab.tsx`: three layers. Top: summary, hypotheses with confidence bars and intent, with changes
  highlighted for 5 s. Middle: the share bar (tap for the breakdown and the exact hint), the session line with a
  sparkline, and note cards: considering, no_note (the Director's reason), blocked (rail code, "not the Director's
  judgment"), injected or held back (hint, kind, move, evidence), dropped, then the outcome. Bottom: a 10 Hz live
  minimap, target, tracking quality and the event ticker.
  On ≥ 768 px it's a column (w-96); on phones it's a swipe-over panel from the right.
- `src/ad/AdApp.tsx`: margin marks on replies that used a note (tap → card). A selected card highlights its evidence
  paragraphs (`a<k>.p<n>` → `[data-msg][data-p=n-1]`). A "Director note waiting · goes with Send" chip, and the
  injection line from card to composer (`InjectionLine`). Under Reduce Motion the line fades instead of travelling
  (`ad.css` has a `prefers-reduced-motion` block too).
- Reading window: it closes at the first composer keystroke after the reply (or at Send). Then closeTurn →
  observeReading → `beginDirector()`, so the note waits at the composer. `ActorDirectorSession.peekPending()` shows
  the pending call to the tab without logging; it returns null for blinded sessions.
- Keystrokes: `KeystrokeTimes` keeps times only, never the key, and is never logged in v1 (see the README v2 backlog).

## Interface for IOS Dev (I4)
Import from `@brianharness/core/actor-director/browser` and `apps/desktop/src/ad/`:
- `CalibrationFlow` (React) with props `{ screen: ScreenInfo, tracker: GazeTracker | null, store: CalibrationStore | null,
  orientation?, paraHeightPx? = 72, onDone(rec: CalibrationRecord | null), stage?, demo?, simulateLook?, timing? }`.
  The screens are intro → dots → result, with Use / Recalibrate / "Continue on on-screen time only".
  - `onDone(null)` means skip (on-screen time only, no record).
  - `rec.mode` is `"gaze"` or `"onscreen_only"`.
- `runCalibration({ tracker, screen, orientation?, paraHeightPx, now?, wall?, sleep?, timing?, onDot?, lookAt?, signal? })`
  is the same pass with no UI. It drives `tracker.calibrate` begin → target{targetId,t0,t1} ×13 (×9 on iPhone) → end.
  - It feeds `addListener("gaze")` batches into `CalibrationRun` and returns `{ record, ok, words, recommend, code }`.
  - fit `"core"`: the plugin emits `cal:false` screen-point samples and core fits the affine.
  - fit `"native"`: the plugin returns `model` at end, and `restoreCalibration({orientation, model})` restores it later.
- `CalibrationStore(await AdStorage.open(kv))` has `.save(rec)`, `.load(model, orientation)`, `.orientations(model)` and
  `.clear()`. The key is `ad/meta/cal/<deviceModel>/<orientation>`. `primaryOrientation("iPad13,4") === "landscape_left"`.
- `calibrateBatch(samples, rec, screen.webview)` applies a core fit (screen pt → web CSS px, `cal:true`).
- `gazeOptionsFromCalibration(screen, rec)` → `{ ppd, viewport, distCm }`. The calibration distance gives px/deg
  (ruling 3).
- `calibrationStatus(rec, {yaw, distCm, orientation, t})` reports staleness (15° yaw, 25% distance, or a different
  orientation), as `gaze.calibration_stale`.
- `LiveAdController.open({ sessionType, arm, sessionId, userId, actor, director, counter, kv, tracker, screen,
  calibration, consent, blind?, now? })` + `<AdApp store={controller} />` runs the whole mode. For the counter, use
  `loadO200kBrowser()`; it reads `ad/o200k_base.tiktoken.gz` from the app bundle.
- `SyntheticGazeTracker` (implements `GazeTracker`) works for the Simulator. `lookAt(x, y)` is the simulated gaze
  during calibration.

## Not in v1 (E7 inputs)
- `DecompressionStream("gzip")` needs Safari 16.4+ / iOS 16.4+, but the web build target is `safari15`. The iOS
  minimum must be ≥ 16.4, or ship the ranks uncompressed (4.4 MB) or with a JS inflate.
- The live mode's demo data (`/ad-demo/*`) is dev-server only. On device the gaze comes from the plugin.
- With the mock Actor, `followed` stays false: the mock doesn't paraphrase the hint closely enough for the follow
  metric.
