import json
import os
from pathlib import Path
import select
import shlex
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parent.parent
HELPER = Path(os.environ.get('SSH_CONNECTIONS_HELPER', ROOT / 'assets/ssh-connections.py'))
PIDFILE = Path('/run/sshd/sshd.pid')


@unittest.skipUnless(os.environ.get('DEV_WORKSPACE_SSH_TEST_CONTAINER') == '1', 'Requires an explicitly disposable development workspace container')
class SshConnections(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if sys.platform != 'linux' or os.geteuid() != 0:
            raise unittest.SkipTest('Requires Linux container root')
        cls.temporary = tempfile.TemporaryDirectory(prefix='ssh-connections-')
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.directory = Path(cls.temporary.name)
        cls.keys = [cls.directory / name for name in ('accepted', 'rejected')]
        for key in cls.keys:
            subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)], check=True, capture_output=True)
        subprocess.run(['/usr/local/bin/prepare-workspace'], check=True, capture_output=True)
        Path('/var/lib/dev-workspace/ssh/authorized_keys').write_text(cls.keys[0].with_suffix('.pub').read_text())
        cls.known_hosts = cls.directory / 'known_hosts'
        cls.known_hosts.write_text('[127.0.0.1]:2222 ' + Path('/var/lib/dev-workspace/ssh/ssh_host_ed25519_key.pub').read_text())
        cls.daemon_log = tempfile.TemporaryFile()
        cls.addClassCleanup(cls.daemon_log.close)
        cls.daemon = subprocess.Popen(['/usr/sbin/sshd', '-D', '-e', '-f', '/etc/ssh/sshd_config'], stderr=cls.daemon_log)
        cls.addClassCleanup(cls.stop, cls.daemon)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if PIDFILE.exists():
                break
            if cls.daemon.poll() is not None:
                raise RuntimeError('Disposable SSH listener failed to start')
            time.sleep(0.05)
        else:
            raise RuntimeError('Disposable SSH listener did not become ready')

    @staticmethod
    def stop(process):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                stream.close()

    def setUp(self):
        self.await_count(0)

    def counter(self):
        return subprocess.run([sys.executable, str(HELPER)], capture_output=True, text=True, timeout=5)

    def await_count(self, expected):
        deadline = time.monotonic() + 10
        response = None
        while time.monotonic() < deadline:
            response = self.counter()
            self.assertEqual(response.returncode, 0, response.stderr)
            self.assertEqual(response.stderr, '')
            result = json.loads(response.stdout)
            if result == {'connections': expected}:
                return
            time.sleep(0.05)
        self.assertEqual(json.loads(response.stdout), {'connections': expected})

    def arguments(self, options=(), key=None):
        return [
            'ssh', '-F', '/dev/null', '-p', '2222', '-i', str(key or self.keys[0]),
            '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(self.known_hosts),
            *options, 'dev@127.0.0.1',
        ]

    def start(self, command=None, options=()):
        arguments = self.arguments(options)
        if command is not None:
            arguments.append(command)
        process = subprocess.Popen(arguments, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(self.stop, process)
        return process

    def read_exact(self, stream, length):
        result = bytearray()
        deadline = time.monotonic() + 10
        while len(result) < length:
            remaining = deadline - time.monotonic()
            self.assertGreater(remaining, 0, 'SSH output did not arrive')
            readable, _, _ = select.select([stream], [], [], remaining)
            self.assertTrue(readable, 'SSH output did not arrive')
            chunk = os.read(stream.fileno(), length - len(result))
            self.assertNotEqual(chunk, b'', 'SSH closed before returning output')
            result.extend(chunk)
        return bytes(result)

    def session(self, options=(), command='printf ready; exec cat'):
        process = self.start(command, options)
        self.assertEqual(self.read_exact(process.stdout, 5), b'ready')
        return process

    def test_independent_authenticated_transports_follow_connect_and_disconnect(self):
        first = self.session()
        self.await_count(1)
        second = self.session()
        self.await_count(2)
        self.stop(first)
        self.await_count(1)
        self.stop(second)
        self.await_count(0)

    def test_unauthenticated_socket_and_rejected_key_are_excluded(self):
        connection = socket.create_connection(('127.0.0.1', 2222), timeout=5)
        self.addCleanup(connection.close)
        self.assertTrue(connection.recv(1024).startswith(b'SSH-2.0-'))
        self.await_count(0)
        result = subprocess.run(self.arguments(key=self.keys[1]) + ['printf forbidden'], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 255)
        self.assertIn(b'Permission denied', result.stderr)
        self.assertEqual(result.stdout, b'')
        self.await_count(0)
        accepted = self.session()
        self.await_count(1)
        self.stop(accepted)
        self.await_count(0)

    def test_known_user_waiting_for_private_key_unlock_is_not_authenticated(self):
        key = self.directory / 'encrypted'
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', 'disposable-test-passphrase', '-f', str(key)], check=True, capture_output=True)
        authorized = Path('/var/lib/dev-workspace/ssh/authorized_keys')
        original = authorized.read_text()
        authorized.write_text(original + key.with_suffix('.pub').read_text())
        self.addCleanup(authorized.write_text, original)
        marker = self.directory / 'waiting-for-passphrase'
        askpass = self.directory / 'askpass'
        askpass.write_text('#!/usr/bin/python3\nfrom pathlib import Path\nimport time\nPath(' + repr(str(marker)) + ').write_text("waiting")\ntime.sleep(30)\n')
        askpass.chmod(0o700)
        arguments = self.arguments(key=key)
        arguments[arguments.index('BatchMode=yes')] = 'BatchMode=no'
        environment = dict(os.environ, SSH_ASKPASS=str(askpass), SSH_ASKPASS_REQUIRE='force', SSH_AUTH_SOCK='', DISPLAY=':0')
        waiting = subprocess.Popen(arguments + ['printf forbidden'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment, start_new_session=True)
        self.addCleanup(self.stop, waiting)
        try:
            deadline = time.monotonic() + 10
            while not marker.exists() and time.monotonic() < deadline:
                self.assertIsNone(waiting.poll(), 'SSH exited before requesting the key passphrase')
                time.sleep(0.02)
            self.assertEqual(marker.read_text(), 'waiting')
            self.await_count(0)
            accepted = self.session()
            self.await_count(1)
            self.stop(accepted)
            self.await_count(0)
        finally:
            try:
                os.killpg(waiting.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            self.stop(waiting)
        self.await_count(0)

    def test_forwarding_only_transport_is_counted_without_a_shell(self):
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        process = self.start(options=('-N', '-o', 'ExitOnForwardFailure=yes', '-L', '127.0.0.1:' + str(port) + ':127.0.0.1:2222'))
        self.await_count(1)
        self.assertIsNone(process.poll())
        forwarded = socket.create_connection(('127.0.0.1', port), timeout=5)
        self.addCleanup(forwarded.close)
        self.assertTrue(forwarded.recv(1024).startswith(b'SSH-2.0-'))
        self.await_count(1)
        forwarded.close()
        self.stop(process)
        self.await_count(0)

    def test_multiple_multiplexed_channels_count_as_one_transport(self):
        control = self.directory / ('control-' + str(time.monotonic_ns()))
        master = self.start(options=('-M', '-N', '-S', str(control)))
        self.await_count(1)
        deadline = time.monotonic() + 5
        while not control.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(control.exists())
        first = self.session(('-S', str(control), '-o', 'ControlMaster=no'))
        second = self.session(('-S', str(control), '-o', 'ControlMaster=no'))
        self.await_count(1)
        self.stop(first)
        self.await_count(1)
        self.stop(second)
        self.await_count(1)
        self.stop(master)
        self.await_count(0)

    def test_internal_sftp_counts_one_transport(self):
        process = self.start('sftp', ('-s',))
        process.stdin.write(struct.pack('>IBI', 5, 1, 3))
        process.stdin.flush()
        length = struct.unpack('>I', self.read_exact(process.stdout, 4))[0]
        self.assertLess(length, 1024 * 1024)
        response = self.read_exact(process.stdout, length)
        self.assertEqual(response[:5], struct.pack('>BI', 2, 3))
        self.await_count(1)
        self.stop(process)
        self.await_count(0)

    def test_user_processes_cannot_inflate_the_count_with_ssh_names(self):
        script = "import ctypes,sys; ctypes.CDLL(None).prctl(15,b'sshd-session',0,0,0); print('ready',end='',flush=True); sys.stdin.read()"
        process = self.session(command='exec python3 -c ' + shlex.quote(script))
        self.await_count(1)
        self.stop(process)
        self.await_count(0)

    def test_missing_or_unrelated_pidfile_reports_unavailable(self):
        original = PIDFILE.read_bytes()
        try:
            PIDFILE.unlink()
            missing = self.counter()
            self.assertEqual(missing.returncode, 1)
            self.assertEqual(missing.stdout, '')
            self.assertEqual(missing.stderr, 'SSH connection count is unavailable.\n')
            PIDFILE.write_text(str(os.getpid()) + '\n')
            unrelated = self.counter()
            self.assertEqual(unrelated.returncode, 1)
            self.assertEqual(unrelated.stdout, '')
            self.assertEqual(unrelated.stderr, 'SSH connection count is unavailable.\n')
            PIDFILE.unlink()
            os.mkfifo(PIDFILE, 0o600)
            invalid_type = self.counter()
            self.assertEqual(invalid_type.returncode, 1)
            self.assertEqual(invalid_type.stdout, '')
            self.assertEqual(invalid_type.stderr, 'SSH connection count is unavailable.\n')
        finally:
            PIDFILE.unlink(missing_ok=True)
            PIDFILE.write_bytes(original)
        self.await_count(0)


if __name__ == '__main__':
    unittest.main()
