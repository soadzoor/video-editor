# Browser Video Editor

Local-first browser video editor built with React + TypeScript.  
All media processing runs on the user's device with `ffmpeg.wasm` (no backend upload pipeline).

Live demo (GitHub Pages): https://soadzoor.github.io/video-editor/

## Product Demo Video

[![Watch the product demo](https://img.youtube.com/vi/Gv3_6p-ZM4Y/hqdefault.jpg)](https://youtu.be/Gv3_6p-ZM4Y)

GitHub README pages do not support iframe embeds, so this uses a clickable preview image.

## Current Status (March 2026)

Implemented and working end-to-end:

- Local media ingest:
  - Drag-and-drop or file picker import for local `video/*` files
  - Per-file metadata ingestion (duration, width, height)
  - Media bin with remove/clear actions
- Timeline editing:
  - Clips are appended into one timeline track in import order
  - Reorder timeline pieces with drag-and-drop
  - `Razor` tool to split a piece at cursor position
  - Delete selected timeline piece
  - Global trim window (`In` / `Out`) with draggable edges
- Preview and transport:
  - Canvas preview with play/pause
  - Draggable playhead seek
  - Keyboard shortcuts: `Space` (play/pause), `ArrowLeft` / `ArrowRight` (frame step)
  - WebCodecs-based timeline preview engine (with MP4 demux via `mp4box`)
- Piece-level controls (Inspector):
  - Speed control (`0.001x` to `1000x`) via numeric input, logarithmic slider, and presets
  - Duration editing (min/sec/ms) that maps to segment speed
  - Transform controls: scale + pan (`X`, `Y`)
  - Quick actions: `Fill Crop` and `Reset Transform`
- Global crop controls:
  - Enable/disable crop
  - Interactive crop rectangle in preview (drag/move/resize handles)
  - Numeric crop inputs (`X`, `Y`, `W`, `H`)
  - Optional aspect-ratio lock
- Export pipeline:
  - Export formats: `mp4`, `mov`, `avi`, `mkv`, `gif`, `mp3`, `wav`
  - Export mode: `Fit Canvas` or `Fast Copy` (when compatible)
  - Optional workspace size (`width`/`height`) and FPS
  - Optional video/audio stream toggles and bitrate overrides
  - Multi-stage progress reporting with percent, frame counts, and ETA
  - Auto-download of rendered output
- Workspace UX:
  - Desktop 3-pane layout (crop panel, preview, inspector) with resizable splitters
  - Collapsible side panels
  - Mobile/stacked layout with utility tabs
  - Layout persistence in `localStorage`

## Stack

- App: React 19 + TypeScript + Vite 7
- Processing: `@ffmpeg/ffmpeg` (`ffmpeg.wasm`)
- Preview: WebCodecs + `mp4box`

## Getting Started

```bash
npm install
npm run dev
```

Then open the local Vite URL (typically `http://localhost:5173`).

## Build

```bash
npm run build
```

## Deploy

```bash
npm run deploy
```

Deployment script behavior (`scripts/deploy.mjs`):

- Builds the app (`dist/`)
- Copies artifacts into sibling worktree directory `../video-editor_deploy`
- Commits changes there
- Pushes the current deploy branch to `origin`

## Notes / Limitations

- WebCodecs preview requires a supported browser. If unsupported, the app shows a fallback notice.
- Editing model is currently a single timeline track (no multi-track compositing/transitions yet).
- Project-level edit data is not persisted; only layout preferences are stored locally.
