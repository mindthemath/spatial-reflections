# Tesseract Mirrors + Skybox Studio

A reflective tesseract viewer and a photographic node-editor sidecar for constructing its cube environment.

## Run locally

Install the locked JavaScript tooling and Chromium once, and synchronize the vendored offline runtime:

```sh
make install
```

Video export additionally requires an `ffmpeg` executable with H.264 (`libx264`) support on `PATH`. It is called as a subprocess; the Python server remains standard-library-only and does not install or import third-party Python packages.

Then start the local application:

```sh
make serve
# equivalent: python3 studio/server.py --port 1313
```

- Viewer: **http://localhost:1313/**
- Studio: **http://localhost:1313/studio/**

Put original photographs in `raw/`. The server has no Python dependencies. Both the viewer and Studio use the pinned Three.js runtime under `vendor/`, so the complete local design, image export and viewer workflow requires no internet connection. This is a trusted local workstation app, not a public production service.

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

## Publish static work

Publishing is the final step after Studio export. Open a completed export in the viewer, settle the camera, shader, lighting, motion and presentation settings, then click **Publish…** in the Skybox section. Enter a title, URL slug and optional description. The local server creates an immutable snapshot at:

```text
site/work/<slug>/
  index.html
  piece.json
  preview.png
  tesseract.js
  viewer-skyboxes.js
  skybox-paths.js
  vendor/                 # pinned Three.js + OrbitControls + license
  skybox/                 # six PNG faces
```

A slug is never silently replaced; choose another slug if that directory already exists. The publish operation also rebuilds `site/catalog.json`, which the gallery at `site/index.html` reads. Published viewer settings come from embedded configuration rather than browser storage, so one work cannot inherit another work's camera or shader.

All resources used by an individual work are relative to its own directory. You can copy `site/work/<slug>/` wholesale to an S3 bucket or any other static web server without changing a base URL. It contains no Studio/API dependency and makes no network requests for runtime libraries. Serve the directory over HTTP rather than opening `index.html` as a `file://` URL; ES modules are commonly blocked or restricted from local files. This layout is intended to support a future BrightSign packaging workflow with little or no transformation, though device-specific browser/WebGL validation is still required.

Preview the gallery locally with:

```sh
make static
# http://localhost:1315/
```

The GitHub Pages workflow deploys `site/` directly when it changes. Its temporary Pages artifact has an explicit one-day retention period. The checked-in `site/` files remain the durable publication source; Actions artifacts are only deployment transport.

## Dependencies and vendored runtime

Bun owns JavaScript dependencies through `package.json` and `bun.lock`. Playwright is a development dependency; Three.js is locked as the source for the checked-in browser runtime. The application never serves files from `node_modules/`.

```sh
make sync      # copy Three.js entry points, relative imports and license into vendor/
make update    # update packages/Chromium, sync vendor/, then run the full suite
make test      # vendor integrity, syntax, unit/API and Playwright browser tests
```

`make update` deliberately moves Three.js and Playwright to their current releases. Vendor synchronization recursively follows relative module imports because newer Three.js releases may split the runtime across additional files. The update target fails unless vendor integrity and the complete browser suite pass. Still review visual output before committing `package.json`, `bun.lock`, and `vendor/`. Existing published work remains unchanged because each `site/work/<slug>/` contains its own runtime snapshot.

A normal release workflow is:

```sh
make serve
# publish in the viewer, then inspect http://localhost:1313/site/work/<slug>/
git diff -- site/
git add site/
git commit -m "Publish <title>"
git push
```

Large exports remain untouched on disk. If an image exceeds the viewer GPU's maximum cube-map texture size, it is reduced for display only and the menu reports that fact. The original custom Chrome shader/color convention is preserved.

## Animation timing

The viewer drives animation from an integer frame index rather than repeatedly adding to a floating-point time value. For the current decimal 4D rotation coefficients, it finds a common full-rotation period, rounds the requested motion step to an integer loop length, and derives the exact time step needed to return seamlessly to frame zero.

The collapsed **Video timing** section provides export FPS, loop frame count, duration, exact time step, a frame scrubber and single-frame controls. FPS controls preview cadence and reported movie duration. Screenshots preserve the current frame and FPS while remaining backward-compatible with previously saved `time` metadata.

**Export video…** opens a confirmation dialog for MP4 or MKV container, resolution, quality and range. The default is a 30-second MP4 clip starting at the current frame, shortened to fit when the loop is shorter than 30 seconds. Whole-loop export remains available. A clip window uses a start and duration in seconds, `MM:SS`, or `HH:MM:SS`; the window must remain inside one loop. The confirmation lists exact frames, duration and a bitrate-based size estimate before any work begins. If that file name already labels a clip in `videos/`, the viewer asks before adding another.

Rendering and encoding are intentionally split. The active browser renders the exact live WebGL scene one deterministic PNG frame at a time. The server encodes independent H.264/Matroska checkpoint segments, then losslessly concatenates them into the selected MP4 or MKV under `videos/`. Frames are not retained as an image sequence or accumulated in browser memory. Completed videos include an adjacent JSON provenance file. Static published works can display the export UI but cannot encode video without the local API server.

### Long-running video recovery

Every video export is resumable. The default checkpoint interval is 60 seconds and can be changed from 1 to 3,600 seconds. A browser navigation, server shutdown, encoder failure, or five minutes without a frame pauses the job and preserves completed checkpoints. Reopen the same viewer URL with the same camera and render settings, open **Export video…**, and use **Resume**. The active incomplete checkpoint is rerendered, so an interruption loses at most one checkpoint interval—not the preceding hours. **Pause export** is recoverable; **Discard** permanently removes the checkpoints and requires confirmation.

The server records the active ffmpeg PID and its exact checkpoint path in the durable job manifest. On startup it terminates only ffmpeg processes whose command matches that job-owned path, removes the incomplete checkpoint, and leaves unrelated or PID-reused processes untouched. The export preflight reports any startup cleanup. This also recognizes checkpoint encoders created before PID tracking was added; `make unstick` remains a manual diagnostic fallback.

Checkpoint segments ordinarily live under `videos/.checkpoints/`. The export dialog can instead use an absolute scratch folder on another local disk or a mounted SMB share. Plan scratch capacity for roughly the final encoded video size plus one active segment and the final output; free-space checks for the final output still apply to `videos/`. For network storage:

- mount the share before starting or resuming, create the selected absolute scratch directory in advance, and keep the mount path stable;
- prefer a reliable wired connection and prevent the workstation and storage from sleeping;
- do not let two machines write the same scratch job;
- expect a disconnected share to show the job as unavailable until the same path is mounted again.

The job index is `videos/.video-job-index.json`; each scratch job contains an atomic manifest and SHA-256 hashes for completed segments. Resume verifies those hashes before encoding further. If final MP4/MKV assembly fails, the checkpoints remain and **Resume** retries finalization. Restart recovery is therefore:

```sh
make serve
# Open the original viewer URL → Export video… → Resume
```

The viewer page and machine must remain active while new frames are being rendered, but it is safe to pause, navigate away, restart the local server, and resume later. The final output currently remains under `videos/` even when scratch storage is elsewhere.

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
