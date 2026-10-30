# ScreenCap Video

Desktop screen recording and click-aware editing for X / Twitter. Windows is the intended deployment platform.

## Run

1. Install **Node.js LTS** and npm.
2. Double-click **`start.bat`** (installs dependencies on the first run).
3. Choose a display and recording settings. Click **Start recording** or press **F9**.
4. Click during recording to create automatic zoom events. Press **F8** to add a manual zoom marker. Use the floating bar to stop or discard.
5. Edit the recording, trim, crop, arrange zooms, choose an aspect ratio and background, then **Export MP4**.

## Build portable Windows EXE

Double-click **`build.bat`**. The portable `.exe` will be inside **`dist/`**. Electron Builder requires internet access during initial installation; `uiohook-napi` and `ffmpeg-static` are unpacked from `app.asar`.

## Limits and notes

- The recording bar uses Windows `setContentProtection` to hide it from screen capture where Windows and the capture method support that flag.
- Loopback/system audio availability depends on Windows capture permissions, drivers and Electron. If unavailable, capture continues and shows a warning. Microphone capture uses user permission.
- `uiohook-napi` must load for global click/typing tracking. A visible warning appears otherwise; recording still works and manual F8 zoom markers remain available.
- Recording sessions and their `session.json` metadata are saved in the system temporary directory. Copy them elsewhere if you want long-term storage.
- For imported videos, accompanying `session.json` (same directory as the video) restores click and cursor data if it exists.
- Export happens by **playing the edited video in real time**, then FFmpeg compresses the intermediate to H.264 MP4. It can take longer than the clip duration. Cancel stops the process. If MP4 conversion fails, the intermediate is copied as WebM next to the chosen destination.
- Requires a graphical Windows session. Hotkeys F9 and F8 might be unavailable if another application already owns them.

## Smoke test

Run `npm test` after installing dependencies, or `node test/smoke.js` if FFmpeg is available on PATH. It creates a **synthetic 10-second recording with four simulated click flashes** (`demo/recording-ready.webm`), a metadata log (`demo/session.json`), and an H.264/AAC test export (`demo/exported-sample.mp4`). This tests the media conversion commands and source syntax; it is **not** a real Windows screen capture or an actual end-to-end GUI export test.
