from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import pty
import select
import ssl
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid


ROOT = Path(__file__).resolve().parent.parent
HELPER = Path(os.environ.get('STARTOS_TARGET_HELPER', ROOT / 'assets/startos-target.py'))
SEED = Path('/run/dev-workspace/local-startos.json')
FAKE_CLI = '''#!/usr/bin/python3
import getpass,json,os,pathlib,sys,time
args=sys.argv[1:]
url=args[args.index('-H')+1]
key=pathlib.Path(args[args.index('--id-key-path')+1])
ca=pathlib.Path(args[args.index('--root-ca')+1])
command=args[6:]
if any(name in os.environ for name in ('PASSWORD','BACKUP_PASSWORD','CIFS_PASSWORD')):
 print('secret environment escaped',file=sys.stderr);sys.exit(7)
if command==['auth','login']:
 if getpass.getpass('Password: ')!='fixture-password':sys.exit(5)
 key.write_text('fixture-identity:'+url)
 print('Enrolled.');sys.exit(0)
if command==['--help']:
 print('Server command help');sys.exit(0)
if command and command[0]=='fail':
 print('sensitive-upstream-stdout');print('sensitive-upstream-stderr',file=sys.stderr);sys.exit(8)
if not ca.read_text().startswith('-----BEGIN CERTIFICATE-----') or not key.exists() or key.read_text()!='fixture-identity:'+url:
 print('sensitive-authentication-diagnostic',file=sys.stderr);sys.exit(9)
if command[:2]==['server','fail']:
 print('sensitive-upstream-stdout');print(command[2] if len(command)>2 else 'sensitive-upstream-stderr',file=sys.stderr);sys.exit(8)
if command[:2]==['package','logs']:
 print('first live log line',flush=True);time.sleep(1);print('last live log line',flush=True);sys.exit(0)
if command and command[0]=='echo':
 print(json.dumps({'server':url,'input':sys.stdin.read(),'interactive':sys.stdin.isatty()}));sys.exit(0)
print(json.dumps({'server':url,'authenticated':True}))
'''


class HttpsBoundary(BaseHTTPRequestHandler):
    def log_message(self, format, *arguments):
        pass

    def do_GET(self):
        self.send_response(self.server.response_status)
        self.end_headers()
        self.wfile.write(b'Public fixture server')


@unittest.skipUnless(os.environ.get('DEV_WORKSPACE_TARGET_TEST_CONTAINER') == '1', 'Requires an explicitly disposable workspace container')
class StartosTarget(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if sys.platform != 'linux' or os.geteuid() != 0:
            raise unittest.SkipTest('Requires disposable Linux container root for the runtime seed fixture')
        cls.certificates = tempfile.TemporaryDirectory(prefix='startos-target-certificates-')
        cls.addClassCleanup(cls.certificates.cleanup)
        cls.ca = Path(cls.certificates.name) / 'ca.pem'
        cls.tls_key = Path(cls.certificates.name) / 'server.key'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', str(cls.tls_key), '-out', str(cls.ca)], check=True, capture_output=True)
        cls.other_ca = Path(cls.certificates.name) / 'other-ca.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=unrelated', '-keyout', str(Path(cls.certificates.name) / 'other.key'), '-out', str(cls.other_ca)], check=True, capture_output=True)
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), HttpsBoundary)
        cls.server.response_status = 200
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cls.ca, cls.tls_key)
        cls.server.socket = context.wrap_socket(cls.server.socket, server_side=True)
        cls.url = 'https://127.0.0.1:' + str(cls.server.server_port)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.addClassCleanup(cls.server.server_close)
        cls.addClassCleanup(cls.server.shutdown)
        SEED.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        if SEED.exists():
            raise RuntimeError('Disposable fixture must not contain an existing local server seed')

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='startos-target-')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.bin = self.directory / 'bin'
        self.bin.mkdir()
        self.cli = self.bin / 'start-cli'
        self.cli.write_text(FAKE_CLI)
        self.cli.chmod(0o755)
        self.environment = dict(os.environ, XDG_CONFIG_HOME=str(self.directory / 'config'), PATH=str(self.bin) + os.pathsep + os.environ['PATH'])
        self.targets = self.directory / 'config/dev-workspace/startos/targets'
        self.server.response_status = 200
        self.addCleanup(SEED.unlink, missing_ok=True)
        self.seed()

    def command(self, *arguments, input=None, environment=None):
        return subprocess.run([sys.executable, str(HELPER), *arguments], input=input, capture_output=True, text=True, env=environment or self.environment, timeout=10)

    def add(self, name='alpha', url='https://alpha.example'):
        result = self.command('add', name, '--url', url, '--ca-file', str(self.ca))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')
        return json.loads(result.stdout)

    def enrolled(self, name='alpha', url='https://alpha.example'):
        self.add(name, url)
        key = self.targets / name / 'id.key.pem'
        key.write_text('fixture-identity:' + url)
        key.chmod(0o600)
        return key

    def seed(self, **changes):
        value = {'version': 1, 'url': self.url, 'rootCa': self.ca.read_text(), 'restoreGeneration': None}
        value.update(changes)
        SEED.write_text(json.dumps(value))
        SEED.chmod(0o644)

    def terminal(self, arguments, password=None, user=None, environment=None):
        master, slave = pty.openpty()
        identity = {'user': user, 'group': user, 'extra_groups': []} if user is not None else {}
        process = subprocess.Popen([sys.executable, str(HELPER), *arguments], stdin=slave, stdout=slave, stderr=slave, env=environment or self.environment, start_new_session=True, **identity)
        os.close(slave)
        output = bytearray()
        submitted = False
        deadline = time.monotonic() + 10
        try:
            while time.monotonic() < deadline:
                readable, _, _ = select.select([master], [], [], 0.05)
                if readable:
                    try:
                        chunk = os.read(master, 4096)
                    except OSError:
                        break
                    if not chunk:
                        break
                    output.extend(chunk)
                if password and b'Password: ' in output and not submitted:
                    os.write(master, password.encode() + b'\n')
                    submitted = True
                if process.poll() is not None and not readable:
                    break
            process.wait(timeout=2)
            return process.returncode, output.decode()
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            os.close(master)

    def test_add_saves_private_public_metadata_without_enrollment(self):
        result = self.add(url='https://ALPHA.example:443/')
        self.assertEqual(result['url'], 'https://alpha.example')
        self.assertFalse(result['identityPresent'])
        target = self.targets / 'alpha'
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((target / 'config.json').stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((target / 'root-ca.pem').stat().st_mode), 0o600)
        self.assertFalse((target / 'id.key.pem').exists())

    def test_repeated_add_preserves_an_existing_identity(self):
        key = self.enrolled()
        original = key.read_bytes()
        self.assertTrue(self.add()['identityPresent'])
        self.assertEqual(key.read_bytes(), original)
        rejected = self.command('add', 'alpha', '--url', 'https://different.example', '--ca-file', str(self.ca))
        self.assertEqual(rejected.returncode, 1)
        self.assertEqual(key.read_bytes(), original)
        self.assertEqual(json.loads(self.command('info', 'alpha').stdout)['url'], 'https://alpha.example')

    def test_names_and_urls_reject_traversal_and_embedded_credentials(self):
        for name, url in [('../escape', 'https://valid.example'), ('Bad Name', 'https://valid.example'), ('alpha', 'http://insecure.example'), ('alpha', 'https://user:secret-value@server.example'), ('alpha', 'https://server.example/?secret-value'), ('alpha', 'https://server.example/#secret-value'), ('alpha', 'https://server.example/extra'), ('alpha', 'https://server.example:99999'), ('alpha', 'https://server.example\n'), ('alpha', 'https://[::1]extra'), ('alpha', 'https://server.example:')]:
            with self.subTest(name=name, url=url):
                result = self.command('add', name, '--url', url, '--ca-file', str(self.ca))
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, '')
                self.assertNotIn('secret-value', result.stderr)
        self.assertFalse(self.targets.exists())

    def test_ca_input_rejects_private_keys_and_non_certificates(self):
        result = self.command('add', 'alpha', '--url', 'https://alpha.example', '--ca-file', str(self.tls_key))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertNotIn('PRIVATE KEY', result.stderr)
        self.assertFalse(self.targets.exists())

    def test_list_and_info_show_only_public_metadata(self):
        self.enrolled('zeta', 'https://zeta.example').chmod(0)
        self.add('alpha')
        response = self.command('list')
        self.assertEqual(response.returncode, 0, response.stderr)
        items = json.loads(response.stdout)
        self.assertEqual([item['name'] for item in items], ['alpha', 'zeta'])
        self.assertEqual([item['identityPresent'] for item in items], [False, True])
        self.assertEqual(set(items[0]), {'name', 'url', 'rootCaSha256', 'certificateFingerprints', 'identityPresent'})
        self.assertNotIn('fixture-identity', response.stdout)

    def test_tampered_ca_and_symlink_identity_are_rejected(self):
        self.add()
        target = self.targets / 'alpha'
        saved = (target / 'root-ca.pem').read_bytes()
        (target / 'root-ca.pem').write_text('invalid-public-certificate')
        self.assertEqual(self.command('info', 'alpha').returncode, 1)
        (target / 'root-ca.pem').write_bytes(saved)
        (target / 'id.key.pem').symlink_to(self.tls_key)
        result = self.command('info', 'alpha')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')

    def test_run_keeps_targets_and_enrolled_identities_separate(self):
        self.enrolled()
        self.enrolled('beta', 'https://beta.example')
        for name, url in [('alpha', 'https://alpha.example'), ('beta', 'https://beta.example')]:
            response = self.command('run', name, 'package', 'list', '--format', 'json')
            self.assertEqual(response.returncode, 0, response.stderr)
            self.assertEqual(json.loads(response.stdout), {'server': url, 'authenticated': True})

    def test_run_rejects_target_overrides_and_password_arguments(self):
        key = self.enrolled()
        for arguments in [('--host=https://wrong.example',), ('-Hhttps://wrong.example',), ('--config', 'other.yaml'), ('--id-key-path=/tmp/wrong',), ('--id-key-gpg=wrong',), ('--root-ca=wrong',), ('--insecure',), ('--proxy=wrong',), ('--password=do-not-print',), ('--backup-password', 'do-not-print')]:
            with self.subTest(arguments=arguments):
                response = self.command('run', 'alpha', 'package', 'list', *arguments)
                self.assertEqual(response.returncode, 1)
                self.assertEqual(response.stdout, '')
                self.assertNotIn('do-not-print', response.stderr)
                self.assertEqual(key.read_text(), 'fixture-identity:https://alpha.example')

    def test_run_never_enrolls_a_missing_identity_and_redacts_failures(self):
        self.add()
        response = self.command('run', 'alpha', 'package', 'list')
        self.assertEqual(response.returncode, 1)
        self.assertEqual(response.stdout, '')
        self.assertNotIn('sensitive-', response.stderr)
        self.assertFalse((self.targets / 'alpha/id.key.pem').exists())
        for command in [('auth', 'login'), ('auth', '--', 'login')]:
            self.assertEqual(self.command('run', 'alpha', *command).returncode, 1)
        self.enrolled()
        failed = self.command('run', 'alpha', 'server', 'fail')
        self.assertEqual(failed.returncode, 1)
        self.assertEqual(failed.stdout, 'sensitive-upstream-stdout\n')
        self.assertNotIn('sensitive-', failed.stderr)

    def test_run_streams_requested_logs_before_the_command_completes(self):
        self.enrolled()
        process = subprocess.Popen([sys.executable, str(HELPER), 'run', 'alpha', 'package', 'logs', 'fixture', '--follow'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.environment)
        try:
            readable, _, _ = select.select([process.stdout], [], [], 5)
            self.assertTrue(readable)
            self.assertEqual(process.stdout.readline(), b'first live log line\n')
            self.assertIsNone(process.poll())
            remaining, errors = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0, errors)
            self.assertEqual(remaining, b'last live log line\n')
            self.assertEqual(errors, b'')
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            process.stdout.close()
            process.stderr.close()

    def test_run_reports_useful_error_categories_without_private_diagnostics(self):
        self.enrolled()
        for diagnostic, expected in [('Authorization denied: private-detail', 'rejected this target identity'), ('TLS certificate failed: private-detail', 'HTTPS verification failed'), ('Connection refused: private-detail', 'could not be reached')]:
            with self.subTest(diagnostic=diagnostic):
                response = self.command('run', 'alpha', 'server', 'fail', diagnostic)
                self.assertEqual(response.returncode, 1)
                self.assertIn(expected, response.stderr)
                self.assertNotIn('private-detail', response.stderr)

    def test_run_forwards_piped_input_without_inherited_passwords(self):
        self.enrolled()
        environment = dict(self.environment, PASSWORD='do-not-forward', BACKUP_PASSWORD='do-not-forward', CIFS_PASSWORD='do-not-forward')
        response = self.command('run', 'alpha', 'echo', input='fixture-input', environment=environment)
        self.assertEqual(response.returncode, 0, response.stderr)
        self.assertEqual(json.loads(response.stdout), {'server': 'https://alpha.example', 'input': 'fixture-input', 'interactive': False})
        code, output = self.terminal(['run', 'alpha', 'echo'])
        self.assertEqual(code, 0, output)
        self.assertEqual(json.loads(output), {'server': 'https://alpha.example', 'input': '', 'interactive': False})

    def test_login_requires_a_terminal_and_saves_only_its_own_identity(self):
        self.add()
        self.assertEqual(self.command('login', 'alpha', input='fixture-password\n').returncode, 1)
        code, output = self.terminal(['login', 'alpha'], password='fixture-password')
        self.assertEqual(code, 0, output)
        self.assertNotIn('fixture-password', output)
        key = self.targets / 'alpha/id.key.pem'
        self.assertEqual(key.read_text(), 'fixture-identity:https://alpha.example')
        self.assertEqual(stat.S_IMODE(key.stat().st_mode), 0o600)
        self.assertNotIn('fixture-password', (self.targets / 'alpha/config.json').read_text())

    def test_existing_global_configuration_blocks_isolated_access(self):
        self.enrolled()
        directory = Path.home() / '.startos'
        directory.mkdir(mode=0o700, exist_ok=True)
        configuration = directory / 'config.yaml'
        self.assertFalse(configuration.exists())
        configuration.write_text('insecure: true\n')
        self.addCleanup(configuration.unlink)
        response = self.command('run', 'alpha', 'package', 'list')
        self.assertEqual(response.returncode, 1)
        self.assertIn('prevents isolated access', response.stderr)
        self.assertEqual(configuration.read_text(), 'insecure: true\n')

    def test_restore_requires_new_interactive_enrollment_and_preserves_copied_keys(self):
        old_key = self.enrolled()
        original = old_key.read_bytes()
        generation = str(uuid.uuid4())
        self.seed(restoreGeneration=generation)
        restored = json.loads(self.command('info', 'alpha').stdout)
        self.assertFalse(restored['identityPresent'])
        denied = self.command('run', 'alpha', 'package', 'list')
        self.assertEqual(denied.returncode, 1)
        self.assertIn('startos-target login alpha', denied.stderr)
        self.assertEqual(denied.stdout, '')
        code, output = self.terminal(['login', 'alpha'], password='fixture-password')
        self.assertEqual(code, 0, output)
        self.assertNotIn('fixture-password', output)
        key = self.targets / 'alpha/identities' / generation / 'id.key.pem'
        self.assertEqual(key.read_bytes(), original)
        self.assertEqual(stat.S_IMODE(key.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(key.parent.stat().st_mode), 0o700)
        self.assertTrue(json.loads(self.command('info', 'alpha').stdout)['identityPresent'])
        self.seed(restoreGeneration=generation)
        response = self.command('run', 'alpha', 'package', 'list')
        self.assertEqual(response.returncode, 0, response.stderr)
        self.assertEqual(json.loads(response.stdout), {'server': 'https://alpha.example', 'authenticated': True})
        self.seed(restoreGeneration=str(uuid.uuid4()))
        self.assertFalse(json.loads(self.command('info', 'alpha').stdout)['identityPresent'])
        self.assertEqual(self.command('run', 'alpha', 'package', 'list').returncode, 1)
        self.assertEqual(old_key.read_bytes(), original)
        self.assertEqual(key.read_bytes(), original)

    def test_missing_invalid_or_mutable_restore_seed_never_uses_copied_identity(self):
        key = self.enrolled()
        original = key.read_bytes()
        for generation in ['', '../old', [], 1, '00000000-0000-0000-0000-000000000000']:
            self.seed(restoreGeneration=generation)
            response = self.command('run', 'alpha', 'package', 'list')
            self.assertEqual(response.returncode, 1)
            self.assertEqual(response.stdout, '')
            self.assertEqual(key.read_bytes(), original)
        self.seed()
        value = json.loads(SEED.read_text())
        del value['restoreGeneration']
        SEED.write_text(json.dumps(value))
        self.assertEqual(self.command('run', 'alpha', 'package', 'list').returncode, 1)
        self.seed()
        SEED.chmod(0o666)
        self.assertEqual(self.command('run', 'alpha', 'package', 'list').returncode, 1)
        SEED.unlink()
        self.assertEqual(self.command('run', 'alpha', 'package', 'list').returncode, 1)
        self.assertEqual(key.read_bytes(), original)

    def test_restore_identity_symlink_cannot_reactivate_original_key(self):
        key = self.enrolled()
        original = key.read_bytes()
        generation = str(uuid.uuid4())
        self.seed(restoreGeneration=generation)
        identities = self.targets / 'alpha/identities'
        identities.mkdir(mode=0o700)
        (identities / generation).symlink_to(key.parent, target_is_directory=True)
        response = self.command('run', 'alpha', 'package', 'list')
        self.assertEqual(response.returncode, 1)
        self.assertEqual(response.stdout, '')
        self.assertEqual(key.read_bytes(), original)

    def test_add_local_verifies_https_and_stores_no_identity(self):
        self.seed()
        response = self.command('add-local')
        self.assertEqual(response.returncode, 0, response.stderr)
        value = json.loads(response.stdout)
        self.assertEqual(value['name'], 'local-server')
        self.assertEqual(value['url'], self.url)
        self.assertFalse(value['identityPresent'])

    def test_normal_development_user_can_save_the_root_provided_local_target(self):
        generation = str(uuid.uuid4())
        self.seed(restoreGeneration=generation)
        self.directory.chmod(0o755)
        user_directory = self.directory / 'normal-user'
        user_directory.mkdir(mode=0o700)
        os.chown(user_directory, 1000, 1000)
        environment = dict(self.environment, HOME=str(user_directory), XDG_CONFIG_HOME=str(user_directory / 'config'))
        response = subprocess.run([sys.executable, str(HELPER), 'add-local'], capture_output=True, text=True, env=environment, user=1000, group=1000, extra_groups=[], timeout=10)
        self.assertEqual(response.returncode, 0, response.stderr)
        self.assertEqual(json.loads(response.stdout)['url'], self.url)
        target = user_directory / 'config/dev-workspace/startos/targets/local-server'
        self.assertEqual((target / 'config.json').stat().st_uid, 1000)
        self.assertEqual(stat.S_IMODE((target / 'config.json').stat().st_mode), 0o600)
        self.assertFalse((target / 'id.key.pem').exists())
        code, output = self.terminal(['login', 'local-server'], password='fixture-password', user=1000, environment=environment)
        self.assertEqual(code, 0, output)
        key = target / 'identities' / generation / 'id.key.pem'
        self.assertEqual(key.read_text(), 'fixture-identity:' + self.url)
        self.assertEqual(key.stat().st_uid, 1000)
        self.assertEqual(stat.S_IMODE(key.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(key.parent.stat().st_mode), 0o700)
        response = subprocess.run([sys.executable, str(HELPER), 'run', 'local-server', 'package', 'list'], capture_output=True, text=True, env=environment, user=1000, group=1000, extra_groups=[], timeout=10)
        self.assertEqual(response.returncode, 0, response.stderr)
        self.assertEqual(json.loads(response.stdout), {'server': self.url, 'authenticated': True})

    def test_add_local_rejects_untrusted_certificate_redirect_and_mutable_seed(self):
        self.seed(rootCa=self.other_ca.read_text())
        response = self.command('add-local')
        self.assertEqual(response.returncode, 1)
        self.assertFalse(self.targets.exists())
        self.seed()
        self.server.response_status = 302
        self.assertEqual(self.command('add-local').returncode, 1)
        self.assertFalse(self.targets.exists())
        self.server.response_status = 200
        SEED.chmod(0o666)
        self.assertEqual(self.command('add-local').returncode, 1)
        self.assertFalse(self.targets.exists())

    def test_unknown_arguments_do_not_echo_sensitive_values(self):
        response = self.command('add', 'alpha', '--url', 'https://alpha.example', '--ca-file', str(self.ca), '--password', 'do-not-print')
        self.assertEqual(response.returncode, 1)
        self.assertNotIn('do-not-print', response.stderr)
        self.assertEqual(response.stdout, '')


if __name__ == '__main__':
    unittest.main()
