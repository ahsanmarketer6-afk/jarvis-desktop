# JARVIS — Agentic AI Desktop Assistant

Premium Electron desktop application — an agentic operating layer for your laptop.
Phase 1: complete UI foundation (10 tabs, mock data) + auto-update system.

## Design

Pure-black HUD theme with mint-green glow accents (IRIS-style):
- **Fonts:** JetBrains Mono (labels/UI), Rajdhani (display headers)
- **Boot:** "INITIALIZE VAULT" security screen with decrypt progress
- **Chrome:** top nav + context sidebar, scanlines, dashed HUD frames

## Run (development)

```bash
npm install
npm start
```

## Build Windows installer (.exe)

```bash
npm run dist
# output: dist/JARVIS Setup <version>.exe + latest.yml
```

## Auto-update system

- `electron-updater` checks GitHub Releases on startup (packaged builds only)
- Settings → Updates: check / download with live % progress / restart-to-install
- Requires the `publish` config in `package.json` to point at your repo:

```json
"publish": { "provider": "github", "owner": "YOUR_GITHUB_USERNAME", "repo": "YOUR_REPO" }
```

## CI/CD

`.github/workflows/build.yml` builds the NSIS installer on every push to `main`
and publishes `.exe` + `latest.yml` to GitHub Releases automatically.

## Project structure

```
main.js                 Electron main process (window, IPC, auto-updater)
preload.js              Secure contextBridge API (contextIsolation on)
renderer/
  index.html            App shell: boot screen + tabs
  css/style.css         IRIS-style theme
  js/data.js            Mock data (Phase 1)
  js/ui.js              Tab renderers + modals
  js/app.js             Nav, sidebar, clock, boot sequence
  assets/icon.ico       App icon
scripts/make-icon.js    Icon generator
.github/workflows/      CI build + release
```

## Install on Windows

1. Download `JARVIS-Setup-1.0.0.exe` from GitHub Releases
2. Run it → choose install location → finish (desktop + start menu shortcuts created)
3. Future updates: app checks Releases automatically — Settings → Updates → one-click update
