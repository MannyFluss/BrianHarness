# IOS Dev note: in-app bug report (branch `feedback`)

The web side is done and needs **no native change to work**. The Report row in the sidebar and Cmd+Shift+R (on an
iPad keyboard) open the sheet. Sending uses the existing UploadQueue and Spider Cloud device token. A report that
can't be sent is shared as one `.json` through the existing **BHExport** `share` call, the same path as "Export
logs". The report format is in docs/FEEDBACK_REPORT_SCHEMA.md and the server contract in brianharness-worker
docs/FEEDBACK.md.

Two optional native asks:

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

## What the web does natively (FYI, no change)

- **BHExport `share({files:[{name, mime:"application/json", data}]})`** is used for the export fallback. The file
  name is `bh-feedback-YYYYMMDD-HHMM-<id8>.json`.
- Every native plugin call is wrapped. A rejection is recorded as an `error` event with `plugin`, `method` and
  `code`. Results and arguments aren't recorded.
- Secrets never leave the device in a report. Tokens, nonces, `identityToken` and `appleUser` are redacted.
