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

    def test_signals_during_spawn_are_handled_before_child_is_returned(self):
        real_popen = subprocess.Popen
        for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM, signal.SIGQUIT):
            launched = []
            def launch(*args, **kwargs):
                child = real_popen(*args, **kwargs)
                launched.append(child)
                os.kill(os.getpid(), sig)
                return child
            with self.subTest(signal=sig), mock.patch.object(test_guard.subprocess, 'Popen', side_effect=launch), \
                 mock.patch.object(test_guard, 'process_snapshot', return_value={}):
                self.assertEqual(test_guard.main(['--', sys.executable, '-c', 'import time;time.sleep(60)']), 128 + sig)
                self.assertIsNotNone(launched[0].poll())
                self.assertEqual(test_guard.LOCK_PATH.read_text(), '')

    def test_second_interrupt_forces_cleanup_without_full_grace_wait(self):
        marker = Path(self.temp.name) / 'ignoring.ready'
        real_popen = subprocess.Popen
        launched = []
        def launch(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            launched.append(child)
            import time
            deadline = time.monotonic() + 3
            while not marker.exists():
                if time.monotonic() > deadline: self.fail('Fixture failed to start')
                time.sleep(.01)
            os.kill(os.getpid(), signal.SIGINT)
            os.kill(os.getpid(), signal.SIGINT)
            return child
        script = 'import signal,sys,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);Path(sys.argv[1]).touch();time.sleep(60)'
        import time
        start = time.monotonic()
        with mock.patch.object(test_guard.subprocess, 'Popen', side_effect=launch), \
             mock.patch.object(test_guard, 'process_snapshot', return_value={}):
            self.assertEqual(test_guard.main(['--', sys.executable, '-c', script, str(marker)]), 130)
        self.assertLess(time.monotonic() - start, 3)
        self.assertIsNotNone(launched[0].poll())

    def test_interrupt_after_timeout_escalates_and_preserves_timeout_status(self):
        real_cleanup = test_guard.cleanup
        def cleanup(child, owned, force):
            os.kill(os.getpid(), signal.SIGINT)
            self.assertTrue(force())
            try:
                real_cleanup(child, owned, force)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)
        with mock.patch.object(test_guard, 'cleanup', side_effect=cleanup):
            self.assertEqual(test_guard.main(['--timeout', '.01', '--', sys.executable, '-c', 'import time;time.sleep(60)']), 124)

    def test_exited_group_permission_race_is_safe(self):
        child = mock.Mock(pid=123, poll=lambda: 0)
        with mock.patch.object(test_guard, 'process_snapshot', return_value={}), \
             mock.patch.object(test_guard.os, 'killpg', side_effect=PermissionError('exited group')):
            test_guard.cleanup(child, {})
        child.wait.assert_not_called()

    def test_live_group_permission_failure_is_not_hidden(self):
        child = mock.Mock(pid=123, poll=lambda: None)
        with mock.patch.object(test_guard, 'process_snapshot', return_value={}), \
             mock.patch.object(test_guard.os, 'killpg', side_effect=PermissionError('live group')):
            with self.assertRaises(PermissionError):
                test_guard.cleanup(child, {})

    def test_reaped_root_does_not_adopt_unrelated_children(self):
        owned = {}
        test_guard.remember_descendants(None, owned, {456: (123, 'new time', 'unrelated child')})
        self.assertEqual(owned, {})

    def test_signal_death_uses_shell_exit_status(self):
        self.assertEqual(test_guard.main(['--', sys.executable, '-c', 'import os,signal;os.kill(os.getpid(),signal.SIGTERM)']), 143)

    def test_recipe_process_gets_full_grace_period(self):
        marker = Path(self.temp.name) / 'graceful.done'
        ready = Path(self.temp.name) / 'ready'
        leaf = '''
import signal,sys,time
from pathlib import Path
def stop(*_):
    time.sleep(4)
    Path(sys.argv[1]).write_text('graceful')
    raise SystemExit(0)
signal.signal(signal.SIGTERM,stop)
Path(sys.argv[2]).write_text('ready')
time.sleep(60)
'''
        root = '''
import subprocess,sys,time
from pathlib import Path
subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[2],sys.argv[3]])
while not Path(sys.argv[3]).exists(): time.sleep(.01)
time.sleep(60)
'''
        rc = test_guard.main(['--timeout', '1', '--', sys.executable, '-c', root, leaf, str(marker), str(ready)])
        self.assertEqual(rc, 124)
        self.assertEqual(marker.read_text(), 'graceful')

    def test_command_change_keeps_descendant_ownership(self):
        owned = {123: ('same time', 'before exec')}
        snapshot = {123: (1, 'same time', 'after exec'), 234: (123, 'child time', 'detached child')}
        test_guard.remember_descendants(999, owned, snapshot)
        self.assertIn(234, owned)
        with mock.patch.object(test_guard, 'process_snapshot', return_value=snapshot), \
             mock.patch.object(test_guard.os, 'kill') as kill:
            test_guard.signal_owned(owned, signal.SIGTERM)
            self.assertEqual(kill.call_count, 2)

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
