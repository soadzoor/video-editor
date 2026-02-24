# Browser Video Editor (TypeScript)

A simple, browser-based video editor where all processing runs on the user's device (no backend).

## Current Status

- Timeline-first workflow implemented:
  - Drag and drop local video files
  - Multiple files are concatenated by default on a single timeline
  - One main preview player with play/pause + global seek
  - Timeline trim controls (start/end keep range)
  - Timeline cut controls (add/remove cut ranges)
  - Single export button that finalizes and downloads the edited video

## Getting Started

```bash
npm install
npm run dev
```

Then open the local Vite URL (typically `http://localhost:5173`).

## Goals

- Drag and drop local video files
- Play/pause preview
- Concatenate videos
- Cut/remove sections
- Crop
- Resize
- Trim

## Tech Direction (Client-Only)

- App: TypeScript + Vite
- UI: React (or Solid) + simple timeline UI
- Processing: `@ffmpeg/ffmpeg` (WASM)
- Optional performance path: WebCodecs + Web Workers for future optimization
- Storage: in-memory + optional IndexedDB for session persistence

## Why Start This Way

- `ffmpeg.wasm` gives broad editing capability in the browser without server code.
- We can ship features incrementally and keep everything local-first.
- Later, we can optimize specific operations with WebCodecs if needed.

## Incremental Plan

1. **Bootstrap project**
   - Initialize Vite + TypeScript app
   - Add drag-and-drop file intake
   - Render preview in `<video>` with play/pause controls
2. **Concatenate**
   - Import multiple files
   - Build concat pipeline in ffmpeg.wasm
   - Export merged video
3. **Trim and cut**
   - Add timeline range selection
   - Trim start/end
   - Remove middle sections by splitting + concat
4. **Crop and resize**
   - Add simple crop box presets and custom dimensions
   - Apply `crop` and `scale` filters
5. **Polish**
   - Progress indicators, cancellation, error handling
   - Worker offloading and memory cleanup

## Next Step

Milestone 5: reintroduce crop/resize into the timeline export pipeline, then polish (cancellation, memory tuning, richer error feedback).
