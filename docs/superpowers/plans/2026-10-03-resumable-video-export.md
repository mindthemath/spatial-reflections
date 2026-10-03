# Resumable Video Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MP4 and MKV exports recoverable from their last durable 60-second checkpoint.

**Architecture:** Move durable job, segment, and finalization logic into a focused Python module. The HTTP handler remains responsible for request validation and transport, while the browser renders from the durable next-frame index and exposes resume/discard controls.

**Tech Stack:** Python 3.14 standard library, ffmpeg/ffprobe, vanilla JavaScript, Three.js, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-03-resumable-video-export-design.md`

## Global constraints

- Checkpoint duration defaults to 60 seconds and is configurable per export.
- Scratch storage defaults to `videos/.checkpoints/` and may be a mounted path.
- Completed checkpoint segments are Matroska/H.264 and are never re-encoded during finalization.
- A crash loses at most the active checkpoint.
- Resume requires the same viewer URL and render signature.
- Explicit discard and automatic pause are different operations.

## Review focus

- Scratch path disappears between manifest read and segment write: pause without deleting prior checkpoints.
- Process dies after segment rename but before manifest replace: discard the unrecorded segment and rerender only that checkpoint.
- Manifest names a missing or hash-mismatched segment: refuse resume with an actionable integrity error.
- Two browser tabs attempt to resume one job: only one lease may become active.
- MP4 finalization fails after all checkpoints: preserve checkpoints and allow finalization retry.

---

### Task 1: Durable job store

**Files:**
- Create: `studio/video_resume.py`
- Create: `studio/test_video_resume.py`

**Interfaces:**
- Produces: `VideoJobStore(root: Path, ffmpeg: str, idle_timeout: float = 300)`
- Produces: `create(request)`, `list_jobs()`, `resume(job_id)`, `pause(job_id)`, `discard(job_id)`, `finish(job_id)`
- Produces: atomic JSON and SHA-256 helpers used by later tasks.

- [ ] Write failing tests for atomic index creation, custom scratch discovery, unavailable scratch reporting, and manifest reload.
- [ ] Run `python3 -m unittest studio/test_video_resume.py -v` and verify failures describe missing `VideoJobStore`.
- [ ] Implement schema-validated manifests and the local job index with temporary-file replacement and best-effort fsync.
- [ ] Add failing tests for missing, extra, and hash-mismatched segment files.
- [ ] Implement resume integrity verification and unrecorded-file cleanup.
- [ ] Run `python3 -m unittest studio/test_video_resume.py -v`.
- [ ] Commit with `git commit -m "Add durable video job store"`.

### Task 2: Checkpoint encoder

**Files:**
- Modify: `studio/video_resume.py`
- Modify: `studio/test_video_resume.py`

**Interfaces:**
- Produces: `write_frame(job_id, frame_index, png) -> dict`
- Produces: `pause_stale_jobs(now=None) -> list[str]`
- Segment metadata fields: `index`, `firstFrame`, `frames`, `file`, `bytes`, `sha256`.

- [ ] Write failing tests showing a checkpoint closes exactly at `fps * checkpointSeconds`, updates `nextFrame`, and starts the next segment lazily.
- [ ] Implement per-job locks, active ffmpeg processes, pending segment cleanup, segment hash recording, and atomic manifest updates.
- [ ] Write failing tests for encoder failure, interrupted active segments, idle timeout, and competing resume leases.
- [ ] Implement pause rollback to the last manifest-confirmed frame and stale-job reaping.
- [ ] Run the focused tests and commit with `git commit -m "Checkpoint video exports into durable segments"`.

### Task 3: Lossless finalization

**Files:**
- Modify: `studio/video_resume.py`
- Modify: `studio/test_video_resume.py`

**Interfaces:**
- `finish(job_id)` returns `url`, `filename`, `bytes`.
- Final metadata records checkpoint interval, segment hashes, resumed count, and immutable request.

- [ ] Write failing tests for ordered concat input, MP4 `+faststart`, MKV Matroska output, failed-finalization retry, and cleanup only after atomic publication.
- [ ] Implement concat-demuxer finalization with `-c copy`, pending output, atomic rename, and adjacent JSON.
- [ ] Run focused tests and commit with `git commit -m "Finalize checkpointed MP4 and MKV exports"`.

### Task 4: Resumable HTTP API

**Files:**
- Modify: `studio/server.py`
- Modify: `studio/test_server.py`

**Interfaces:**
- Adds `GET /api/video/jobs`.
- Adds `POST /api/video/pause` and `POST /api/video/resume`.
- Routes existing start/frame/finish/cancel operations through `VideoJobStore`.

- [ ] Write failing HTTP tests for create, checkpoint progress, pause, server recreation, resume, finish, discard, unavailable scratch, and malformed paths.
- [ ] Initialize the store from `ROOT`, route API calls, and change process shutdown from discard to pause.
- [ ] Add server `service_actions()` stale-job reaping without blocking request handling.
- [ ] Run all Python tests and commit with `git commit -m "Expose resumable video export API"`.

### Task 5: Browser resume workflow

**Files:**
- Modify: `tesseract.js`
- Modify: `index.html`
- Modify: `studio/test_browser.cjs`

**Interfaces:**
- New plan fields: `checkpointSeconds`, `scratchPath`, `sourceUrl`, `renderSignature`.
- `runVideoExport(plan, resumableJob = null)` begins at `nextFrame`.

- [ ] Write failing browser tests for scratch/checkpoint controls, interruption discovery, resumed progress, state mismatch refusal, pause-on-pagehide, and confirmed discard.
- [ ] Add render-signature generation and preserve pre-export settings during teardown.
- [ ] Add unfinished-job cards and resume/discard actions to the export dialog.
- [ ] Update the render loop to start at the server-provided durable frame and display durable versus active progress.
- [ ] Replace pagehide cancellation with pause; preserve explicit destructive discard.
- [ ] Run browser and JavaScript syntax tests and commit with `git commit -m "Resume interrupted video exports in the viewer"`.

### Task 6: Real interruption integration

**Files:**
- Create: `studio/test_video_resume_integration.py`
- Modify: `README.md`

**Interfaces:**
- Uses real ffmpeg and ffprobe when available; skips with an explicit reason otherwise.

- [ ] Write an integration test that renders synthetic PNG frames through one complete checkpoint and part of the next.
- [ ] Recreate the server/store, resume from the durable frame, finish MP4 and MKV variants, and assert ffprobe frame count and duration.
- [ ] Test a temporarily unavailable scratch directory and successful resume after restoration.
- [ ] Document storage sizing, checkpoint loss bounds, pause/discard semantics, SMB caveats, and recovery commands.
- [ ] Run `make test`, verify no test servers or ffmpeg processes remain, and commit with `git commit -m "Verify resumable video export recovery"`.
