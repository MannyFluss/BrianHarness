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
- `SyntheticGazeTracker` (implements `GazeTracker`) works for the Simulator. `lookAt({x, y})` (contract-v1.4) is the
  simulated gaze during calibration; `setDistCm(d)` sets the head distance it reports.

## Not in v1 (E7 inputs)
- `DecompressionStream("gzip")` needs Safari 16.4+ / iOS 16.4+, but the web build target is `safari15`. The iOS
  minimum must be ≥ 16.4, or ship the ranks uncompressed (4.4 MB) or with a JS inflate.
- The live mode's demo data (`/ad-demo/*`) is dev-server only. On device the gaze comes from the plugin.
- With the mock Actor, `followed` stays false: the mock doesn't paraphrase the hint closely enough for the follow
  metric.

## E7 addendum: IOS Dev I4 feedback (native c687996)

- **Simulator device model.** The simulator reports `iPad13,5` as a stand-in for `iPad13,4` (the study iPad). Calibration
  records are keyed per `deviceModel` + orientation, so a record saved in the simulator is never loaded on the device:
  the device uses its own `iPad13,4` key and asks for its own calibration. This is expected, not a bug.
- **lookAt (contract v1.2; v1.4 signature).** `GazeTracker.lookAt?({x, y})` is a simulator-only aid. On the device it
  is absent or a no-op. v1.4 (I5): one options object, and support is `getStatus().mode === "synthetic"`, not
  `typeof` (a Capacitor proxy is "function" for every name). Reachable only in `AD_SIM_BUILD=1` builds
  (`sim-look.ts`); core `simLookAt()` serves only the JS synthetic tracker. Errors and rejections are swallowed.
- **Tracker label.** `session_start.gaze.tracker` comes from the tracker's start mode (`getStatus()`): synthetic gives
  "synthetic", camera gives arkit/mediapipe, no tracker gives "none". It no longer reads "synthetic" whenever a tracker exists.
- **Demo URLs.** Demo snapshots and replays resolve against `document.baseURI` with the default `./ad-demo/`, so the
  iOS bundle at `ad-ios/` works without a dev server. Override with `mountAd(q, { demoBase })` or `?demoBase=`. To bundle the JSON:
  `AD_DEMO_BUNDLE=1 AD_DEMO_DIR=/workspace/ad-scratch/demo npx vite build --config vite.ad.config.ts` copies it to `dist-ad/ad-demo/`.
- **Rotation.** `LiveAdController.orientationChanged(screen, boxes?)` is wired to `resize` and `screen.orientation` change.
  It updates the screen info, loads the stored calibration for the new orientation (`restoreCalibration` for a native fit),
  and re-logs `aoi_layout`. If nothing is stored, the session runs uncalibrated (on-screen time only) and logs a health
  line with check `calibration.valid` and code `gaze.calibration_stale`. No new health code was added.
  `aoi_layout` is now also logged once per reply, when the reply is first fully laid out.
- **Demo gaze from the real layout.** R2 replay points were generated for the R2 layout, so they never landed on the
  app's paragraph boxes (every paragraph read as skipped). The live demo now generates gaze from each reply's real
  `aoi_layout` boxes with `demoReadingPath` and `SyntheticGazeTracker.play`. Each paragraph is read line by line at 238 wpm,
  with styles cycling deep, skim, skip, read. Afterwards the gaze rests on the composer. `?gaze=r2` keeps the raw R2 loop.
- **Phone: Director sheet over the chat.** While the sheet covers the chat, gaze is not attributed to paragraphs. The live
  target is null, and the tab says "chat covered by this tab (not counted)". The covered span is logged as a v1.2
  `tab_occluded` event, which is sealed-only: it appears only in tab_visible sessions and never in a blinded main log.
  In a reading window with occlusion, a paragraph with no uncovered gaze is left out of that turn's digest and
  baseline. It may have been read under the sheet, so it is never labelled "skipped". Covered time is excluded from dwell.
  An occlusion still open at the window's close is logged up to the close and continues into the next window.

## E7 addendum: IOS Dev I5 notes (native 9fc02ce), contract-v1.4

- **lookAt({x, y})** and the `mode === "synthetic"` capability: see the contract README, contract-v1.4.
- **Demo distance.** LiveBoot's simulated reader (`liveDemoGaze`, `demoReadingPath({distCm})`, the hold samples) uses
  the current calibration's `distCm` (iPhone ~30 cm; swapped with the calibration on rotation). 42 cm only when
  uncalibrated, so the demo no longer trips "Recalibrate (distance changed 40%)" on iPhone.
- **Orientation.** `apps/desktop/src/ad/orientation.ts` `watchOrientation`: screen.orientation change, matchMedia
  (landscape/portrait), window orientationchange + resize, a 1 s poll of `screen.orientation.type` (or the legacy
  `window.orientation` angle), and a native push (`status` event `orientation`, v1.4). One report per distinct
  orientation + size. A web-observed change wins over an older native push.
- **Blinded LiveBoot.** `sessionTypeFrom(q)` (`?type=blinded` or `__BH_AD__.session`) and `blindFrom(q)`
  (`__BH_AD__.blind` or `?blind=<index>/<total>&scheduleHash=<sha256>`) pass `blind {index,total,scheduleHash}` to the
  session, so session_start logs it (sealed:true, no arm in the main log). Missing or invalid: logged without it and
  a console warning; never guessed.

## Box worktree dependencies (node_modules)

Until Nov 4 2026 18:05 PT the box worktree `/workspace/actor-director/wt` had a `node_modules` of symlinks: 302 top-level
entries (and `.bin`) into `/workspace/eeg-harness-siwa/node_modules`, `@mediapipe` and `fflate` into
`/workspace/ad-scratch/deps/node_modules`, and `@brianharness/*` as relative workspace links. A change to siwa's install
would have changed this worktree's toolchain. It is now **self-contained**: a plain copy of those trees (687 MB, the
`@brianharness/*` workspace links kept relative). siwa was only read, never modified. The old link farm is kept at
`/workspace/actor-director/wt-node_modules.linked-backup` (a directory of symlinks) for rollback:
`mv node_modules ../wt-node_modules.self && mv ../wt-node_modules.linked-backup node_modules`. Still never run a plain
`npm install` here (it would rewrite the lockfile-driven tree; add a package by copying it in, as above).
