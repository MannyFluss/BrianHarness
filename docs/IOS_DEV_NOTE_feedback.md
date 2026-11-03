# IOS Dev note: in-app bug report (branch `feedback`)

The web side is done and needs **no native change to work**. The Report row in the sidebar and Cmd+Shift+R (on an
iPad keyboard) open the sheet. Sending uses the existing UploadQueue and Spider Cloud device token. A report that
can't be sent is shared as one `.json` through the existing **BHExport** `share` call, the same path as "Export
logs". The report format is in docs/FEEDBACK_REPORT_SCHEMA.md and the server contract in brianharness-worker
docs/FEEDBACK.md.

Two optional native asks, and one question to check on a device (section 3):

## 1. Shake to report (optional)

A shake gesture needs native code. Web exposes a hook:

```ts
window.__bhReport?.({ source: "shake" })   // opens the sheet; payload.header.trigger = "shake"
```

Suggested implementation: override `motionEnded(_:with:)` on the bridge view controller (or a `UIWindow`
subclass). On `.motionShake`, run:

```swift
override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
    guard motion == .motionShake else { return super.motionEnded(motion, with: event) }
    bridge?.webView?.evaluateJavaScript("window.__bhReport && window.__bhReport({source:'shake'})")
}
```

- The hook is idempotent: a second call while the sheet is open does nothing new.
- It doesn't start a chat or touch study state.
- When the hook is missing (an older web bundle), the call is a no-op.
- Please keep UIKit's default "Undo typing" shake alert off (`applicationSupportsShakeToEdit = false`) so the two
  don't collide.

## 2. App identity (optional)

When present, the report's `app` block reads `window.__BH_APP_INFO__`:

```js
window.__BH_APP_INFO__ = { appVersion: "0.4.0", build: "20261103.0940", bundleId: "com.manny.brianharness" }
```

You could inject it as a `WKUserScript` at document start. The values are CFBundleShortVersionString,
CFBundleVersion and the bundle id. All of them are optional. Without them, the report still carries `commit` (the
web build's git commit, baked in at build time), the device (`iPhone`/`iPad`), the OS and the orientation.

## 3. Question: does the BHExport share sheet hide the page? (please check on a device)

The Researcher wants to know whether presenting the share sheet for the export fallback fires `visibilitychange`
(document `hidden`) or a window `blur` in the WKWebView. That's `BHExport.share`, a `UIActivityViewController`
shown over the bridge view controller. "Save to Files", AirDrop and Mail are all in-process extensions. "Open in
<other app>" switches apps.

The repo has no native source, so this can't be settled from the web side. The web side is safe either way:

- The app's only away rule is App.tsx's "hidden for ≥ 20 min (`AWAY_MS`) → session rating, then a new session".
  Time hidden between `feedback_open` and `feedback_closed` no longer counts (`feedback/away.ts`), up to
  `FEEDBACK_AWAY_CREDIT_MAX_MS` (10 min) per hidden span: a sheet left open in the background still ends the session
  (3 h hidden = 2 h 50 min away). The sheet is not auto-closed.
- Nothing listens to window `blur` for accounting. A composer blur is only a logged typing event and isn't a feature.

What would help, on an iPhone and an iPad:

1. Make the Report send fail (the Worker isn't deployed, so the export fallback runs now), then Send.
2. Pick "Save to Files", then cancel the sheet. Repeat with "Open in…" another app, then come back.
3. In Safari Web Inspector, log `document.visibilityState` and `visibilitychange`, `pagehide`, `blur` and `focus`
   events, plus `applicationWillResignActive` / `DidEnterBackground` if handy.

If any of them fire, tell us which. No code change is needed, and `pagehide` while the sheet is open already closes
it (`feedback_closed`).

## What the web does natively (FYI, no change)

- **BHExport `share({files:[{name, mime:"application/json", data}]})`** is used for the export fallback. The file
  name is `bh-feedback-YYYYMMDD-HHMM-<id8>.json`.
- Every native plugin call is wrapped. A rejection is recorded as an `error` event with `plugin`, `method` and
  `code`. Results and arguments aren't recorded.
- Secrets never leave the device in a report. Tokens, nonces, `identityToken` and `appleUser` are redacted.
