import base64
import fcntl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from xml.sax.saxutils import escape


ROOT = Path(__file__).resolve().parent.parent
HELPER = ROOT / 'assets/nextcloud-connect.py'


class NextcloudBoundary(BaseHTTPRequestHandler):
    def log_message(self, format, *arguments):
        pass

    def output(self, code, value, content_type='application/json'):
        body = value if isinstance(value, bytes) else json.dumps(value).encode()
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authenticated(self):
        header = self.headers.get('Authorization', '')
        for token in self.server.issued - self.server.revoked:
            expected = 'Basic ' + base64.b64encode(('account@example.invalid:' + token).encode()).decode()
            if header == expected:
                return token
        return None

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        if self.path == '/index.php/login/v2':
            if self.server.mode == 'redirect':
                self.send_response(307)
                self.send_header('Location', self.server.url + '/credential-target')
                self.end_headers()
                return
            token = secrets.token_hex(32)
            self.server.flow = {'token': token, 'loginToken': secrets.token_hex(32), 'approved': False, 'consumed': False, 'password': 'app-secret-' + token}
            target = 'https://untrusted.invalid' if self.server.mode == 'foreign-flow' else self.server.url
            self.output(200, {'poll': {'token': token, 'endpoint': target + '/index.php/login/v2/poll'},
                              'login': self.server.url + '/index.php/login/v2/flow/' + self.server.flow['loginToken']})
            return
        if self.path == '/index.php/login/v2/poll':
            form = urllib.parse.parse_qs(body.decode())
            flow = self.server.flow
            if not flow or form.get('token') != [flow['token']] or not flow['approved'] or flow['consumed']:
                self.output(404, {})
                return
            flow['consumed'] = True
            self.server.issued.add(flow['password'])
            self.output(200, {'server': self.server.url, 'loginName': 'account@example.invalid', 'appPassword': flow['password']})
            return
        if self.path == '/credential-target':
            self.server.disclosed = bool(body or self.headers.get('Authorization'))
        self.output(404, {})

    def do_GET(self):
        if not self.authenticated():
            self.output(401, b'private upstream content includes app-secret')
            return
        if self.path == '/ocs/v1.php/cloud/user?format=json':
            if self.server.mode == 'account-offline':
                self.output(503, b'private upstream content includes app-secret')
            elif self.server.mode == 'invalid-account':
                self.output(200, {'ocs': {'meta': {'statuscode': 100}, 'data': {'id': '../outside'}}})
            elif self.server.mode == 'invalid-meta':
                self.output(200, {'ocs': {'meta': 'not-an-object', 'data': {'id': 'real-id'}}})
            else:
                self.output(200, {'ocs': {'meta': {'statuscode': 100}, 'data': {'id': 'real-id', 'display-name': 'Fixture Account'}}})
            return
        self.output(404, {})

    def do_DELETE(self):
        token = self.authenticated()
        if not token:
            self.output(401, {})
            return
        if self.server.mode == 'revoke-offline':
            self.output(503, b'private upstream content includes app-secret')
            return
        if self.path == '/ocs/v2.php/core/apppassword?format=json':
            self.server.revoked.add(token)
            self.output(200, {'ocs': {'meta': {'statuscode': 200}, 'data': []}})
            return
        self.output(404, {})

    def do_PROPFIND(self):
        self.rfile.read(int(self.headers.get('Content-Length', '0')))
        if not self.authenticated():
            self.output(401, {})
            return
        if self.server.mode == 'dav-redirect':
            self.send_response(307)
            self.send_header('Location', self.server.url + '/credential-target')
            self.end_headers()
            return
        root = '/remote.php/dav/files/real-id/'
        path = urllib.parse.unquote(self.path)
        if not path.startswith(root):
            self.output(404, {})
            return
        relative = path[len(root):].rstrip('/')
        current = self.server.directory / relative
        if not current.is_dir():
            self.output(404, {})
            return
        if self.server.mode == 'entity':
            self.output(207, b'<!DOCTYPE a [<!ENTITY b "unsafe">]><a>&b;</a>', 'application/xml')
            return
        if self.server.mode == 'encoded-entity':
            self.output(207, '<!DOCTYPE a [<!ENTITY b "unsafe">]><a>&b;</a>'.encode('utf-16'), 'application/xml')
            return
        if self.server.mode == 'oversized':
            self.output(207, b'x' * 2097153, 'application/xml')
            return
        entries = []
        for item in [current, *current.iterdir()]:
            value = item.relative_to(self.server.directory).as_posix()
            if value == '.':
                value = ''
            href = root + '/'.join(urllib.parse.quote(part, safe='') for part in value.split('/')) + ('/' if value and item.is_dir() else '')
            permissions = 'R' if item.name == 'Read only' else 'RDNVCK'
            collection = '<d:collection/>' if item.is_dir() else ''
            entries.append('<d:response><d:href>' + escape(href) + '</d:href><d:propstat><d:prop><d:resourcetype>' + collection
                           + '</d:resourcetype><oc:permissions>' + permissions + '</oc:permissions></d:prop>'
                           + '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>')
        for href in self.server.extra_hrefs:
            entries.append('<d:response><d:href>' + escape(href) + '</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype>'
                           + '<oc:permissions>RDNVCK</oc:permissions></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>')
        self.output(207, ('<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">' + ''.join(entries) + '</d:multistatus>').encode(), 'application/xml')


class NextcloudConnect(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.certificates = tempfile.TemporaryDirectory(prefix='nextcloud-connect-certificate-')
        base = Path(cls.certificates.name)
        cls.certificate = base / 'server.crt'
        cls.key = base / 'server.key'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
                        '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', str(cls.key), '-out', str(cls.certificate)],
                       check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.certificates.cleanup()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nextcloud-connect-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.directory = self.base / 'remote'
        self.directory.mkdir()
        (self.directory / 'Projects' / 'nested').mkdir(parents=True)
        (self.directory / 'Read only').mkdir()
        (self.directory / 'Proyecto número % # &').mkdir()
        (self.directory / 'plain-file.txt').write_text('original contents\n')
        self.state_dir = self.base / 'connection'
        self.config_path = self.base / 'config.json'
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), NextcloudBoundary)
        self.server.directory = self.directory
        self.server.mode = 'normal'
        self.server.flow = None
        self.server.issued = set()
        self.server.revoked = set()
        self.server.disclosed = False
        self.server.extra_hrefs = []
        self.server.url = 'https://127.0.0.1:' + str(self.server.server_port)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.certificate, self.key)
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.config = {'internalBaseUrl': self.server.url, 'browserBaseUrl': self.server.url,
                       'allowedBaseUrls': [self.server.url], 'rootCa': self.certificate.read_text()}
        self.write_config()

    def write_config(self, changes=None):
        self.config.update(changes or {})
        self.config_path.write_text(json.dumps(self.config))
        self.config_path.chmod(0o600)

    def state(self):
        return json.loads((self.state_dir / 'state.json').read_text())

    def write_state(self, value):
        path = self.state_dir / 'state.json'
        path.write_text(json.dumps(value))
        path.chmod(0o600)

    def command(self, operation):
        result = subprocess.run([sys.executable, str(HELPER), operation, '--config', str(self.config_path), '--state-dir', str(self.state_dir)],
                                capture_output=True, text=True, timeout=25)
        self.assertEqual(result.stderr, '')
        for token in self.server.issued:
            self.assertNotIn(token, result.stdout)
        if self.server.flow:
            self.assertNotIn(self.server.flow['token'], result.stdout)
            self.assertNotIn('pollToken', result.stdout)
        return result.returncode, json.loads(result.stdout)

    def connect(self):
        code, result = self.command('begin')
        self.assertEqual((code, result['state']), (0, 'waiting'))
        self.server.flow['approved'] = True
        code, result = self.command('poll')
        self.assertEqual((code, result['state']), (0, 'connected'))
        return result

    def test_approved_connection_uses_login_name_and_discovers_real_account_id(self):
        result = self.connect()
        self.assertEqual(result['connection']['accountId'], 'real-id')
        self.assertEqual(result['connection']['displayName'], 'Fixture Account')
        saved = self.state()['connection']
        self.assertEqual(saved['username'], 'account@example.invalid')
        self.assertEqual(saved['url'], self.server.url + '/remote.php/dav/files/real-id/')
        self.assertEqual(saved['appPassword'], self.server.flow['password'])
        self.assertEqual((self.state_dir / 'state.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.state_dir.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.command('status')[1], result)

    def test_pending_flow_is_reused_and_waits_for_explicit_authorization(self):
        first = self.command('begin')[1]
        self.assertEqual(self.command('poll')[1], first)
        self.assertEqual(self.command('begin')[1], first)
        self.assertEqual(self.state()['pending']['state'], 'waiting')
        self.assertNotIn('connection', self.state())

    def test_expired_flow_requires_a_new_authorization(self):
        first = self.command('begin')[1]
        saved = self.state()
        saved['pending']['createdAt'] = time.time() - 1201
        saved['pending']['expiresAt'] = saved['pending']['createdAt'] + 1200
        self.write_state(saved)
        self.assertEqual(self.command('poll')[1]['state'], 'expired')
        second = self.command('begin')[1]
        self.assertEqual(second['state'], 'waiting')
        self.assertNotEqual(second['pending']['id'], first['pending']['id'])

    def test_received_credentials_survive_account_outage_without_repolling_consumed_flow(self):
        self.command('begin')
        self.server.flow['approved'] = True
        self.server.mode = 'account-offline'
        code, result = self.command('poll')
        self.assertEqual((code, result['code']), (1, 'account-unavailable'))
        received = self.state()['pending']
        self.assertEqual(received['state'], 'received')
        self.assertEqual(received['appPassword'], self.server.flow['password'])
        self.server.mode = 'normal'
        code, result = self.command('poll')
        self.assertEqual((code, result['state']), (0, 'connected'))
        self.assertEqual(result['connection']['accountId'], 'real-id')

    def test_browser_address_is_rewritten_only_to_discovered_trusted_alias(self):
        alias = 'https://localhost:' + str(self.server.server_port)
        self.write_config({'browserBaseUrl': alias, 'allowedBaseUrls': [self.server.url, alias]})
        result = self.command('begin')[1]
        self.assertTrue(result['pending']['authorizationUrl'].startswith(alias + '/index.php/login/v2/flow/'))
        self.assertTrue(self.state()['pending']['pollEndpoint'].startswith(self.server.url + '/'))

    def test_foreign_poll_endpoint_is_rejected_without_saving_authorization(self):
        self.server.mode = 'foreign-flow'
        code, result = self.command('begin')
        self.assertEqual((code, result['code']), (1, 'untrusted-response'))
        self.assertFalse((self.state_dir / 'state.json').exists())

    def test_untrusted_certificate_and_redirects_fail_without_credential_disclosure(self):
        self.write_config({'rootCa': ''})
        code, result = self.command('begin')
        self.assertEqual(code, 1)
        self.assertFalse(result['ok'])
        self.write_config({'rootCa': self.certificate.read_text()})
        self.server.mode = 'redirect'
        code, result = self.command('begin')
        self.assertEqual((code, result['code']), (1, 'redirect-rejected'))
        self.assertFalse(self.server.disclosed)

    def test_folder_picker_lists_only_collections_and_preserves_original_files(self):
        self.connect()
        before = (self.directory / 'plain-file.txt').read_bytes()
        code, result = self.command('browse')
        self.assertEqual(code, 0)
        self.assertEqual(result['path'], '')
        self.assertIsNone(result['parentPath'])
        self.assertFalse(result['canSelect'])
        self.assertEqual(result['folders'], [
            {'name': 'Projects', 'path': 'Projects', 'canSelect': True},
            {'name': 'Proyecto número % # &', 'path': 'Proyecto número % # &', 'canSelect': True},
            {'name': 'Read only', 'path': 'Read only', 'canSelect': False},
        ])
        self.assertEqual((self.directory / 'plain-file.txt').read_bytes(), before)

    def test_browse_completes_authorization_and_supports_nested_navigation(self):
        self.command('begin')
        self.server.flow['approved'] = True
        self.write_config({'path': 'Projects'})
        result = self.command('browse')[1]
        self.assertEqual(result['state'], 'connected')
        self.assertEqual(result['path'], 'Projects')
        self.assertEqual(result['parentPath'], '')
        self.assertTrue(result['canSelect'])
        self.assertEqual(result['folders'], [{'name': 'nested', 'path': 'Projects/nested', 'canSelect': True}])
        self.write_config({'path': 'Projects/nested'})
        result = self.command('browse')[1]
        self.assertEqual(result['parentPath'], 'Projects')
        self.assertEqual(result['folders'], [])
        self.assertEqual(self.state()['browsePath'], 'Projects/nested')

    def test_unicode_percent_hash_and_spaces_round_trip_without_path_changes(self):
        self.connect()
        self.write_config({'path': 'Proyecto número % # &'})
        result = self.command('browse')[1]
        self.assertEqual(result['path'], 'Proyecto número % # &')
        self.assertTrue(result['canSelect'])

    def test_readonly_folder_is_browsable_but_not_selectable(self):
        self.connect()
        self.write_config({'path': 'Read only'})
        result = self.command('browse')[1]
        self.assertEqual(result['state'], 'connected')
        self.assertFalse(result['canSelect'])

    def test_invalid_paths_missing_folders_and_files_are_rejected(self):
        self.connect()
        for path in ['../outside', '/absolute', 'Projects/../Read only', 'Projects//nested', 'C:drive', 'Projects\\nested']:
            self.write_config({'path': path})
            code, result = self.command('browse')
            self.assertEqual((code, result['code']), (1, 'invalid-folder'))
        for path in ['missing', 'plain-file.txt']:
            self.write_config({'path': path})
            code, result = self.command('browse')
            self.assertEqual((code, result['code']), (1, 'folder-missing'))
        self.assertFalse((self.directory / 'missing').exists())

    def test_foreign_traversal_and_non_immediate_folder_hrefs_are_excluded(self):
        self.connect()
        root = '/remote.php/dav/files/real-id/'
        self.server.extra_hrefs = ['https://untrusted.invalid' + root + 'foreign/', root + '../outside/', root + 'Projects/nested/',
                                   '/remote.php/dav/files/another-user/folder/', root + '%2e%2e/escape/']
        result = self.command('browse')[1]
        self.assertEqual([item['path'] for item in result['folders']], ['Projects', 'Proyecto número % # &', 'Read only'])

    def test_xml_entities_and_oversized_folder_responses_are_rejected(self):
        self.connect()
        for mode, expected in [('entity', 'invalid-response'), ('encoded-entity', 'invalid-response'), ('oversized', 'response-too-large'), ('dav-redirect', 'redirect-rejected')]:
            self.server.mode = mode
            code, result = self.command('browse')
            self.assertEqual((code, result['code']), (1, expected))
        self.assertFalse(self.server.disclosed)

    def test_reconnecting_does_not_revoke_or_change_active_project_credentials(self):
        original = self.connect()
        previous = self.state()['connection'].copy()
        self.write_config({'activeConnectionId': original['connection']['id']})
        self.command('begin')
        self.assertEqual(self.state()['connection'], previous)
        self.server.flow['approved'] = True
        replacement = self.command('poll')[1]
        self.assertNotEqual(replacement['connection']['id'], previous['id'])
        self.assertNotIn(previous['appPassword'], self.server.revoked)
        self.assertIn(previous['appPassword'], self.server.issued)

    def test_previous_connection_is_retained_when_replacement_is_ready(self):
        self.connect()
        previous = self.state()['connection'].copy()
        self.command('begin')
        self.assertNotIn(previous['appPassword'], self.server.revoked)
        self.server.flow['approved'] = True
        self.assertEqual(self.command('poll')[1]['state'], 'connected')
        self.assertEqual(self.state()['retiredConnections'], [previous])
        self.assertNotIn(previous['appPassword'], self.server.revoked)

    def test_cancel_preserves_waiting_and_completed_connections_but_revokes_received_credentials(self):
        self.command('begin')
        result = self.command('cancel')[1]
        self.assertEqual(result['state'], 'waiting')
        self.assertIn('expires', result['message'])
        self.server.flow['approved'] = True
        result = self.command('cancel')[1]
        self.assertEqual(result['state'], 'disconnected')
        self.assertIn(self.server.flow['password'], self.server.revoked)
        self.connect()
        connection = self.state()['connection'].copy()
        self.write_config({'activeConnectionId': connection['id']})
        self.assertEqual(self.command('cancel')[1]['state'], 'connected')
        self.assertEqual(self.state()['connection'], connection)
        self.write_config({'activeConnectionId': None})
        self.assertEqual(self.command('cancel')[1]['state'], 'connected')
        self.assertNotIn(connection['appPassword'], self.server.revoked)

    def test_failed_revocation_preserves_received_credentials_for_retry(self):
        self.command('begin')
        self.server.flow['approved'] = True
        self.server.mode = 'revoke-offline'
        code, result = self.command('cancel')
        self.assertEqual((code, result['code']), (1, 'revocation-failed'))
        self.assertEqual(self.state()['pending']['state'], 'received')
        self.assertEqual(self.state()['pending']['appPassword'], self.server.flow['password'])
        self.server.mode = 'normal'
        self.assertEqual(self.command('cancel')[1]['state'], 'disconnected')
        self.assertIn(self.server.flow['password'], self.server.revoked)

    def test_connection_limit_recovers_only_after_definitive_revocation(self):
        self.connect()
        saved = self.state()
        retired = []
        for number in range(16):
            token = 'retired-secret-' + str(number)
            self.server.issued.add(token)
            record = saved['connection'].copy()
            record.update({'id': 'retired-' + str(number), 'appPassword': token})
            retired.append(record)
        saved['retiredConnections'] = retired
        self.write_state(saved)
        self.server.mode = 'account-offline'
        code, result = self.command('begin')
        self.assertEqual((code, result['code']), (1, 'connection-limit'))
        self.assertEqual(self.state()['retiredConnections'], retired)
        self.server.mode = 'normal'
        code, result = self.command('begin')
        self.assertEqual((code, result['code']), (1, 'connection-limit'))
        self.assertEqual(self.state()['retiredConnections'], retired)
        self.server.revoked.add(retired[0]['appPassword'])
        self.assertEqual(self.command('begin')[1]['state'], 'waiting')
        self.assertEqual(self.state()['retiredConnections'], retired[1:])

    def test_malformed_account_information_is_sanitized_and_credentials_remain_recoverable(self):
        self.command('begin')
        self.server.flow['approved'] = True
        for mode in ['invalid-account', 'invalid-meta']:
            self.server.mode = mode
            code, result = self.command('poll')
            self.assertEqual((code, result['code']), (1, 'invalid-response'))
            self.assertEqual(self.state()['pending']['state'], 'received')
        self.server.mode = 'normal'
        self.assertEqual(self.command('poll')[1]['state'], 'connected')

    def test_lock_rejects_overlapping_operations_without_altering_saved_state(self):
        self.connect()
        before = (self.state_dir / 'state.json').read_bytes()
        with open(self.state_dir / '.lock', 'a') as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            code, result = self.command('begin')
            self.assertEqual((code, result['code']), (1, 'busy'))
        self.assertEqual((self.state_dir / 'state.json').read_bytes(), before)

    def test_unsafe_state_files_fail_without_disclosing_their_contents(self):
        self.connect()
        path = self.state_dir / 'state.json'
        path.chmod(0o644)
        code, result = self.command('status')
        self.assertEqual((code, result['code']), (1, 'unsafe-state'))
        path.chmod(0o600)
        original = path.read_bytes()
        path.unlink()
        target = self.base / 'private-target.json'
        target.write_bytes(original)
        target.chmod(0o600)
        path.symlink_to(target)
        code, result = self.command('status')
        self.assertEqual(code, 1)
        self.assertFalse(result['ok'])
        self.assertEqual(target.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
