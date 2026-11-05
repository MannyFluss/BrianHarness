# H1: Actor/Director Mac gaze run (for Hermes Bridge)

What H1 measures (PHASE1.md): camera permission state; that MediaPipe loads from the app bundle with no network
fetch (network log); fps, CPU and memory on Manny's 8 GB Mac; every health code seen.
**Done when:** fps median ≥ 25, CPU and memory figures present, no tracker network calls, and a cause for every failure.

The app is a separate shell, **BrianHarness Director** (`dev.mannyfluss.brianharness.director`, userData
`~/Library/Application Support/BrianHarness-Director`). It does not touch the protocol-4 BrianHarness app,
its data or its Keychain items. There is no LLM and no provider code in this shell. Actor and Director are the
built-in simulators, and the demo replies are bundled.

## 0. Artifact

| | |
|---|---|
| File (on the box) | `/workspace/actor-director/release/E7/BrianHarness Director-0.1.0-arm64-mac.zip` |
| sha256 | `f4a50c67a75a587753d262f70c57466bbe93d992b630a3a56ef5d9d6dcda7aa5` (also in `SHA256SUMS` next to it) |
| Built from | branch `actor-director`, `npm run dist:ad-mac` in apps/desktop (Electron 45.2.1, arm64, **unsigned**) |
| Bundled model | `Contents/Resources/gaze/face_landmarker.task`, 3,758,596 B, sha256 `64184e229b26…0bc9ff` (verified again in the worker before loading) |
| Bundled wasm | `vision_wasm_module_internal.js/.wasm` from @mediapipe/tasks-vision 1.2.2 |

Copy the zip to the Mac, e.g. into `~/Downloads`.

## 1. Install (Terminal, once)

```sh
cd ~/Downloads
shasum -a 256 "BrianHarness Director-0.1.0-arm64-mac.zip"      # must print f4a50c67a75a587753d262f70c57466bbe93d992b630a3a56ef5d9d6dcda7aa5
mkdir -p ~/BH-H1 && ditto -x -k "BrianHarness Director-0.1.0-arm64-mac.zip" ~/BH-H1/
APP=~/BH-H1/"BrianHarness Director.app"
xattr -cr "$APP"                                  # drop the download quarantine
codesign --force --deep -s - "$APP"               # ad-hoc sign; an arm64 Mac won't run the unsigned bundle
codesign --verify --deep --strict "$APP" && echo SIGNED_OK
sw_vers; sysctl -n machdep.cpu.brand_string hw.memsize   # record these (hw.memsize 8589934592 = 8 GB)
```

Launch it with `open`, not by running the binary from Terminal. When you run the binary from Terminal, macOS
attributes the camera permission to Terminal, so the result doesn't test the app's own permission.

## 2. Run A: passive, 120 s (required)

Close other heavy apps. Plug in the power (record if you can't). Have someone sit in front of the camera, reading
normally, for the whole run. A run with nobody in view gives `gaze.low_quality`.

```sh
open -W -n "$APP" --args --h1-report="$HOME/Desktop/h1-A.json" --h1-seconds=120
```

- On the first launch macOS asks *"BrianHarness Director" would like to access the camera*. Click **Allow**, and
  note that the prompt appeared. If it was dismissed or denied, let the run finish: the report records
  `gaze.camera_denied` and the permission state, and that is a valid H1 result. Then turn the camera on in System
  Settings › Privacy & Security › Camera › BrianHarness Director and repeat Run A as `h1-A2.json`.
- The app quits itself after about 2 min 15 s and writes the report. `open -W` returns when it quits.
- Optional independent network check (in a second Terminal, about 60 s into the run):
  `lsof -nP -i -a -c "BrianHarness" || echo NO_SOCKETS`. Expect `NO_SOCKETS`.
- Optional independent CPU/memory check during the run:
  `ps -axo pid,%cpu,rss,comm | grep -i "BrianHarness Director" | grep -v grep` (rss is in KB).

## 3. Run B: with calibration (if someone can follow the dots)

```sh
open -W -n "$APP" --args --h1-calibrate --h1-report="$HOME/Desktop/h1-B.json" --h1-seconds=120
```

The person in front of the Mac looks at each dot: 9 fit dots, then 4 check dots. The 120 s clock starts once
calibration finishes (or after 180 s at most). After that the reading view shows calibrated gaze. `ran.calibrated` in
the report says whether calibration finished.

## 4. Send back

1. `~/Desktop/h1-A.json` (plus `h1-A2.json` / `h1-B.json` if run). These are plain JSON with no frames, images or
   personal data: only counts, timings, the network log and health codes.
2. Whether the camera prompt appeared, and what was clicked.
3. The `sw_vers` / CPU / `hw.memsize` lines, on power or battery, and the optional `lsof`/`ps` outputs.
4. Anything odd you saw (Gatekeeper dialogs, a blank window, the window title).

## 5. Reading the report (`schema: bh-h1-report/1`)

| Field | H1 question |
|---|---|
| `camera.macos`, `camera.tracker`, `camera.requests` | camera permission state: macOS TCC status, what the tracker saw, every permission request the shell answered |
| `model.files`, `model.loadedSha256`, `model.bundleLoads`, `model.loadMs`, `model.delegate` | MediaPipe loaded **from the bundle**: each file served from `bh-app://app/gaze/`, with sha and GPU/CPU delegate |
| `network.requests`, `network.log` | every non-bundle request Chromium saw (all are cancelled). **Expect 0.** |
| `network.workerBlocked` | URLs the gaze worker's fetch guard refused before they reached the network. **Expect** `https://odml.pa.googleapis.com/v1/log` (see the note below) |
| `fps` | per-2 s windows after the first 5 (warm-up), with `median/p10/p90`, frames, faces, `inferMsMean` |
| `cpu`, `memory` | all app processes summed, sampled every 2 s after the first 10 s (CPU 100 = one core, memory = working set MB) |
| `health` | every gaze health code seen in the session |
| `trackerErrors`, `errors` | the worker/tracker error text, and renderer console errors and warnings |
| `done` | `fps25`, `cpuMem`, `noTrackerNetwork`, and `failures[]` (each with a `cause`) |

**About the telemetry:** @mediapipe/tasks-vision 1.2.2 has a built-in usage logger. About 60 s after start it tries to
POST to `https://odml.pa.googleapis.com/v1/log`, and there is no opt-out. The worker refuses it in-process, and it
would also be stopped by the CSP and the shell's network cancel. So `network.workerBlocked` shows the attempt, and
`network.requests` stays 0. "No tracker network calls" means no request left the app. On a run shorter than 60 s,
`workerBlocked` can be empty.

## 6. Root-cause table

| Code / failure | Likely cause | What to do |
|---|---|---|
| `gaze.camera_denied` | The macOS camera permission was denied or dismissed (`camera.macos` = denied/restricted), or getUserMedia returned NotAllowedError | Turn it on in System Settings › Privacy & Security › Camera, then rerun. `restricted` means MDM/parental controls |
| `gaze.model_missing` | A bundle file is missing (`bundleLoads` 404, `files[].present` false), the model sha256 doesn't match, FaceLandmarker failed on both GPU and CPU, or the load took more than 30 s | Re-unzip with `ditto` and check the zip sha. Send `trackerErrors` |
| `gaze.tracker_interrupted` | The camera stream ended (another app took the camera, the lid closed, or a USB camera was unplugged), or detect threw | Quit other camera apps (FaceTime, Zoom, Photo Booth) and rerun |
| `gaze.low_quality` / "face found in x/y frames" | Nobody in view, the face is partly out of frame, it's too dark or backlit, or calibration fit fewer than 4 dots | Sit centred about 50 cm away, light the face from the front, and rerun |
| `gaze.calibration_stale` | No stored calibration for this orientation (expected on Run A, which is uncalibrated), or the window was resized | Expected on Run A. Run B calibrates |
| `fps median < 25` | `inferMsMean` is high (above 35 ms suggests CPU delegate or thermal throttling), `delegate` = CPU (GPU init failed), or the Mac is on battery or in Low Power Mode | Send `model.delegate`, `inferMsMean`, and power state. Close other apps |
| `network.requests > 0` | Something other than the bundle asked for the network (`network.log` lists the URLs, all cancelled) | Send `network.log`. Counts as an H1 failure until explained |
| Blank window or Gatekeeper "damaged" dialog | Quarantine is still set, or the ad-hoc sign step was skipped | Rerun `xattr -cr` and `codesign --force --deep -s -` |

## 7. Reference: box smoke (not H1)

Linux/Xvfb, Chromium fake camera (a test pattern with no face), SwiftShader software GL, packaged layout:
the model loaded from the bundle (sha OK, 193 ms), network requests 0, telemetry refused by the worker (on the 80 s
run), fps median about 14.4 at about 49 ms/frame in software GL, faces 0 (the test pattern), CPU about 51 %, memory about 825 MB.
These numbers do not predict the Mac, which runs the GPU delegate on Metal. Only the H1 run answers the fps question.

The box can't run the macOS build. It was cross-built on Linux, and `codesign` was skipped. Everything
macOS-specific is checked only by H1: the TCC prompt, the `systemPreferences` camera status, the Metal GPU delegate, and Gatekeeper.
