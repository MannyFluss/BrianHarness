# EEG Harness

An adaptive "AI Director" chat bot that learns what draws you in from your typing (EEG later).
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

![screenshot](docs/screenshot.png)

## Quick start

```bash
npm install            # also downloads the Electron binary (postinstall)
npm test               # builds core+sim, runs unit + sim tests
npm run sim            # simulated personas vs the Director (offline mock model)
npm run desktop        # build and launch the desktop chat app
```

Shortcuts in the app: `Enter` send, `Shift+Enter` newline, `Ctrl/Cmd+H` Director HUD, `Ctrl/Cmd+B` sidebar.

## Using a real model (costs money, opt-in)

```bash
EEG_BACKEND=openai EEG_API_KEY=sk-... EEG_MODEL=gpt-4o-mini npm run desktop
# any OpenAI-compatible endpoint: EEG_BASE_URL=https://openrouter.ai/api/v1  (or a local LM Studio/Ollama URL)
```
Without `EEG_BACKEND=openai` the app always uses the free offline mock.

## Packaging for macOS (Apple Silicon)

On the Mac: `npm install && npm run dist:mac -w @eeg/desktop` -> `apps/desktop/release/*.dmg` (unsigned).
For a signed/notarized build, set a Developer ID identity and notarize credentials in
`apps/desktop/electron-builder.yml`. An app icon (`build/icon.icns`) is still TODO.
