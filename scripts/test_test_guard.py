"""Cheap, network/browser-free regression tests for the heavy-test guard."""
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import test_guard


class TestGuardTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.lock_patch = mock.patch.object(test_guard, 'LOCK_PATH', Path(self.temp.name) / 'guard.lock')
        self.lock_patch.start()
        self.token_patch = mock.patch.dict(os.environ, {test_guard.TOKEN_KEY: ''})
        self.token_patch.start()

    def tearDown(self):
        self.token_patch.stop()
        self.lock_patch.stop()
        self.temp.cleanup()

    def test_refuses_overlapping_run_without_launching_child(self):
        with test_guard.LOCK_PATH.open('a+') as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with mock.patch.object(test_guard.subprocess, 'Popen') as launch:
                self.assertEqual(test_guard.main(['--', 'unused']), 2)
                launch.assert_not_called()

    def test_refuses_network_run_under_socket_pressure(self):
        with mock.patch.object(test_guard, 'socket_pressure', return_value=9000), \
             mock.patch.object(test_guard.subprocess, 'Popen') as launch:
            self.assertEqual(test_guard.main(['--network', '--', 'unused']), 2)
            launch.assert_not_called()

    def test_nested_network_stage_rechecks_socket_pressure(self):
        token = 'outer-test-token'
        test_guard.LOCK_PATH.write_text(json.dumps({'token': token}))
        with test_guard.LOCK_PATH.open('a+') as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with mock.patch.dict(os.environ, {test_guard.TOKEN_KEY: token}), \
                 mock.patch.object(test_guard, 'socket_pressure', return_value=9000), \
                 mock.patch.object(test_guard.os, 'execvp') as execute:
                self.assertEqual(test_guard.main(['--network', '--', 'unused']), 2)
                execute.assert_not_called()

    def test_preserves_exit_status_and_releases_lock(self):
        self.assertEqual(test_guard.main(['--', sys.executable, '-c', 'raise SystemExit(7)']), 7)
        with test_guard.LOCK_PATH.open('a+') as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.assertEqual(test_guard.LOCK_PATH.read_text(), '')

    def test_timeout_cleans_child_and_keeps_unrelated_process(self):
        marker = Path(self.temp.name) / 'child.pid'
        script = '''
import signal,subprocess,sys,time
from pathlib import Path
child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'])
Path(sys.argv[1]).write_text(str(child.pid))
def stop(*_):
    child.terminate()
    child.wait(timeout=3)
    raise SystemExit(0)
signal.signal(signal.SIGTERM,stop)
time.sleep(60)
'''
        unrelated = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)'])
        try:
            self.assertEqual(test_guard.main(['--timeout', '1', '--', sys.executable, '-c', script, str(marker)]), 124)
            child_pid = int(marker.read_text())
            with self.assertRaises(ProcessLookupError):
                os.kill(child_pid, 0)
            self.assertIsNone(unrelated.poll(), 'Guard touched an unrelated process')
        finally:
            unrelated.terminate()
            unrelated.wait(timeout=5)

    def test_process_inspection_failure_still_stops_owned_child(self):
        launched = []
        real_popen = subprocess.Popen
        def launch(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            launched.append(child)
            return child
        with mock.patch.object(test_guard, 'process_snapshot', side_effect=RuntimeError('injected ps failure')), \
             mock.patch.object(test_guard.subprocess, 'Popen', side_effect=launch):
            with self.assertRaisesRegex(RuntimeError, 'injected'):
                test_guard.main(['--', sys.executable, '-c', 'import time;time.sleep(60)'])
        self.assertEqual(len(launched), 1)
        self.assertIsNotNone(launched[0].poll())
        self.assertEqual(test_guard.LOCK_PATH.read_text(), '')

    def test_reparented_owned_process_is_still_signalled(self):
        with mock.patch.object(test_guard, 'process_snapshot', return_value={123: (1, 'same time', 'owned browser')}), \
             mock.patch.object(test_guard.os, 'kill') as kill:
            test_guard.signal_owned({123: ('same time', 'owned browser')}, signal.SIGTERM)
            kill.assert_called_once_with(123, signal.SIGTERM)

    def test_reused_pid_is_not_signalled(self):
        with mock.patch.object(test_guard, 'process_snapshot', return_value={123: (1, 'new time', 'unrelated')}), \
             mock.patch.object(test_guard.os, 'kill') as kill:
            test_guard.signal_owned({123: ('old time', 'old command')}, signal.SIGKILL)
            kill.assert_not_called()


if __name__ == '__main__':
    unittest.main()
