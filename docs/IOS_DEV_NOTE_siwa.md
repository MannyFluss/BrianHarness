# IOS Dev note: Sign in with Apple, web side (branch `siwa`)

Web branch `siwa` (off ios-prep `2fa0bca`, the freeze behind TestFlight 20261102.1604). Native side:
brianharness-ios `siwa` @ `b767fa6` (BHAppleAuth). Worker contract: brianharness-worker `docs/APPLE_AUTH.md`
(e2cf8bc), which this follows wherever it and `/workspace/bh-appleauth-contract.md` differ.

**Gate:** DirectorBot's conditions apply. The study flow stays identical to the freeze build, and the Researcher
runs the blinding check before any build with this branch is uploaded.

## What the web expects from native

- Plugin jsName **`BHAppleAuth`**, detected with `Capacitor.isPluginAvailable("BHAppleAuth")`. On a shell without
  it, nothing new appears and the app behaves like the freeze build (pasted token only).
- `isAvailable()` gates everything. `{available:false}` means no screen and no sidebar row.
- `makeNonce({})` is called with no `length`, so the default is 32 bytes, which gives 43 chars. The web rejects any
  nonce outside 16–256 chars and never calls `signIn` with it.
- `signIn({nonce})` is called with the RAW nonce. The web sends the RAW nonce plus `identityToken` to
  `POST /v1/auth/apple`. Native hashes it into the request, so the web never hashes.
- `credentialState({user})` is called once per launch, and only when the stored token came from Apple.
- **Rejection codes:**
  - `ECANCELED` is silent, and the screen stays as it was.
  - A second tap while a sign-in is in flight returns the same promise, so only one sheet opens (the `EBUSY` case).
  - `EFAILED`, `EINVALIDRESPONSE`, `ENOTHANDLED` and `ENOTOKEN` show "Sign in failed, try again."
  - `ENOTINTERACTIVE` and `EPRESENT` show "Couldn't show Sign in with Apple. Try again."
  - `EUNKNOWN` shows "unavailable on this device" and points to the pasted token.
  - `ESTATE` from credentialState keeps the token.
- `deviceLabel` is `iPhone` or `iPad`, taken from the platform the in-process transport already detects. Anything
  else sends `ios`.

## Storage (BHKeychain, no native change)

Everything lives in one Keychain item, `credentials/spider`. That is the slot a pasted device token uses, so chat,
the extractor, the model list and the upload queue read the Apple token with no changes:

```json
pasted: {"type":"api_key","key":"bhd_…"}
Apple:  {"type":"api_key","key":"bhd_…","source":"apple","expiresAt":"<ISO>","appleUser":"<Apple user id>"}
```

The token and `expiresAt` sit in one JSON value, so a refresh writes both at once. The Apple identity token and
the raw nonce are held in memory only, until the request succeeds or the identity token expires. They are never
persisted.

## How the screen behaves

- **Launch screen ("Connect to Spider Cloud"):** a bottom sheet on iPhone and a centered card on iPad and desktop. It
  shows **Sign in with Apple** and **Skip**, and the ✕ or a backdrop tap also dismisses it. It is decided **once
  per launch**. It appears only when all of these are true:
  - BHAppleAuth is available.
  - The Spider Cloud slot is empty after the launch checks.
  - The first session has started.
  - The current session is **not a study session**.
  - There are no user turns yet, nothing has been typed, and no rating card is open.
- **Study sessions:** the screen never appears over a study session, and never mid-session. It would land inside the
  study session's first-turn reply-latency window. The sidebar row is always there instead. The session starts at
  launch exactly as before; the sign-in check runs alongside it and never delays it.
- **Sidebar row** (above `MODEL: …`, below the Study and upload rows):
  - "Sign in with Apple".
  - "Sign in with Apple (replaces device token)" when a pasted token is stored.
  - "Sign in with Apple · try again" after an error.
  - "Signed in with Apple" once signed in.
  - The Spider Cloud row's auth line reads "Sign in with Apple (this device)". The KEY chip and the pasted
    token are unchanged, and FORGET KEY deletes whichever token is in the slot.
- **Success:** the token is saved, then the upload queue is flushed, the same as after pasting a token in the KEY
  dialog. "N logs waiting to upload" should count down.
- **403 `apple_account_not_allowed`** (Manny's first real sign-in): shows "Sign in with Apple isn't enabled for
  this account yet." with **Try again**. It is never retried automatically. Try again re-posts the same identity
  token and nonce while the identity token has more than 90 s left (Apple tokens last about 10 min), so no second
  Apple sheet appears. After that it asks Apple again with a fresh nonce. If the Worker answers
  `apple_token_expired` to a re-posted token, the same tap gets one fresh Apple credential.
- **Other sign-in errors:**
  - 429 shows "too many sign-ins today".
  - 502 shows "try again shortly".
  - 503 `apple_signin_disabled` points to the pasted token.
  - `apple_token_not_yet_valid` asks the user to check the date and time.
  - Any other 4xx shows "Sign in failed (code)".
  - A network error shows a quiet "Couldn't reach the server…". Nothing loops.
- **Launch checks, once per process:**
  - If the stored Apple token is within 14 days of `expiresAt`, the app calls `POST /v1/auth/refresh` and writes
    the new token and expiry together.
  - It then runs `credentialState({user})`.
  - `revoked` or `notFound` clears an **Apple-issued** token only. A pasted token is never cleared.
  - A network error on refresh keeps the current token, and the next launch tries again.
- **401 `session_expired` / `invalid_token`** on the refresh call or on any authed route (chat, models, upload) that
  carried the Apple token: the Apple token is cleared, the row shows "…Sign in again.", and sign-in is offered (one
  tap). It never runs automatically and never mid-session. The upload queue keeps its own existing behaviour: it
  pauses as "auth" and resumes after a token is saved.
- **Rotation mid-session:** a refresh kills the old token at once. A fetch wrapper swaps an Authorization header that
  still carries a token this launch rotated, so a session that started before the refresh, and its extractor, keep
  working. The wrapper rewrites nothing else and passes every response and body through unchanged.

## What did not change

`packages/` (study scheduling and progress, session/log records, upload queue and body, extractor), `tools/`,
`adapters/`, the Rating, StudyData and telemetry components, and the Keychain, BHExport and stream adapters. The
only touched source files are `App.tsx` (the launch-screen mount), `Sidebar.tsx` (the row), `transport/in-process.ts`
(the plugin option, the fetch wrapper, the `appleAuth` bridge member, the auth line, and a slot-changed note on paste
or forget), `transport/native.ts` (plugin detection) and `transport/types.ts`. The new files are
`transport/apple-auth.ts`, `components/AppleSignIn.tsx` and `test/apple-auth.test.ts`. Tokens, the Apple user id,
the identity token and the nonce never reach session logs, upload bodies or the console. The tests check all three.

## Device checks (please)

1. Fresh install with practice, no study: the launch sheet appears. Tap Sign in with Apple and you get "not enabled
   yet" (until Manny runs `admin.mjs apple-allow`). Then Try again with no second Apple sheet, then Skip.
2. With a study session running at launch: no sheet. Sign in from the sidebar row instead.
3. After the allowlist: sign in, and the waiting logs upload without a tap.
4. Confirm that presenting the Apple sheet does **not** fire `visibilitychange: hidden` in the WKWebView. A 20-minute
   away period starts a new chat, so a long stay on the sheet would otherwise count as "away".
5. Pasted token still works: KEY, then SAVE, and the row reads "device token (this device)". It is not refreshed and
   not cleared on launch.

Screenshots (fake plugin, Worker mocked by Playwright): `docs/screenshot-siwa-launch-{iphone,desktop}.png` and
`docs/screenshot-siwa-not-enabled-{iphone,desktop}.png`, from `apps/desktop/scripts/siwa-shots.mjs`.
