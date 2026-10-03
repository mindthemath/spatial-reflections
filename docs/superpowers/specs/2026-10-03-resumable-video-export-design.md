# Resumable Video Export Design

## Goal

Make multi-hour browser-rendered exports recoverable after browser freezes, tab closure, server restart, machine restart, or temporary loss of a mounted network share. The completed output may be MP4 or MKV. Recovery must never require retaining every rendered PNG.

## User experience

- Every video export is checkpointed by default.
- The default checkpoint interval is 60 seconds and is configurable per export.
- Scratch storage defaults to `videos/.checkpoints/`. The dialog accepts another local or mounted path for large jobs.
- Export settings become immutable after the job starts.
- Leaving or closing the page pauses the export and preserves completed checkpoints.
- A user-initiated **Discard export** action removes checkpoints after confirmation.
- Opening **Export video…** lists unfinished jobs. A job can be resumed when its source viewer URL and render settings match the current viewer.
- Progress distinguishes rendered frames, durable checkpoint frames, and work that may need to be repeated.
- Finalization concatenates checkpoint segments without re-encoding and atomically publishes the MP4 or MKV.

## Checkpoint format

Each checkpoint is an independently finalized Matroska file containing H.264 video with the export's fixed dimensions, frame rate, pixel format, and encoding settings. A new encoder starts at each checkpoint boundary, which guarantees an independently decodable segment and an initial keyframe.

The server accepts frames sequentially. It acknowledges an ordinary frame after writing it to the active encoder. At a checkpoint boundary it closes `ffmpeg`, requires a zero exit status, synchronizes the segment, renames it from a pending name, hashes it with SHA-256, and atomically updates the job manifest. Only then does it report those frames as durable.

A crash may discard the active `.pending.mkv` and rerender that segment. Finalized segments recorded in the manifest are never rerendered unless integrity verification fails.

## Durable storage

`videos/.video-job-index.json` is an atomically replaced local index from job ID to manifest path. It allows jobs using a custom or temporarily unavailable scratch mount to be discovered after restart.

Each scratch job directory contains:

- `job.json`: schema version, state, immutable request, source URL, completed segment metadata, next durable frame, timestamps, and failure details.
- `segment-000000.mkv`, `segment-000001.mkv`, …: finalized checkpoints.
- At most one `.segment-NNNNNN.pending.mkv`.
- Temporary concat input and pending final output only while finalizing.

Manifest and index updates use write-to-temporary-file, flush, best-effort `fsync`, and atomic replace. A custom scratch path is expanded and resolved server-side. Job IDs and generated filenames remain server-controlled.

## Lifecycle and API

- `POST /api/video/start`: creates a durable job and index entry. It returns the job ID, immutable request, and frame zero.
- `POST /api/video/frame`: lazily starts the current segment encoder, validates the global frame index and PNG dimensions, writes the frame, and finalizes a segment at its boundary.
- `POST /api/video/pause`: kills and removes only the active pending segment, rolls back to the last durable frame, and preserves the job.
- `POST /api/video/resume`: verifies the manifest and every recorded segment hash, abandons stale active state, and returns the next durable frame.
- `POST /api/video/finish`: requires all frames durable, concatenates segments with `ffmpeg -c copy`, and atomically publishes the requested MP4 or MKV plus provenance JSON.
- `POST /api/video/cancel`: permanently discards the job after the browser confirms destructive intent.
- `GET /api/video/jobs`: lists durable unfinished jobs, including unavailable scratch paths and resumability reasons.

The server automatically pauses an active job after five minutes without a completed frame request. Process shutdown pauses active jobs rather than deleting them.

## Browser state and deterministic resume

The request stores the viewer URL and a render signature containing motion coefficients, shader, lighting, geometry visibility, camera position and target, frame rate, dimensions, quality, and skybox URL. Timeline position and UI expansion state are excluded because each export frame is selected explicitly.

Before rendering begins, the viewer persists its pre-export settings. It does not overwrite those settings with an in-progress export frame during page teardown. Resume is enabled only when the current render signature matches the stored signature. A mismatch is explained rather than silently producing a discontinuous video.

The resumed render loop starts at `nextFrame`, while progress starts at the durable frame count. Errors pause the job and leave a clear resume action. Explicit discard remains separate.

## Finalization

The server writes an ffmpeg concat-demuxer list from manifest-recorded segments in numeric order. It uses stream copy:

- MP4: H.264 stream copy plus `+faststart`.
- MKV: H.264 stream copy into Matroska.

The final file is written beside its destination under a pending name and atomically renamed after ffmpeg succeeds. Scratch checkpoints are removed only after the final file and JSON provenance are durable.

## Network-share behavior

Scratch may point at a mounted SMB path. A disconnect can fail the active segment or a manifest update; the server pauses the job and retains the last manifest-confirmed checkpoint. The local index continues to advertise the job as temporarily unavailable. Resume revalidates all hashes after the mount returns.

The current output destination remains `videos/`. Configurable final destinations and symlink management are intentionally separate future work.

## Validation and tests

- Unit tests cover atomic manifests, index recovery, checkpoint boundaries, hash verification, stale-job pause, discard, resume after process loss, and MP4/MKV concat commands.
- HTTP tests cover start/frame/pause/resume/finish and unavailable custom scratch paths.
- Browser tests cover interrupted export discovery, matching-state resume, mismatch refusal, discard confirmation, and completed output.
- A real ffmpeg integration test interrupts after a checkpoint, restarts the server, resumes, finalizes, and verifies the output frame count with `ffprobe`.
