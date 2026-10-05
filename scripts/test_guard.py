#!/usr/bin/env python3
"""Serialize resource-heavy tests, bound runtime, and clean only owned processes (POSIX)."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import uuid

LOCK_PATH = Path(tempfile.gettempdir()) / f'tesseract-heavy-tests-{os.getuid()}.lock'
TOKEN_KEY = 'TESSERACT_TEST_GUARD_TOKEN'


def socket_pressure():
    result = subprocess.run(['netstat', '-an'], capture_output=True, text=True, timeout=5)
    if result.returncode:
        raise RuntimeError('Cannot inspect socket pressure; refusing network-heavy tests')
    return sum('TIME_WAIT' in line for line in result.stdout.splitlines())


def process_snapshot():
    result = subprocess.run(['ps', '-axo', 'pid=,ppid=,lstart=,command='],
                            capture_output=True, text=True, timeout=5)
    if result.returncode:
        raise RuntimeError('Cannot inspect test-owned processes')
    entries = {}
    for line in result.stdout.splitlines():
        fields = line.split(None, 7)
        if len(fields) == 8 and fields[0].isdigit() and fields[1].isdigit():
            entries[int(fields[0])] = (int(fields[1]), ' '.join(fields[2:7]), fields[7])
    return entries


def remember_descendants(root_pid, owned, snapshot):
    parents = {root_pid} | {pid for pid, identity in owned.items()
                               if pid in snapshot and snapshot[pid][1:] == identity}
    changed = True
    while changed:
        changed = False
        for pid, (parent, started, command) in snapshot.items():
            if parent in parents and pid not in parents:
                parents.add(pid)
                owned[pid] = (started, command)
                changed = True


def signal_owned(owned, sig):
    snapshot = process_snapshot()
    for pid, identity in owned.items():
        if pid in snapshot and snapshot[pid][1:] == identity:
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass


def cleanup(child, owned):
    try:
        remember_descendants(child.pid, owned, process_snapshot())
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'Cleanup process inspection failed: {error}', file=sys.stderr)
    # Allow JS finally/signal handlers to close Chromium and the server first.
    if child.poll() is None:
        child.send_signal(signal.SIGTERM)
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
    # Detached browser processes can have their own groups. Their PID + start
    # time + command must still match our recorded descendants before signalling.
    try:
        signal_owned(owned, signal.SIGTERM)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            snapshot = process_snapshot()
            if not any(pid in snapshot and snapshot[pid][1:] == identity
                       for pid, identity in owned.items()):
                break
            time.sleep(.2)
        signal_owned(owned, signal.SIGKILL)
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'Detached-process inspection failed; terminating only the owned test group: {error}', file=sys.stderr)
    # Also cover ordinary children reparented during forced shutdown. This group
    # was exclusively created for this test invocation, not the user's server.
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    if child.poll() is None:
        child.wait(timeout=5)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--timeout', type=float, default=300)
    parser.add_argument('--network', action='store_true')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command or args.timeout <= 0:
        parser.error('A command and positive timeout are required')

    with LOCK_PATH.open('a+') as lock:
        # Nested Make targets inherit the outer guard and its process group.
        lock.seek(0)
        try:
            owner = json.loads(lock.read() or '{}')
        except ValueError:
            owner = {}
        if os.environ.get(TOKEN_KEY) and os.environ[TOKEN_KEY] == owner.get('token'):
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                # The token is valid only while the outer guard still owns its
                # lock. A stale inherited environment must not bypass guarding.
                if args.network and socket_pressure() >= 8000:
                    print('Host socket pressure rose during this run; stopping before launching more network-heavy tests.', file=sys.stderr)
                    return 2
                os.execvp(command[0], command)
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Heavy tests are already running. Wait for that run to finish; do not retry concurrently.', file=sys.stderr)
            return 2
        if args.network:
            pressure = socket_pressure()
            if pressure >= 8000:
                print(f'Refusing network-heavy tests: {pressure:,} TIME_WAIT sockets. '
                      'Use make test-fast or make test-video-encoder; retry only after host pressure subsides.', file=sys.stderr)
                return 2
        token = uuid.uuid4().hex
        lock.seek(0); lock.truncate()
        lock.write(json.dumps({'pid': os.getpid(), 'token': token, 'command': command}))
        lock.flush()
        environment = dict(os.environ, **{TOKEN_KEY: token, 'TESSERACT_TEST_ENCODER_THREADS': '2'})
        child = subprocess.Popen(command, env=environment, start_new_session=True)
        owned = {}
        interrupted = []
        def stop(sig, _frame):
            interrupted.append(sig)
        previous = {sig: signal.signal(sig, stop) for sig in (signal.SIGINT, signal.SIGTERM)}
        started = time.monotonic()
        timed_out = False
        try:
            while child.poll() is None:
                remember_descendants(child.pid, owned, process_snapshot())
                if interrupted:
                    break
                if time.monotonic() - started > args.timeout:
                    timed_out = True
                    print(f'Test exceeded {args.timeout:g}s; cleaning up this invocation only.', file=sys.stderr)
                    break
                time.sleep(.5)
        finally:
            try:
                cleanup(child, owned)
            finally:
                for sig, handler in previous.items():
                    signal.signal(sig, handler)
                lock.seek(0); lock.truncate(); lock.flush()
        if interrupted:
            return 128 + interrupted[0]
        return 124 if timed_out else child.returncode


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'Test guard: {error}', file=sys.stderr)
        sys.exit(2)
