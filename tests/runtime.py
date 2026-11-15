#!/usr/bin/env python3
import json
import os
from pathlib import Path
import selectors
import shlex
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import uuid


IMAGE = os.environ.get('DEV_WORKSPACE_TEST_IMAGE', 'dev-workspace:runtime-test')


def run(arguments, input=None, check=True, timeout=60):
    result = subprocess.run(arguments, input=input, text=True, capture_output=True, timeout=timeout)
    if check and result.returncode != 0:
        raise RuntimeError(f"{shlex.join(arguments)} failed ({result.returncode}): {result.stdout}{result.stderr}")
    return result


def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def read_output(stream, length, timeout=10):
    output = b''
    deadline = time.monotonic() + timeout
    with selectors.DefaultSelector() as selector:
        selector.register(stream, selectors.EVENT_READ)
        while len(output) < length:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise TimeoutError('SSH session did not produce its expected output')
            chunk = os.read(stream.fileno(), length - len(output))
            if not chunk:
                break
            output += chunk
    return output


class WorkspaceRuntime(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='dev-workspace-test-')
        self.directory = Path(self.temporary.name)
        self.identifier = 'dev-workspace-test-' + uuid.uuid4().hex[:12]
        self.volumes = [self.identifier + '-home', self.identifier + '-ssh']
        self.containers = []
        self.processes = []
        self.keys = []
        self.addCleanup(self.cleanup)
        for name in ('owner', 'second', 'unknown'):
            key = self.directory / name
            run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)])
            self.keys.append(key)
        for volume in self.volumes:
            run(['docker', 'volume', 'create', volume])
        self.write_keys([self.keys[0]], running=False)
        self.start()

    def cleanup(self):
        failures = []
        for process in self.processes:
            try:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired) as error:
                failures.append(str(error))
            finally:
                if process.stdout is not None:
                    process.stdout.close()
                if process.stderr is not None:
                    process.stderr.close()
        for container in self.containers:
            try:
                result = run(['docker', 'rm', '-f', container], check=False, timeout=15)
                if result.returncode != 0 and 'no such container' not in result.stderr.lower():
                    failures.append(f'{container}: {result.stderr.strip()}')
            except (OSError, subprocess.TimeoutExpired) as error:
                failures.append(str(error))
        for volume in self.volumes:
            try:
                result = run(['docker', 'volume', 'rm', volume], check=False, timeout=15)
                if result.returncode != 0 and 'no such volume' not in result.stderr.lower():
                    failures.append(f'{volume}: {result.stderr.strip()}')
            except (OSError, subprocess.TimeoutExpired) as error:
                failures.append(str(error))
        self.temporary.cleanup()
        if failures:
            raise RuntimeError('Runtime fixture cleanup failed: ' + '; '.join(failures))

    def write_keys(self, keys, running=True):
        contents = ''.join(key.with_suffix('.pub').read_text() for key in keys)
        script = "import os,sys; p='/var/lib/dev-workspace/ssh/authorized_keys'; t=p+'.new'; f=open(t,'w'); f.write(sys.stdin.read()); f.close(); os.chmod(t,0o644); os.replace(t,p)"
        if running:
            arguments = ['docker', 'exec', '-i', self.container, 'python3', '-c', script]
        else:
            helper = self.identifier + '-key-writer'
            self.containers.append(helper)
            arguments = ['docker', 'run', '--rm', '--name', helper, '-i', '--entrypoint', 'python3', '-v', self.volumes[1] + ':/var/lib/dev-workspace/ssh', IMAGE, '-c', script]
        run(arguments, input=contents)

    def start(self):
        self.container = self.identifier + '-' + str(len(self.containers))
        self.containers.append(self.container)
        run([
            'docker', 'run', '-d', '--name', self.container,
            '-p', '127.0.0.1::2222',
            '-v', self.volumes[0] + ':/home/dev',
            '-v', self.volumes[1] + ':/var/lib/dev-workspace/ssh',
            '--entrypoint', '/bin/sh', IMAGE, '-ec',
            '/usr/local/bin/prepare-workspace; exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config',
        ])
        self.port = run(['docker', 'port', self.container, '2222/tcp']).stdout.strip().rsplit(':', 1)[1]
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            public = run(['docker', 'exec', self.container, 'cat', '/var/lib/dev-workspace/ssh/ssh_host_ed25519_key.pub'], check=False)
            if public.returncode == 0:
                self.host_public = public.stdout.strip()
                self.known_hosts = self.directory / 'known_hosts'
                self.known_hosts.write_text(f'[127.0.0.1]:{self.port} {self.host_public}\n')
                result = self.ssh('printf ready', check=False)
                if result.returncode == 0 and result.stdout == 'ready':
                    return
            state = run(['docker', 'inspect', '--format', '{{.State.Running}}', self.container]).stdout.strip()
            if state != 'true':
                break
            time.sleep(0.2)
        self.fail(run(['docker', 'logs', self.container], check=False).stderr)

    def ssh_arguments(self, key=None, user='dev', extra=None):
        return [
            'ssh', '-F', '/dev/null', '-p', self.port,
            '-i', str(key or self.keys[0]),
            '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
            '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'UserKnownHostsFile=' + str(self.known_hosts),
            *(extra or []), user + '@127.0.0.1',
        ]

    def ssh(self, command, key=None, user='dev', extra=None, check=True):
        return run(self.ssh_arguments(key, user, extra) + [command], check=check)

    def test_remote_shell_selects_workspace_container_engine_for_packaging(self):
        result = self.ssh('printf "%s\\n" "$STARTOS_USE_PODMAN" "$DOCKER_HOST" "$CONTAINER_HOST" "$PODMAN_COMPOSE_PROVIDER"')
        self.assertEqual(result.stdout, '1\nunix:///run/dev-workspace-podman/podman.sock\nunix:///run/dev-workspace-podman/podman.sock\n/usr/bin/podman-compose\n')

    def remote_python(self, script, check=True):
        return self.ssh('python3 -c ' + shlex.quote(script), check=check)

    def test_registered_key_gets_nonroot_shell_and_clean_command_output(self):
        self.assertEqual(self.ssh('id -un; id -u; printf remote-workspace-ready').stdout, 'dev\n1000\nremote-workspace-ready')

    def test_unknown_key_and_root_and_password_authentication_are_rejected(self):
        for arguments in (
            {'key': self.keys[2]},
            {'user': 'root'},
            {'extra': ['-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password']},
            {'extra': ['-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=keyboard-interactive']},
        ):
            with self.subTest(arguments=arguments):
                response = self.ssh('printf unauthorized', check=False, **arguments)
                self.assertEqual(response.returncode, 255)
                self.assertIn('Permission denied', response.stderr)
                self.assertEqual(response.stdout, '')

    def test_key_updates_allow_new_identity_and_reject_removed_identity(self):
        self.write_keys(self.keys[:2])
        self.assertEqual(self.ssh('printf second', key=self.keys[1]).stdout, 'second')
        self.write_keys([self.keys[1]])
        removed = self.ssh('printf removed', check=False)
        self.assertEqual(removed.returncode, 255)
        self.assertEqual(self.ssh('printf retained', key=self.keys[1]).stdout, 'retained')

    def test_key_removal_does_not_terminate_an_authenticated_session(self):
        process = subprocess.Popen(self.ssh_arguments() + ['printf authenticated; sleep 2; printf session-completed'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.processes.append(process)
        self.assertEqual(read_output(process.stdout, len(b'authenticated')), b'authenticated')
        self.write_keys([])
        self.assertEqual(self.ssh('printf denied', check=False).returncode, 255)
        output, errors = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 0, errors)
        self.assertEqual(output, b'session-completed')

    def test_independent_installations_generate_distinct_host_identities(self):
        new_home, new_keys = self.identifier + '-other-home', self.identifier + '-other-ssh'
        self.volumes.extend([new_home, new_keys])
        for volume in (new_home, new_keys):
            run(['docker', 'volume', 'create', volume])
        helper = self.identifier + '-other-identity'
        self.containers.append(helper)
        result = run([
            'docker', 'run', '--rm', '--name', helper, '-v', new_home + ':/home/dev',
            '-v', new_keys + ':/var/lib/dev-workspace/ssh', '--entrypoint', '/bin/sh',
            IMAGE, '-ec', '/usr/local/bin/prepare-workspace; cat /var/lib/dev-workspace/ssh/ssh_host_ed25519_key.pub',
        ])
        self.assertNotEqual(result.stdout.strip(), self.host_public)

    def test_user_cannot_read_host_private_key_or_rewrite_authorized_keys(self):
        for script in (
            "from pathlib import Path; print(Path('/var/lib/dev-workspace/ssh/ssh_host_ed25519_key').read_text())",
            "from pathlib import Path; Path('/var/lib/dev-workspace/ssh/authorized_keys').write_text('replacement')",
            "from pathlib import Path; Path('/etc/ssh/sshd_config').write_text('replacement')",
        ):
            with self.subTest(script=script):
                result = self.remote_python(script, check=False)
                self.assertEqual(result.returncode, 1)
                self.assertIn('PermissionError', result.stderr)
        self.assertEqual(self.ssh('printf still-authorized').stdout, 'still-authorized')

    def test_sftp_round_trip_preserves_exact_content(self):
        source = self.directory / 'upload.txt'
        target = self.directory / 'download.txt'
        source.write_bytes(b'workspace transfer\x00with binary bytes\n')
        arguments = [
            'sftp', '-F', '/dev/null', '-P', self.port, '-i', str(self.keys[0]),
            '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(self.known_hosts),
            '-b', '-', 'dev@127.0.0.1',
        ]
        batch = f'put "{source}" /home/dev/projects/transfer.txt\nget /home/dev/projects/transfer.txt "{target}"\n'
        run(arguments, input=batch)
        self.assertEqual(target.read_bytes(), source.read_bytes())

    def test_two_applications_are_reachable_through_ssh_port_forwarding(self):
        self.remote_python("from pathlib import Path; p=Path('/home/dev/projects'); (p/'one').mkdir(); (p/'two').mkdir(); (p/'one/index.html').write_text('first project'); (p/'two/index.html').write_text('second project')")
        self.ssh("tmux new-session -d -s web-one 'python3 -m http.server 8131 --bind 127.0.0.1 --directory /home/dev/projects/one'; tmux new-session -d -s web-two 'python3 -m http.server 8132 --bind 127.0.0.1 --directory /home/dev/projects/two'")
        first, second = free_port(), free_port()
        while second == first:
            second = free_port()
        process = subprocess.Popen(self.ssh_arguments(extra=['-N', '-o', 'ExitOnForwardFailure=yes', '-L', f'{first}:127.0.0.1:8131', '-L', f'{second}:127.0.0.1:8132']), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.processes.append(process)
        for port, expected in ((first, b'first project'), (second, b'second project')):
            deadline = time.monotonic() + 15
            response = None
            while time.monotonic() < deadline:
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=2) as request:
                        response = request.read()
                    break
                except (urllib.error.URLError, TimeoutError):
                    time.sleep(0.1)
            self.assertEqual(response, expected)

    def test_tmux_session_survives_ssh_disconnect(self):
        self.ssh("tmux new-session -d -s disconnected 'sleep 1; printf session-survived > /home/dev/projects/session.txt; sleep 30'")
        deadline = time.monotonic() + 10
        result = None
        while time.monotonic() < deadline:
            result = self.ssh('cat /home/dev/projects/session.txt', check=False)
            if result.returncode == 0:
                break
            time.sleep(0.2)
        self.assertEqual(result.stdout, 'session-survived')

    def test_recreation_preserves_project_git_state_home_customization_and_identity(self):
        self.remote_python("from pathlib import Path; h=Path('/home/dev'); (h/'.bashrc').write_text('export CUSTOM_WORKSPACE=preserved\\n'); (h/'projects/project').mkdir(); (h/'projects/project/source.txt').write_text('first version\\n'); (h/'.local').mkdir(exist_ok=True); (h/'.local/bin').mkdir(exist_ok=True); p=h/'.local/bin/workspace-probe'; p.write_text('#!/bin/sh\\nprintf user-tool-preserved\\n'); p.chmod(0o755)")
        self.ssh('cd /home/dev/projects/project && git init -q && git -c user.name=Fixture -c user.email=fixture@example.invalid add source.txt && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm initial && printf uncommitted >> source.txt')
        fingerprint = self.host_public
        run(['docker', 'rm', '-f', self.container])
        self.start()
        self.assertEqual(self.host_public, fingerprint)
        self.assertEqual(self.ssh('cat /home/dev/projects/project/source.txt').stdout, 'first version\nuncommitted')
        self.assertEqual(self.ssh('cd /home/dev/projects/project && git status --porcelain').stdout, ' M source.txt\n')
        self.assertEqual(self.ssh('printf "%s" "$CUSTOM_WORKSPACE"; workspace-probe').stdout, 'preserveduser-tool-preserved')

    def test_node_python_and_mise_execute_in_noninteractive_shell(self):
        self.assertEqual(self.ssh("node -e 'process.stdout.write(String(6 * 7))'").stdout, '42')
        self.assertEqual(self.ssh("python3 -c 'print(6 * 7)' ").stdout, '42\n')
        self.assertEqual(self.ssh('mise --version').stdout.split()[0], '2026.11.2')

    @unittest.skipUnless(os.environ.get('DEV_WORKSPACE_TEST_INSTALL_TOOLS') == '1', 'Set DEV_WORKSPACE_TEST_INSTALL_TOOLS=1 for the networked runtime installation check')
    def test_user_installed_node_version_survives_recreation(self):
        run(self.ssh_arguments() + ['mise use --global node@22.23.3'], timeout=300)
        self.assertEqual(self.ssh('node --version').stdout, 'v22.23.3\n')
        run(['docker', 'rm', '-f', self.container])
        self.start()
        self.assertEqual(self.ssh('node --version').stdout, 'v22.23.3\n')

    def test_repeated_preparation_preserves_user_content(self):
        self.remote_python("from pathlib import Path; h=Path('/home/dev'); (h/'.profile').write_text('user profile\\n'); (h/'projects/user.txt').write_text('unchanged')")
        fingerprint = self.host_public
        run(['docker', 'exec', self.container, '/usr/local/bin/prepare-workspace'])
        self.assertEqual(self.ssh('cat /home/dev/.profile').stdout, 'user profile\n')
        self.assertEqual(self.ssh('cat /home/dev/projects/user.txt').stdout, 'unchanged')
        public = run(['docker', 'exec', self.container, 'cat', '/var/lib/dev-workspace/ssh/ssh_host_ed25519_key.pub']).stdout.strip()
        self.assertEqual(public, fingerprint)

    def test_writes_to_unwritable_destination_report_failure(self):
        result = self.remote_python("from pathlib import Path; Path('/etc/workspace-denied').write_text('must fail')", check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('PermissionError', result.stderr)

    def test_full_home_during_default_seeding_can_recover_without_partial_configuration(self):
        helper = self.identifier + '-seed-recovery'
        self.containers.append(helper)
        script = """
import json
from pathlib import Path
import subprocess
source = Path('/usr/local/share/dev-workspace/home-defaults/.bashrc')
destination = Path('/home/dev/.bashrc')
source.write_bytes(b'x' * 2097152)
failed = subprocess.run(['/usr/local/bin/prepare-workspace'], capture_output=True, text=True)
partial = destination.exists()
source.write_text('export RECOVERED_DEFAULT=yes\\n')
recovered = subprocess.run(['/usr/local/bin/prepare-workspace'], capture_output=True, text=True)
print(json.dumps({
    'failed_status': failed.returncode,
    'failed_error': failed.stderr,
    'partial_configuration': partial,
    'recovered_status': recovered.returncode,
    'recovered_error': recovered.stderr,
    'content': destination.read_text() if destination.exists() else None,
}))
"""
        response = run([
            'docker', 'run', '--rm', '--name', helper,
            '--tmpfs', '/home/dev:rw,size=1048576',
            '--entrypoint', 'python3', IMAGE, '-c', script,
        ])
        result = json.loads(response.stdout)
        self.assertEqual(result['failed_status'], 1)
        self.assertIn('No space left on device', result['failed_error'])
        self.assertFalse(result['partial_configuration'])
        self.assertEqual(result['recovered_status'], 0, result['recovered_error'])
        self.assertEqual(result['content'], 'export RECOVERED_DEFAULT=yes\n')


if __name__ == '__main__':
    unittest.main(verbosity=2)
