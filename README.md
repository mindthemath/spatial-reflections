# Tesseract Mirrors + Skybox Studio

A reflective tesseract viewer and a photographic node-editor sidecar for constructing its cube environment.

## Run locally

```sh
python3 studio/server.py --port 1313
```

- Viewer: **http://localhost:1313/**
- Studio: **http://localhost:1313/studio/**

Put original photographs in `raw/`. The server has no Python dependencies; browser modules load Three.js from unpkg. This is a trusted local workstation app, not a public production service.

## Studio → viewer workflow

1. Build a Photo → Frame → Light → Skybox graph in Studio.
2. Preview and adjust, then export at **Max native** or a smaller resolution. Native pixel budgets include chained crop zooms, so export does not upscale the faces.
3. Click **View in Tesseract ↗** after export. It opens the original viewer with that exact completed export:

   ```text
   /?skybox=exports/<unique-export-folder>
   ```

4. In the viewer's collapsible menu, **Skybox → Browse exports…** opens a gallery of completed exports with name, timestamp, resolution and a representative face thumbnail.
5. Load different skyboxes without resetting the camera, animation, geometry or shader. **Default** loads the six images under `skybox/`.
6. **Open in Studio ↗** reopens the selected export's `pipeline.json` for further editing. If another browser draft exists, Studio asks before replacing it. The URL import is consumed once so subsequent refreshes preserve new draft edits, rather than reloading the old export.

The viewer remembers the last successful skybox in this browser. An explicit `skybox` URL overrides the remembered selection. **Lineage JSON ↗** opens the active export's manifest.

**Reflective Chrome** is the artistic viewing mode. Rough and Iridescent remain debug/orientation tools. When a debug shader is active, the menu offers **Switch to Chrome**; loading a skybox does not silently switch it.

Failed or incomplete loads retain the current environment and display an error. With no image environment yet, the viewer uses a simple diagnostic gradient cube—not an unrelated remote park scene. Only completed exports appear in the gallery.

Large exports remain untouched on disk. If an image exceeds the viewer GPU's maximum cube-map texture size, it is reduced for display only and the menu reports that fact. The original custom Chrome shader/color convention is preserved.

## Animation timing

The viewer drives animation from an integer frame index rather than repeatedly adding to a floating-point time value. For the current decimal 4D rotation coefficients, it finds a common full-rotation period, rounds the requested motion step to an integer loop length, and derives the exact time step needed to return seamlessly to frame zero.

The collapsed **Video timing** section provides export FPS, loop frame count, duration, exact time step, a frame scrubber and single-frame controls. FPS controls preview cadence and reported movie duration; every frame remains deterministic for a future video encoder. Screenshots preserve the current frame and FPS while remaining backward-compatible with previously saved `time` metadata.

## Data and state

Exports are immutable, uniquely named folders under `exports/`, containing six PNGs, `pipeline.json`, `manifest.json`, optional Info statistics and a small `preview.png` gallery thumbnail. The viewer never overwrites `skybox/` when selecting an export.

Studio autosaves its workspace and supports JSON snapshots, undo/redo, refresh recovery and a confirmed **Reset workspace**. The **View in Tesseract** link always refers to the last completed export, not unexported draft changes. Browser-local drafts are convenience recovery, not archival backups. Use **Save JSON** and preserve the source photographs.

See **[studio/README.md](studio/README.md)** for node interactions, processing semantics, resolution limits, export provenance and tests.

## Implementation

- `tesseract.js`: existing geometry, controls and shaders.
- `viewer-skyboxes.js`: viewer library UI, safe environment loading and shader prompt.
- `skybox-paths.js`: shared local-export path validation and deep links.
- `studio/pipeline.js` / `studio/resolution.js`: image processing and native pixel budgets.
- `studio/server.py`: raw-image library, completed-export gallery and streaming filesystem exports.

The Studio's current live preview is a sphere / inside-cube diagnostic. A live tesseract preview mode inside Studio is planned separately; it is not implemented yet.
