# Skybox Studio

A photographic artwork sandbox: a node-based image pipeline, six face previews, and a reflective / inside-environment 3D preview. The original viewer is unchanged.

## Start

Install the locked Bun dependencies and local Chromium once, then run from the project root:

```sh
make install
make serve
```

Open **http://localhost:1313/studio/**. The original viewer remains at `/`.

The server uses Python 3.9+ and the standard library. Three.js and OrbitControls load from the pinned runtime under `../vendor/`, so Studio requires no internet connection. This is a trusted, local workstation tool, not a public production server.

## Build an arrangement

1. Put photos in `raw/` (nested folders supported). Supported browser formats: JPG/JPEG, PNG, WebP, GIF, BMP. Convert HEIC or camera RAW first. For reproducible artwork, use still images, not animated GIFs.
2. Click **↻** to rescan. Click a photo to add a **Photo / Source** node.
3. Add **Frame** and **Light** nodes. Connect **Photo → Frame → Light → Skybox input**. Any stage may branch to multiple inputs; direct Source → Skybox is also valid.
4. Select a node to edit its settings. **Frame** owns crop/zoom/pan/rotation/flips; **Light** owns exposure and color. Chain nodes in the order you want. Light before Frame can be useful when inspecting the uncropped photograph.
5. Add **Info** and connect it to any image stage to inspect that stage's statistics. Info passes the image through unchanged, so it may live inline or on its own branch.
6. Complete all six faces. **Max native** automatically chooses the largest common square resolution that needs no upscaling; smaller presets are also available. Click **Export folder**.

There is no automatic stitching or seamlessness constraint. Rotation / pan may expose black regions intentionally. These are arbitrary photographic arrangements, not necessarily traditional skyboxes.

Cube face order matches Three.js / the viewer: `px` (+X/right), `nx` (−X/left), `py` (+Y/top), `ny` (−Y/bottom), `pz` (+Z/front), `nz` (−Z/back).

## Graph interaction

- **Connect:** drag output → input, or click output then input. Empty inputs can also drag backwards to outputs. A whole Frame, Light, Info or Photo node is a valid drop target; on the Skybox node, the nearest face row is selected and highlighted.
- **Rewire destination:** drag an occupied input to a different input. Alternatively, click the cable and drag its destination handle.
- **Rewire source:** click a cable and drag its source handle to another output. This affects only that cable, not all branches from the original output.
- Connecting to an occupied input replaces its old connection. Invalid connections / cycles preserve existing wiring. Drop an existing endpoint on empty space to disconnect it. **Esc** cancels a drag without changing it.
- **Move nodes:** drag headers. **Shift-click** adds/removes nodes from the selection. Drag a selected header to move the entire group.
- **Box-select:** Shift-drag empty space. Selection is additive.
- **Deselect:** click empty space. A small movement threshold prevents clicks from panning.
- **Pan:** drag empty space. **Zoom:** wheel. **Frame all:** toolbar or F.
- One permanent **Skybox / Cube Output** node contains six named inputs. It makes the single-cube result visually explicit and cannot be deleted or duplicated; deletion affects only processing/source nodes.

## Resize / preview

Drag the vertical divider beside **Live Preview** to resize the whole sidebar. Drag the horizontal divider below the 3D canvas to resize its height. Both handles also support arrow keys and persist in pipeline snapshots.

Orbit the preview by dragging. **Inside / orbit** switches between an environment-only view and a reflective sphere. **Environment** toggles the background without disabling reflections. This is an environment diagnostic, not a duplicate of the tesseract scene.

## Keyboard shortcuts

**⌘** on macOS or **Ctrl** elsewhere:

| Action | Shortcut |
| --- | --- |
| Undo / redo | ⌘/Ctrl Z / Shift Z; Ctrl Y also redoes |
| Delete selected nodes / cable | Delete or Backspace |
| Duplicate selected nodes and their input wiring | ⌘/Ctrl D |
| Select all nodes | ⌘/Ctrl A |
| Add Frame / Light / Info | C / L / I |
| Frame graph / selection | F / Shift F |
| Save / load JSON | ⌘/Ctrl S / O |
| Export folder | ⌘/Ctrl Shift S |
| Deselect / cancel cable | Esc |
| Shortcut guide | ? |

Undo/redo tracks up to 100 states: creation, deletion, duplication, connections, rewiring, node movement, adjustments, name / resolution edits, and imported snapshots. A slider drag or group move is one edit. Graph navigation and preview resizing are not image edits and stay in place during undo. Native editing shortcuts in text/number fields remain native; file commands still work there.

Adjustments have sliders and editable numeric values. Double-click a slider label to reset that adjustment, or **Reset node** to reset the whole node.

## Frame / Light processing

Snapshots identify the renderer as `canvas-linear-grade-v3` with schema version 3. Version 3 models the terminal result as one Skybox node with six named inputs rather than six unrelated terminal nodes.

**Frame**:

- Square cover scale: `max(size / width, size / height) * zoom`.
- Centered image, clockwise canvas rotation, then horizontal / vertical flips in that rotated coordinate system.
- Pan is a fraction of the input dimensions; positive X/Y moves the image left/up.
- Empty areas and transparency composite onto black. A final face applies a neutral square cover pass.

**Light** is a Lightroom-inspired artistic adjustment engine for decoded images, not a photographic RAW developer:

1. Decode sRGB into linear RGB. Exposure multiplies by `2^EV`.
2. Warmth / tint apply linear channel gains (relative controls, not Kelvin calibration).
3. Shadows / highlights apply smooth luminance-dependent exposure weights.
4. Encode back to display RGB; adjust contrast around the display midpoint and whites / blacks with smooth tonal weights.
5. Saturation modifies chroma; vibrance weights less-saturated colors more strongly. Clip to 8-bit output after all operations.

This cannot recover information already clipped in the original JPEG / PNG. Node order matters; each crop resamples and each light node quantizes at its output.

Live previews render at 256 px. Export resolution is dynamic, with no upscaling: each source starts with its native width/height; a Frame node's square pixel budget is `floor(min(inputWidth,inputHeight) / zoom)`. Chained crops reduce the budget cumulatively. Lighting and Info do not reduce native capacity. The common limit is the minimum across the six connected faces; unused photos do not affect it. Pan/rotation change framing but not sampling scale (exposed black areas are still allowed).

**Max native** uses the exact common limit, not a rounded power of two. Smaller presets are offered up to that limit, including 4096/8192 when supported by the actual images. Existing manual size choices are clamped to the current budget. The Skybox inspector reports each face's source dimensions, crop chain and limit.

The export renderer plans resolution backwards through the DAG: earlier nodes preserve enough pixels for downstream zooms, and shared branches use the largest downstream requirement. This prevents premature resizing, including Light → Frame workflows. Exports record both the source-resolution report and intermediate render plan in `pipeline.json` and the manifest.

There is a 32,767-pixel canvas-dimension guard; actual browser canvas-area, memory, encoding and intermediate-image limits may be lower. Resource failures are reported instead of silently upscaling or reducing the requested resolution. Equal dimensions / no upscaling do not imply equal optical sharpness: focus, lens detail, compression and noise still differ. Resampling and statistics can differ slightly between preview and export.

### Old snapshots

Schema-1 combined Crop/Grade nodes migrate into **Frame → Light** pairs. Schema-1 and schema-2 face nodes migrate into the six named inputs of one permanent Skybox node. The migrated Light node preserves the exact old display-RGB grading algorithm, shown as **Legacy grade · preserved**. Its new sliders remain disabled until you click **Use new light engine** or reset it; switching can change its appearance. Migrated wiring and provenance stay intact.

## Info / light comparison

Info produces a structured statistics object with:

- Input dimensions, aspect ratio, sample dimensions and pixel count.
- RGB and luminance histograms (256 bins); UI displays log-scaled counts.
- Linear-sRGB luminance mean, geometric mean, median, standard deviation, min/max.
- Luminance percentiles P01, P05, P10, P25, P50, P75, P90, P95, P99.
- P01–P99 dynamic range in stops.
- Near-black, near-white and any-channel-clipped percentages.
- Mean display RGB and a suggested EV offset toward 18% gray based on geometric-mean luminance.

Measurement uses an aspect-preserving sample up to 512 px, composited on black. Each node measures its actual upstream stage: a source branch can report native image dimensions while a post-crop branch reports rendered dimensions.

The EV suggestion is not automatic equalization. Subject matter, crop, black borders and clipping affect it. Compare Info nodes across photographs / stages and apply manual exposure changes to Light nodes.

The green output is image passthrough. The purple **ƒ** statistics output opens its inspector. **Save statistics JSON** downloads the metrics with a pipeline snapshot. Structured statistics are also saved by node ID on full-resolution export. Numeric connections and global equal-light calculation nodes are intentionally reserved for a future version; the data contract is already there.

## Save / restore / export

**Reload app** reloads the editor while preserving the workspace. **Reset workspace** clears the saved browser draft, selection and undo history and creates a fresh graph with the permanent Skybox node. Reset requires confirmation and never deletes source images or exported folders. Save JSON first if you want to archive the current arrangement.

The server sends Studio/viewer code and API responses with `Cache-Control: no-store` and ignores conditional cache headers for editor code, so ordinary reloads don't mix old UI and new processing modules. Restart `studio/server.py` after changing its Python code for this policy to take effect. Source photos and exported images retain normal static-file caching.

The complete workspace is automatically saved to browser-local storage after edits, node movement, graph navigation and preview resizing. Reloading the same Studio origin restores the pipeline, selection, viewport, output settings and preview layout. The header reports **Autosaved** or **Restored**. Undo history intentionally starts fresh after a page reload. Browser storage is origin-specific and can be cleared by browser settings, so it is convenience recovery—not archival provenance.

**Save JSON** captures source paths and SHA-256 hashes, node settings, edges, face assignments, resolution, graph layout, viewport and sidebar size. **Load JSON** validates its schema / DAG, migrates legacy snapshots, and restores it. Keep `raw/` alongside snapshots: image bytes are not embedded. Missing or changed originals warn on import and block folder export until resolved. Use JSON as the portable backup across browsers, machines, ports or hostnames.

Every **Export folder** creates a fresh directory under `exports/` using UTC time and a random suffix, with exclusive creation:

```text
exports/untitled-20261002T180000Z-a1b2c3d4e5f6/
  px.png nx.png py.png ny.png pz.png nz.png
  pipeline.json
  manifest.json
  preview.png     # small representative PX-face thumbnail for the viewer gallery
  analysis.json    # when Info nodes are present
```

Every exported folder includes `pipeline.json` alongside the images. It never overwrites existing exports or the default faces in `raw/`. `manifest.json` also embeds the complete pipeline and adds per-output hashes, the terminal Skybox node ID, and the named cube input for upstream lineage, plus Info statistics from the export-resolution pipeline. Info branches without image inputs record an error rather than blocking otherwise-complete faces.

PNGs are encoded and uploaded one face at a time as binary data, avoiding a giant six-image base64 JSON payload. The server streams each face to disk with exclusive writes (up to 512 MB per PNG), then finalizes the JSON lineage after all six succeed. Failed or interrupted exports retain `.pending.json` and are reported as incomplete; they never overwrite completed artwork.

The server rechecks every source hash before starting and again before finalizing, including unused source nodes. The browser renders PNGs; the server checks their signatures, verifies sources and writes the files. This is not an independent rendering engine or a sandbox for untrusted clients. Color management / image decoding may vary across browsers; hashes identify exact inputs and outputs but do not guarantee bit-identical cross-browser rendering.

After export, **View in Tesseract ↗** opens that completed arrangement in the original viewer. The viewer's **Skybox → Browse exports…** gallery lets you switch between completed exports without changing the camera or animation, and **Open in Studio ↗** imports the selected export's pipeline for further editing. Explicit URL imports are consumed once, preserving subsequent draft edits on refresh. The link in Studio always refers to the last completed export, not the current unexported draft. No copying into `raw/` is necessary, and the viewer's default faces are never overwritten.

Only completed exports appear in the gallery; `.pending.json` folders stay hidden. Chrome displays the photographic reflections; the viewer offers **Switch to Chrome** if a debug shader is active. Failed loads retain the previous environment. See [the project README](../README.md) for the complete viewer workflow.

## Checks

```sh
node --check studio/studio.js
node --check studio/pipeline.js
node studio/test_resolution.cjs
python3 -m unittest discover -s studio -p 'test_*.py'
```

Browser integration test (using the Bun-managed Playwright and Chromium installation):

```sh
make test-browser
```

Run the complete syntax, unit/API and browser suite with `make test`. You may set `CHROMIUM_EXECUTABLE` to select a different browser executable. The browser test uses a temporary project/library/export folder and synthetic photos; it never changes your real artwork. It covers graph gestures, endpoint rewiring, undo/redo, shortcuts, resizing, lighting calculations, statistics, schema migration, JSON round-trip, PNG export, publishing, the viewer gallery/handoff, Chrome switching, camera preservation, load failure retention and refresh after reopening an export in Studio.

Use `make sync` to recursively copy the locked Three.js entry points, their relative imports and the license from `node_modules/` into `vendor/`. Use `make update` to update Bun packages and Chromium, synchronize the vendored runtime, and run the complete suite. The update fails on a missing/stale vendor module or browser regression. Review visual output after Three.js updates; previously published work retains its snapshotted runtime.
