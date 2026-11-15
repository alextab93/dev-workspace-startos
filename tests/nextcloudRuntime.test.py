import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.parse
from xml.sax.saxutils import escape


ROOT = Path(__file__).resolve().parent.parent
HELPER = ROOT / 'assets/nextcloud-workspace.py'
sys.dont_write_bytecode = True
specification = importlib.util.spec_from_file_location('nextcloud_workspace', HELPER)
helper = importlib.util.module_from_spec(specification)
specification.loader.exec_module(helper)


class WebDavBoundary(BaseHTTPRequestHandler):
    def log_message(self, format, *arguments):
        pass

    def do_PROPFIND(self):
        self.rfile.read(int(self.headers.get('Content-Length', '0')))
        if self.path == '/credential-target':
            self.server.disclosed = bool(self.headers.get('Authorization'))
            self.send_error(500)
            return
        expected = 'Basic ' + base64.b64encode(b'fixture:app-password-secret').decode()
        if self.headers.get('Authorization') != expected or self.server.mode == 'denied':
            self.send_response(401)
            self.end_headers()
            self.wfile.write(b'private upstream body: app-password-secret')
            return
        if self.server.mode == 'redirect':
            self.send_response(307)
            self.send_header('Location', self.server.url + '/credential-target')
            self.end_headers()
            return
        path = self.server.directory / urllib.parse.unquote(self.path).lstrip('/')
        if not path.exists():
            self.send_error(404)
            return
        href = '/wrong-folder/' if self.server.mode == 'wrong-href' else self.path
        resource = '<d:collection/>' if path.is_dir() else ''
        permissions = '<oc:permissions>RDNVCK</oc:permissions>'
        if self.server.mode == 'readonly':
            permissions = '<oc:permissions>R</oc:permissions>'
        if self.server.mode == 'no-permissions':
            permissions = ''
        body = ('<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:response><d:href>' + escape(href)
                + '</d:href><d:propstat><d:prop><d:resourcetype>' + resource + '</d:resourcetype>' + permissions
                + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>').encode()
        if self.server.mode == 'malformed':
            body = b'<broken'
        if self.server.mode == 'entity':
            body = b'<!DOCTYPE a [<!ENTITY b "unsafe">]><a>&b;</a>'
        self.send_response(207)
        self.send_header('Content-Type', 'application/xml')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_MKCOL(self):
        target = self.server.directory / urllib.parse.unquote(self.path).lstrip('/')
        target.mkdir(parents=True, exist_ok=True)
        self.send_response(201)
        self.end_headers()

    def do_PUT(self):
        target = self.server.directory / urllib.parse.unquote(self.path).lstrip('/')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        self.send_response(201)
        self.end_headers()


class NextcloudRuntime(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.certificate_directory = tempfile.TemporaryDirectory(prefix='nextcloud-runtime-certificate-')
        root = Path(cls.certificate_directory.name)
        cls.certificate = root / 'server.crt'
        cls.key = root / 'server.key'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', str(cls.key), '-out', str(cls.certificate)], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.certificate_directory.cleanup()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nextcloud-runtime-')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.cache = self.directory / 'cache'
        self.state = self.directory / 'state'
        self.remote = self.directory / 'remote'
        self.project = self.remote / 'remote.php/dav/files/fixture/Projects/Proyecto número uno'
        self.project.mkdir(parents=True)
        self.original = self.project / 'original.txt'
        self.original.write_bytes(b'original remote bytes\x00\n')
        self.server = self.start_server()
        self.config = {'url': self.server.url + '/remote.php/dav/files/fixture/', 'username': 'fixture',
                       'appPassword': 'app-password-secret', 'subpath': 'Projects/Proyecto número uno', 'rootCa': self.certificate.read_text()}
        self.config_path = self.directory / 'config.json'
        self.write_config()

    def start_server(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), WebDavBoundary)
        server.directory = self.remote
        server.mode = 'collection'
        server.disclosed = False
        server.url = 'https://127.0.0.1:' + str(server.server_port)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.certificate, self.key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def write_config(self, changes=None):
        self.config.update(changes or {})
        self.config_path.write_text(json.dumps(self.config))
        self.config_path.chmod(0o600)

    def command(self, action, use_config=True):
        command = [sys.executable, str(HELPER), action, '--cache-dir', str(self.cache), '--state-dir', str(self.state)]
        if use_config:
            command.extend(['--config', str(self.config_path)])
        response = subprocess.run(command, capture_output=True, text=True, timeout=20)
        self.assertEqual(response.stderr, '')
        self.assertNotIn(self.config['appPassword'], response.stdout)
        self.assertNotIn(self.config['url'], response.stdout)
        return response.returncode, json.loads(response.stdout)

    def cache_record(self, dirty=True):
        config = helper.load_config(self.config_path)
        descriptor = {key: config[key] for key in ('url', 'username', 'subpath')}
        key = hashlib.sha256(json.dumps(descriptor, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        root = self.cache / key
        root.mkdir(parents=True, mode=0o700)
        identity = root / 'identity.json'
        identity.write_text(json.dumps(descriptor))
        identity.chmod(0o600)
        data = root / 'vfs/workspace/Projects/pending.txt'
        metadata = root / 'vfsMeta/workspace/Projects/pending.txt'
        data.parent.mkdir(parents=True)
        metadata.parent.mkdir(parents=True)
        data.write_bytes(b'locally saved pending bytes\n')
        metadata.write_text(json.dumps({'ModTime': '2026-11-14T00:00:00Z', 'ATime': '2026-11-14T00:00:00Z',
                                        'Size': data.stat().st_size, 'Rs': [{'Pos': 0, 'Size': data.stat().st_size}],
                                        'Fingerprint': '', 'Dirty': dirty}))
        return root, data, metadata

    def test_trusted_directory_check_preserves_original_files(self):
        before = {path.relative_to(self.remote): path.read_bytes() for path in self.remote.rglob('*') if path.is_file()}
        code, result = self.command('check')
        self.assertEqual(code, 0)
        self.assertEqual(result, {'ok': True, 'directory': True, 'permissionsReported': True})
        after = {path.relative_to(self.remote): path.read_bytes() for path in self.remote.rglob('*') if path.is_file()}
        self.assertEqual(after, before)

    def test_missing_remote_folder_is_rejected_without_creating_it(self):
        self.write_config({'subpath': 'new missing project'})
        code, result = self.command('check')
        self.assertEqual(code, 1)
        self.assertIn('does not exist', result['message'])
        self.assertFalse((self.remote / 'remote.php/dav/files/fixture/new missing project').exists())

    def test_remote_file_is_not_accepted_as_directory(self):
        self.write_config({'subpath': self.config['subpath'] + '/original.txt'})
        code, result = self.command('check')
        self.assertEqual(code, 1)
        self.assertIn('not an accessible directory', result['message'])

    def test_redirect_does_not_disclose_credentials_to_target(self):
        self.server.mode = 'redirect'
        code, result = self.command('check')
        self.assertEqual(code, 1)
        self.assertIn('redirected', result['message'])
        self.assertFalse(self.server.disclosed)

    def test_untrusted_certificate_is_rejected(self):
        self.write_config({'rootCa': None})
        code, result = self.command('check')
        self.assertEqual(code, 1)
        self.assertIn('trusted HTTPS', result['message'])

    def test_denied_credentials_do_not_expose_upstream_error_body(self):
        self.server.mode = 'denied'
        code, result = self.command('check')
        self.assertEqual(code, 1)
        self.assertEqual(result['message'], 'Nextcloud rejected the account or app password.')

    def test_invalid_or_unrelated_webdav_responses_are_rejected(self):
        for mode in ('malformed', 'entity', 'wrong-href'):
            with self.subTest(mode=mode):
                self.server.mode = mode
                code, result = self.command('check')
                self.assertEqual(code, 1)
                self.assertFalse(result['ok'])

    def test_reported_readonly_share_is_rejected(self):
        self.server.mode = 'readonly'
        code, result = self.command('check')
        self.assertEqual(code, 1)
        self.assertIn('insufficient create or update permissions', result['message'])

    def test_absent_permission_property_is_reported_without_inventing_proof(self):
        self.server.mode = 'no-permissions'
        code, result = self.command('check')
        self.assertEqual(code, 0)
        self.assertFalse(result['permissionsReported'])

    def test_unsafe_settings_are_rejected(self):
        baseline = self.config.copy()
        for change in ({'url': self.config['url'].replace('https:', 'http:')}, {'url': 'https://user:password@example.invalid/'},
                       {'subpath': '../outside'}, {'subpath': 'folder//child'}, {'subpath': 'folder\nchild'}, {'username': 'bad:name'}):
            with self.subTest(field=next(iter(change))):
                self.config = baseline.copy()
                self.write_config(change)
                code, result = self.command('check')
                self.assertEqual(code, 1)
                self.assertFalse(result['ok'])

    def test_public_or_symlinked_credential_file_is_rejected(self):
        self.config_path.chmod(0o644)
        code, result = self.command('check')
        self.assertEqual(code, 1)
        self.assertFalse(result['ok'])
        target = self.directory / 'private.json'
        self.config_path.rename(target)
        target.chmod(0o600)
        self.config_path.symlink_to(target)
        code, result = self.command('check')
        self.assertEqual(code, 1)
        self.assertFalse(result['ok'])

    def test_fifo_credential_file_is_rejected_without_waiting_for_a_writer(self):
        self.config_path.unlink()
        os.mkfifo(self.config_path, mode=0o600)
        code, result = self.command('check')
        self.assertEqual(code, 1)
        self.assertFalse(result['ok'])

    def test_clean_or_absent_cache_allows_source_changes_without_creating_cache(self):
        code, result = self.command('pending', use_config=False)
        self.assertEqual((code, result), (0, {'pending': False, 'dirtyFiles': 0, 'uncertain': False}))
        self.assertFalse(self.cache.exists())
        self.cache_record(dirty=False)
        code, result = self.command('pending', use_config=False)
        self.assertEqual((code, result), (0, {'pending': False, 'dirtyFiles': 0, 'uncertain': False}))

    def test_dirty_cache_blocks_switching_or_disabling_and_preserves_bytes(self):
        root, data, metadata = self.cache_record()
        before = data.read_bytes(), metadata.read_bytes()
        code, result = self.command('pending', use_config=False)
        self.assertEqual(code, 1)
        self.assertEqual(result, {'pending': True, 'dirtyFiles': 1, 'uncertain': False})
        self.write_config({'subpath': 'different project'})
        code, result = self.command('pending')
        self.assertEqual(code, 1)
        self.assertTrue(result['pending'])
        self.assertEqual((data.read_bytes(), metadata.read_bytes()), before)

    def test_password_rotation_keeps_same_destination_recoverable(self):
        root, data, metadata = self.cache_record()
        self.write_config({'appPassword': 'replacement-private-password', 'url': self.config['url'].rstrip('/')})
        code, result = self.command('pending')
        self.assertEqual((code, result), (0, {'pending': False, 'dirtyFiles': 0, 'uncertain': False}))
        self.assertEqual(data.read_bytes(), b'locally saved pending bytes\n')
        self.write_config({'username': 'different-account'})
        code, result = self.command('pending')
        self.assertEqual(code, 1)
        self.assertTrue(result['pending'])

    def test_changed_transport_preserves_recoverable_destination_with_explicit_identity(self):
        root, data, metadata = self.cache_record()
        descriptor = json.loads((root / 'identity.json').read_text())
        before = {path.relative_to(root): path.read_bytes() for path in root.rglob('*') if path.is_file()}
        alternate = self.start_server()
        self.write_config({'url': alternate.url + '/remote.php/dav/files/fixture/'})
        code, result = self.command('pending')
        self.assertEqual((code, result), (1, {'pending': True, 'dirtyFiles': 1, 'uncertain': False}))
        self.write_config({'cacheIdentity': descriptor})
        code, result = self.command('check')
        self.assertEqual((code, result), (0, {'ok': True, 'directory': True, 'permissionsReported': True}))
        code, result = self.command('pending')
        self.assertEqual((code, result), (0, {'pending': False, 'dirtyFiles': 0, 'uncertain': False}))
        code, result = self.command('status')
        self.assertEqual(code, 0)
        self.assertEqual(result['pendingUploads'], 1)
        self.assertFalse(result['uncertain'])
        self.assertFalse(result['ready'])
        self.assertEqual(list(self.cache.iterdir()), [root])
        after = {path.relative_to(root): path.read_bytes() for path in root.rglob('*') if path.is_file()}
        self.assertEqual(after, before)
        self.assertEqual(self.original.read_bytes(), b'original remote bytes\x00\n')

    def test_explicit_identity_cannot_hide_another_destinations_pending_upload(self):
        first, first_data, first_metadata = self.cache_record()
        descriptor = json.loads((first / 'identity.json').read_text())
        self.write_config({'subpath': 'Projects/another-project'})
        second, second_data, second_metadata = self.cache_record()
        self.write_config({'subpath': descriptor['subpath'], 'cacheIdentity': descriptor})
        code, result = self.command('pending')
        self.assertEqual((code, result), (1, {'pending': True, 'dirtyFiles': 1, 'uncertain': False}))
        self.assertEqual(first_data.read_bytes(), b'locally saved pending bytes\n')
        self.assertEqual(second_data.read_bytes(), b'locally saved pending bytes\n')

    def test_invalid_cache_identity_cannot_bypass_pending_upload_protection(self):
        root, data, metadata = self.cache_record()
        descriptor = json.loads((root / 'identity.json').read_text())
        baseline = self.config.copy()
        invalid = [None, {}, [], {**descriptor, 'extra': 'value'},
                   {**descriptor, 'url': descriptor['url'].replace('https:', 'http:')},
                   {**descriptor, 'url': 'https://user:secret@example.invalid/remote.php/dav/files/fixture/'},
                   {**descriptor, 'url': descriptor['url'] + '?token=private'},
                   {**descriptor, 'url': descriptor['url'].replace('/fixture/', '/%2Ffixture/')},
                   {**descriptor, 'url': descriptor['url'].replace('/fixture/', '/%zz/')},
                   {**descriptor, 'url': descriptor['url'].replace('/fixture/', '/%E2%80%A8/')},
                   {**descriptor, 'url': 'https://example.invalid/not-a-webdav-root/'},
                   {**descriptor, 'username': 'different:account'},
                   {**descriptor, 'username': ' '},
                   {**descriptor, 'subpath': '../outside'},
                   {**descriptor, 'subpath': 'C:outside'},
                   {**descriptor, 'subpath': 'Projects\u2028another'},
                   {**descriptor, 'subpath': 'Projects/another-project'}]
        before = data.read_bytes(), metadata.read_bytes()
        for value in invalid:
            with self.subTest(identity=value):
                self.config = baseline.copy()
                self.write_config({'cacheIdentity': value})
                code, result = self.command('pending')
                self.assertEqual(code, 1)
                self.assertFalse(result['ok'])
                self.assertEqual((data.read_bytes(), metadata.read_bytes()), before)

    def test_cached_identity_cannot_contain_an_identity_override(self):
        root, data, metadata = self.cache_record()
        identity_path = root / 'identity.json'
        descriptor = json.loads(identity_path.read_text())
        descriptor['cacheIdentity'] = dict(descriptor)
        identity_path.write_text(json.dumps(descriptor))
        code, result = self.command('pending', use_config=False)
        self.assertEqual((code, result), (1, {'pending': True, 'dirtyFiles': 0, 'uncertain': True}))
        self.assertEqual(data.read_bytes(), b'locally saved pending bytes\n')
        self.assertEqual(json.loads(identity_path.read_text()), descriptor)

    def test_corrupt_or_unpaired_cache_never_reports_clean_and_is_not_deleted(self):
        root, data, metadata = self.cache_record()
        metadata.write_bytes(b'{ invalid')
        for scenario in ('corrupt', 'missing-metadata', 'missing-data'):
            with self.subTest(scenario=scenario):
                if scenario == 'missing-metadata':
                    metadata.unlink()
                if scenario == 'missing-data':
                    data.unlink()
                    metadata.write_text('{}')
                code, result = self.command('pending', use_config=False)
                self.assertEqual(code, 1)
                self.assertTrue(result['uncertain'])
                self.assertTrue(root.exists())
                self.assertTrue(metadata.exists() if scenario != 'missing-metadata' else data.exists())

    def test_stopped_status_reports_pending_saved_uploads(self):
        self.cache_record()
        code, result = self.command('status')
        self.assertEqual(code, 0)
        self.assertFalse(result['ready'])
        self.assertFalse(result['mounted'])
        self.assertEqual(result['pendingUploads'], 1)
        self.assertFalse(result['uncertain'])

    def test_empty_clean_metadata_without_data_allows_normal_removed_lock_files(self):
        root, data, metadata = self.cache_record(dirty=False)
        value = json.loads(metadata.read_text())
        value.update({'Size': 0, 'Rs': None})
        metadata.write_text(json.dumps(value))
        data.unlink()
        code, result = self.command('pending', use_config=False)
        self.assertEqual((code, result), (0, {'pending': False, 'dirtyFiles': 0, 'uncertain': False}))
        self.assertEqual(json.loads(metadata.read_text()), value)
        for change in ({'Dirty': True}, {'Size': 1}, {'Rs': [{'Pos': 0, 'Size': 1}]}):
            with self.subTest(field=next(iter(change))):
                metadata.write_text(json.dumps({**value, **change}))
                code, result = self.command('pending', use_config=False)
                self.assertEqual(code, 1)
                self.assertTrue(result['uncertain'])

    def test_unreadable_rclone_metadata_blocks_changes_and_preserves_saved_bytes(self):
        root, data, metadata = self.cache_record()
        baseline = json.loads(metadata.read_text())
        for change in ({'ModTime': '2026-11-14'}, {'ATime': '2026-11-14T12:30:40'},
                       {'ModTime': '2026-11-14T25:00:00Z'}, {'ATime': '2026-11-14T00:00:00+01:99'}, {'Size': 2 ** 80},
                       {'Rs': [{'Pos': 2 ** 63, 'Size': 1}]}, {'Rs': [{'Pos': 0, 'Size': 2 ** 63}]},
                       {'size': 'corrupt alternate field'}):
            with self.subTest(field=next(iter(change))):
                metadata.write_text(json.dumps({**baseline, **change}))
                before = data.read_bytes(), metadata.read_bytes()
                code, result = self.command('pending', use_config=False)
                self.assertEqual(code, 1)
                self.assertTrue(result['pending'])
                self.assertTrue(result['uncertain'])
                self.assertEqual((data.read_bytes(), metadata.read_bytes()), before)


if __name__ == '__main__':
    unittest.main(verbosity=2)
