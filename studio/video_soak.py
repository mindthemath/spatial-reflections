"""Opt-in production-resolution checkpoint/restart validation, isolated in temporary storage."""
import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from video_resume import VideoJobStore


def run(source, seconds):
    ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
    if not ffmpeg or not ffprobe:
        raise ValueError('ffmpeg and ffprobe are required')
    if not source.is_file():
        raise ValueError('Provide an existing artwork video using VIDEO_SOAK_SOURCE')
    fps, width, height = 30, 1920, 1080
    frames = round(seconds * fps)
    with tempfile.TemporaryDirectory(prefix='tesseract-video-soak-') as temporary:
        root = Path(temporary)
        # Only three PNG samples live on disk and only one frame is read at a time.
        subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-i', str(source.resolve()),
                        '-vf', 'fps=1,scale=1920:1080', '-frames:v', '3',
                        str(root / 'sample-%02d.png')], check=True, timeout=60)
        samples = sorted(root.glob('sample-*.png'))
        if not samples:
            raise ValueError('Could not extract artwork frames')
        store = VideoJobStore(root, ffmpeg)
        job = store.create({'name': 'production-soak', 'width': width, 'height': height,
                            'fps': fps, 'frames': frames, 'format': 'mp4', 'quality': 'high',
                            'bitRate': 7464960, 'checkpointSeconds': 1,
                            'sourceUrl': '/', 'renderSignature': 'soak-v1'})
        try:
            lease = store.resume(job['id'])['lease']
            frame = 0
            restarted = set()
            # Avoid checkpoint boundaries even for common 3/6/600-second runs.
            restart_points = {frames // 3 + fps // 2, frames * 2 // 3 + fps // 2}
            while frame < frames:
                store.write_frame(job['id'], frame, samples[frame % len(samples)].read_bytes(), lease)
                frame += 1
                # Pause mid-checkpoint twice, recreate the store, verify and rerender.
                if frame in restart_points and frame not in restarted:
                    restarted.add(frame)
                    store.pause(job['id'], 'soak restart', lease)
                    store = VideoJobStore(root, ffmpeg)
                    store.recover_stale_encoders()
                    resumed = store.resume(job['id'])
                    assert resumed['nextFrame'] < frame, 'Soak must discard/rerender an incomplete checkpoint'
                    assert resumed['nextFrame'] % fps == 0
                    frame, lease = resumed['nextFrame'], resumed['lease']
            assert len(restarted) == 2, 'Both mid-checkpoint restarts must be exercised'
            completed = store.finish(job['id'])
            output = root / 'videos' / completed['filename']
            result = subprocess.run([ffprobe, '-v', 'error', '-count_frames', '-select_streams', 'v:0',
                                     '-show_entries', 'stream=nb_read_frames,color_space,color_transfer,color_primaries:format=duration',
                                     '-of', 'json', str(output)], check=True, capture_output=True, text=True, timeout=60)
            media = json.loads(result.stdout)
            stream = media['streams'][0]
            assert int(stream['nb_read_frames']) == frames
            assert abs(float(media['format']['duration']) - frames / fps) < .15
            for key in ('color_space', 'color_transfer', 'color_primaries'):
                assert stream[key] == 'bt709'
            assert not store.list_jobs()
            assert not store.processes_for_path(root)
            print(f'PASS: {frames} artwork-derived 1080p frames, two restart/resume cycles, exact duration and BT.709; no encoder leaks.')
        finally:
            store.pause_all()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--seconds', type=int, default=6)
    args = parser.parse_args()
    if not 3 <= args.seconds <= 3600:
        parser.error('--seconds must be between 3 and 3600; long runs are opt-in')
    run(args.source, args.seconds)
