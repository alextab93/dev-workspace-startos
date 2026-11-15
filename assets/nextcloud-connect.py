#!/usr/bin/python3
import argparse
import base64
import fcntl
import json
import math
import os
from pathlib import Path
import re
import secrets
import ssl
import stat
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


STATE_DIRECTORY = Path('/var/lib/dev-workspace/nextcloud-connection')
USER_AGENT = 'Dev Workspace Nextcloud Connection'
FLOW_SECONDS = 1200
MAX_RESPONSE = 2097152
MAX_STATE = 524288
PROPFIND = b'<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><d:resourcetype/><d:displayname/><oc:permissions/></d:prop></d:propfind>'


class ConnectionError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def require(condition, code, message):
    if not condition:
        raise ConnectionError(code, message)


def text_value(value, maximum=4096):
    return isinstance(value, str) and 0 < len(value) <= maximum and value.strip() and not any(unicodedata.category(char).startswith('C') for char in value)


def base_url(value):
    require(text_value(value, 2048) and value == value.strip() and '\\' not in value,
            'invalid-settings', 'Nextcloud connection settings are invalid.')
    try:
        parsed = urllib.parse.urlsplit(value)
        require(parsed.scheme == 'https' and parsed.hostname and not parsed.username and not parsed.password
                and not parsed.query and not parsed.fragment and parsed.path in ('', '/'),
                'invalid-settings', 'Nextcloud requires a trusted HTTPS service address.')
        port = parsed.port
        require(port is None or 0 < port <= 65535, 'invalid-settings', 'Nextcloud connection settings are invalid.')
        host = parsed.hostname.lower()
        host = '[' + host + ']' if ':' in host else host.encode('idna').decode('ascii')
        return 'https://' + host + (':' + str(port) if port and port != 443 else '')
    except (ValueError, UnicodeError):
        raise ConnectionError('invalid-settings', 'Nextcloud connection settings are invalid.') from None


def relative_path(value, allow_root=True):
    require(isinstance(value, str) and len(value) <= 1024, 'invalid-folder', 'Choose a valid Nextcloud folder.')
    if value == '' and allow_root:
        return value
    require(value and not value.startswith('/') and not re.match(r'^[A-Za-z]:', value) and '\\' not in value
            and not any(unicodedata.category(char).startswith('C') or unicodedata.category(char) in ('Zl', 'Zp') for char in value)
            and all(part.strip() and part not in ('.', '..') for part in value.split('/')),
            'invalid-folder', 'Choose a valid Nextcloud folder.')
    return value


def private_read(path, maximum=131072):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as source:
        info = os.fstat(source.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_mode & 0o077 == 0,
                'unsafe-state', 'Nextcloud connection files must be private regular files.')
        raw = source.read(maximum + 1)
    require(len(raw) <= maximum, 'unsafe-state', 'Nextcloud connection state is too large.')
    return json.loads(raw)


def configuration(path):
    data = private_read(path)
    require(isinstance(data, dict), 'invalid-settings', 'Nextcloud connection settings are invalid.')
    internal = base_url(data.get('internalBaseUrl'))
    browser = base_url(data.get('browserBaseUrl'))
    allowed = data.get('allowedBaseUrls')
    require(isinstance(allowed, list) and 1 <= len(allowed) <= 128,
            'invalid-settings', 'Nextcloud connection settings are invalid.')
    allowed = sorted(set(base_url(value) for value in allowed))
    require(internal in allowed and browser in allowed, 'invalid-settings', 'Nextcloud service addresses could not be verified.')
    root_ca = data.get('rootCa')
    require(isinstance(root_ca, str) and len(root_ca) <= 65536, 'invalid-settings', 'Nextcloud trust settings are invalid.')
    active = data.get('activeConnectionId')
    require(active is None or text_value(active, 128), 'invalid-settings', 'Nextcloud connection settings are invalid.')
    result = {'internalBaseUrl': internal, 'browserBaseUrl': browser, 'allowedBaseUrls': allowed, 'rootCa': root_ca,
              'activeConnectionId': active}
    if 'path' in data:
        result['path'] = relative_path(data['path'])
    return result


def route(value, allowed, expression):
    require(text_value(value, 4096) and '\\' not in value, 'untrusted-response', 'Nextcloud returned an unexpected connection address.')
    parsed = urllib.parse.urlsplit(value)
    origin = base_url(urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, '', '', '')))
    require(origin in allowed and not parsed.query and not parsed.fragment and re.fullmatch(expression, parsed.path),
            'untrusted-response', 'Nextcloud returned an unexpected connection address.')
    return parsed.path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        raise ConnectionError('redirect-rejected', 'Nextcloud redirected the connection. Check its service address settings.')


def request(config, url, method='GET', body=None, credentials=None, headers=None, timeout=15):
    context = ssl.create_default_context()
    if config['rootCa']:
        context.load_verify_locations(cadata=config['rootCa'])
    fields = {'User-Agent': USER_AGENT, 'Accept': 'application/json'}
    fields.update(headers or {})
    if credentials:
        fields['Authorization'] = 'Basic ' + base64.b64encode((credentials['username'] + ':' + credentials['appPassword']).encode()).decode()
    operation = urllib.request.Request(url, data=body, method=method, headers=fields)
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context), NoRedirect())
    try:
        with client.open(operation, timeout=timeout) as response:
            result = response.read(MAX_RESPONSE + 1)
            require(len(result) <= MAX_RESPONSE, 'response-too-large', 'Nextcloud returned too much data for this operation.')
            return response.status, result
    except urllib.error.HTTPError as error:
        return error.code, b''
    except (OSError, urllib.error.URLError, ValueError):
        raise ConnectionError('unavailable', 'Nextcloud could not be reached with a trusted HTTPS connection.') from None


def json_response(raw):
    try:
        value = json.loads(raw)
        require(isinstance(value, dict), 'invalid-response', 'Nextcloud returned an invalid response.')
        return value
    except (ValueError, UnicodeError):
        raise ConnectionError('invalid-response', 'Nextcloud returned an invalid response.') from None


def private_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(not path.is_symlink() and path.is_dir() and path.stat().st_uid == os.geteuid(),
            'unsafe-state', 'The private Nextcloud connection directory is unsafe.')
    path.chmod(0o700)


def write_state(directory, value):
    encoded = (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
    require(len(encoded) <= MAX_STATE, 'unsafe-state', 'Nextcloud connection state is too large.')
    descriptor, temporary = tempfile.mkstemp(prefix='.connection-', dir=directory)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, directory / 'state.json')
        descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        Path(temporary).unlink(missing_ok=True)


def validate_credentials(value):
    require(text_value(value.get('username'), 256) and ':' not in value['username'] and text_value(value.get('appPassword'), 512),
            'invalid-response', 'Nextcloud returned invalid account credentials.')


def read_state(directory):
    try:
        state = private_read(directory / 'state.json', MAX_STATE)
    except FileNotFoundError:
        return {'version': 1, 'browsePath': ''}
    require(isinstance(state, dict) and state.get('version') == 1, 'unsafe-state', 'Nextcloud connection state is invalid.')
    relative_path(state.get('browsePath'))
    pending = state.get('pending')
    if pending is not None:
        require(isinstance(pending, dict) and text_value(pending.get('id'), 128)
                and pending.get('state') in ('waiting', 'received') and type(pending.get('createdAt')) in (int, float)
                and type(pending.get('expiresAt')) in (int, float) and math.isfinite(pending['createdAt']) and math.isfinite(pending['expiresAt'])
                and pending['expiresAt'] == pending['createdAt'] + FLOW_SECONDS,
                'unsafe-state', 'Nextcloud authorization state is invalid.')
        require(isinstance(pending.get('allowedBaseUrls'), list) and 1 <= len(pending['allowedBaseUrls']) <= 128,
                'unsafe-state', 'Nextcloud authorization state is invalid.')
        allowed = [base_url(item) for item in pending['allowedBaseUrls']]
        require(base_url(pending.get('internalBaseUrl')) in allowed and base_url(pending.get('browserBaseUrl')) in allowed,
                'unsafe-state', 'Nextcloud authorization state is invalid.')
        route(pending.get('loginUrl'), allowed, r'/(?:index\.php/)?login/v2/flow/[A-Za-z0-9_-]{16,512}')
        route(pending.get('pollEndpoint'), allowed, r'/(?:index\.php/)?login/v2/poll')
        require(text_value(pending.get('pollToken'), 4096), 'unsafe-state', 'Nextcloud authorization state is invalid.')
        if pending['state'] == 'received':
            validate_credentials(pending)
    retired = state.get('retiredConnections', [])
    require(isinstance(retired, list) and len(retired) <= 16, 'unsafe-state', 'Nextcloud saved account state is invalid.')
    for connection in ([state['connection']] if state.get('connection') is not None else []) + retired:
        require(isinstance(connection, dict) and text_value(connection.get('id'), 128)
                and text_value(connection.get('accountId'), 256) and text_value(connection.get('displayName'), 256),
                'unsafe-state', 'Nextcloud account state is invalid.')
        validate_credentials(connection)
        internal = base_url(connection.get('internalBaseUrl'))
        account = account_id(connection['accountId'])
        require(connection.get('url') == internal + '/remote.php/dav/files/' + urllib.parse.quote(account, safe='') + '/',
                'unsafe-state', 'Nextcloud account state is invalid.')
    return state


def account_id(value):
    require(text_value(value, 256) and value not in ('.', '..') and '/' not in value and '\\' not in value,
            'invalid-response', 'Nextcloud returned an invalid account identifier.')
    return value


def public_state(state):
    pending = state.get('pending')
    connection = state.get('connection')
    status = 'connected' if connection else 'disconnected'
    if pending:
        status = 'received' if pending['state'] == 'received' else 'expired' if time.time() >= pending['expiresAt'] else 'waiting'
    return {'ok': True, 'state': status,
            'pending': {'id': pending['id'], 'authorizationUrl': pending['loginUrl'], 'expiresAt': pending['expiresAt']} if pending else None,
            'connection': {key: connection[key] for key in ('id', 'accountId', 'displayName')} if connection else None}


def authorize_endpoint(config, source):
    require(source['internalBaseUrl'] in config['allowedBaseUrls'], 'service-address-changed',
            'The Nextcloud service address changed. Restore the previous connection address before continuing this authorization.')


def prune_revoked(config, directory, state):
    retained = []
    deadline = time.monotonic() + 8
    previous = state.get('retiredConnections', [])
    for connection in previous:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or connection['internalBaseUrl'] not in config['allowedBaseUrls']:
            retained.append(connection)
            continue
        try:
            code, raw = request(config, connection['internalBaseUrl'] + '/ocs/v1.php/cloud/user?format=json', credentials=connection,
                                headers={'OCS-APIRequest': 'true'}, timeout=min(2, remaining))
        except ConnectionError:
            retained.append(connection)
            continue
        if code != 401:
            retained.append(connection)
    if len(retained) != len(previous):
        state['retiredConnections'] = retained
        write_state(directory, state)


def begin(config, directory, state):
    pending = state.get('pending')
    if pending and (pending['state'] == 'received' or time.time() < pending['expiresAt']):
        return public_state(state)
    if state.get('connection') and len(state.get('retiredConnections', [])) >= 16:
        prune_revoked(config, directory, state)
    require(not state.get('connection') or len(state.get('retiredConnections', [])) < 16,
            'connection-limit', 'Too many account connections are retained. Keep the current connection and review old Dev Workspace grants in Nextcloud Security settings.')
    code, raw = request(config, config['internalBaseUrl'] + '/index.php/login/v2', 'POST', b'')
    require(code == 200, 'authorization-unavailable', 'Nextcloud could not begin browser authorization.')
    data = json_response(raw)
    polling = data.get('poll')
    require(isinstance(polling, dict) and text_value(polling.get('token'), 4096), 'invalid-response', 'Nextcloud returned an invalid authorization response.')
    login_path = route(data.get('login'), config['allowedBaseUrls'], r'/(?:index\.php/)?login/v2/flow/[A-Za-z0-9_-]{16,512}')
    poll_path = route(polling.get('endpoint'), config['allowedBaseUrls'], r'/(?:index\.php/)?login/v2/poll')
    now = time.time()
    state['pending'] = {'id': secrets.token_hex(16), 'state': 'waiting', 'createdAt': now, 'expiresAt': now + FLOW_SECONDS,
                        'internalBaseUrl': config['internalBaseUrl'], 'browserBaseUrl': config['browserBaseUrl'],
                        'allowedBaseUrls': config['allowedBaseUrls'], 'loginUrl': config['browserBaseUrl'] + login_path,
                        'pollEndpoint': config['internalBaseUrl'] + poll_path, 'pollToken': polling['token']}
    write_state(directory, state)
    return public_state(state)


def receive(config, directory, state):
    pending = state.get('pending')
    if not pending or pending['state'] == 'received' or time.time() >= pending['expiresAt']:
        return
    authorize_endpoint(config, pending)
    body = urllib.parse.urlencode({'token': pending['pollToken']}).encode()
    code, raw = request(config, pending['pollEndpoint'], 'POST', body, headers={'Content-Type': 'application/x-www-form-urlencoded'})
    if code == 404:
        return
    require(code == 200, 'authorization-unavailable', 'Nextcloud could not complete browser authorization.')
    data = json_response(raw)
    require(base_url(data.get('server')) in pending['allowedBaseUrls'], 'untrusted-response', 'Nextcloud returned an unexpected account server.')
    credentials = {'username': data.get('loginName'), 'appPassword': data.get('appPassword')}
    validate_credentials(credentials)
    pending.update(credentials)
    pending['state'] = 'received'
    write_state(directory, state)


def revoke(config, credential):
    authorize_endpoint(config, credential)
    code, raw = request(config, credential['internalBaseUrl'] + '/ocs/v2.php/core/apppassword?format=json', 'DELETE',
                        credentials=credential, headers={'OCS-APIRequest': 'true'})
    if code == 401:
        return
    require(code == 200, 'revocation-failed', 'Nextcloud could not revoke the unused connection. Its credentials were retained for retry.')
    data = json_response(raw)
    require(isinstance(data.get('ocs'), dict) and isinstance(data['ocs'].get('meta'), dict) and data['ocs']['meta'].get('statuscode') in (100, 200),
            'revocation-failed', 'Nextcloud could not revoke the unused connection. Its credentials were retained for retry.')


def finish(config, directory, state):
    receive(config, directory, state)
    pending = state.get('pending')
    if not pending or pending['state'] != 'received':
        return public_state(state)
    authorize_endpoint(config, pending)
    code, raw = request(config, pending['internalBaseUrl'] + '/ocs/v1.php/cloud/user?format=json', credentials=pending,
                        headers={'OCS-APIRequest': 'true'})
    require(code not in (401, 403), 'authentication-failed', 'Nextcloud rejected this account connection. Connect the account again.')
    require(code == 200, 'account-unavailable', 'Nextcloud could not load the authorized account. Retry to finish connecting.')
    data = json_response(raw)
    ocs = data.get('ocs')
    require(isinstance(ocs, dict) and isinstance(ocs.get('meta'), dict) and ocs['meta'].get('statuscode') in (100, 200) and isinstance(ocs.get('data'), dict),
            'invalid-response', 'Nextcloud returned invalid account information.')
    account = account_id(ocs['data'].get('id'))
    display_name = ocs['data'].get('display-name') or ocs['data'].get('displayname') or account
    require(text_value(display_name, 256), 'invalid-response', 'Nextcloud returned invalid account information.')
    previous = state.get('connection')
    if previous:
        retired = state.setdefault('retiredConnections', [])
        require(len(retired) < 16, 'connection-limit', 'Too many account connections are retained. Existing credentials were preserved.')
        retired.append(previous)
    state['connection'] = {'id': pending['id'], 'url': pending['internalBaseUrl'] + '/remote.php/dav/files/' + urllib.parse.quote(account, safe='') + '/',
                           'username': pending['username'], 'appPassword': pending['appPassword'], 'accountId': account,
                           'displayName': display_name, 'internalBaseUrl': pending['internalBaseUrl']}
    state['browsePath'] = ''
    del state['pending']
    write_state(directory, state)
    return public_state(state)


def decoded_path(value):
    require(not re.search(r'%(?![0-9a-fA-F]{2})', value), 'invalid-response', 'Nextcloud returned an invalid folder address.')
    return urllib.parse.unquote_to_bytes(value).decode('utf-8', errors='strict')


def directory_properties(item):
    collection = False
    permissions = None
    for propstat in item.findall('{DAV:}propstat'):
        code = propstat.findtext('{DAV:}status', '').split()
        if len(code) < 2 or code[1] != '200':
            continue
        collection = collection or propstat.find('{DAV:}prop/{DAV:}resourcetype/{DAV:}collection') is not None
        value = propstat.find('{DAV:}prop/{http://owncloud.org/ns}permissions')
        if value is not None:
            permissions = value.text or ''
    return collection, permissions is None or all(flag in permissions for flag in 'CKV')


def browse(config, directory, state):
    finish(config, directory, state)
    if state.get('pending'):
        return public_state(state)
    connection = state.get('connection')
    require(connection is not None, 'not-connected', 'Connect your Nextcloud account before choosing a project folder.')
    authorize_endpoint(config, connection)
    path = relative_path(config.get('path', state['browsePath']))
    target = connection['url'] + '/'.join(urllib.parse.quote(part, safe='') for part in path.split('/')) + ('/' if path else '')
    code, raw = request(config, target, 'PROPFIND', PROPFIND, credentials=connection,
                        headers={'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8', 'Accept': 'application/xml'})
    require(code not in (401, 403), 'authentication-failed', 'Nextcloud rejected this account or folder. Reconnect the account or choose another folder.')
    require(code != 404, 'folder-missing', 'The selected Nextcloud folder no longer exists.')
    require(code == 207, 'folder-unavailable', 'Nextcloud could not list this folder.')
    try:
        document_text = raw.decode('utf-8', errors='strict')
        require('\x00' not in document_text and '<!DOCTYPE' not in document_text.upper() and '<!ENTITY' not in document_text.upper(),
                'invalid-response', 'Nextcloud returned invalid folder information.')
        document = ET.fromstring(document_text)
        require(document.tag == '{DAV:}multistatus', 'invalid-response', 'Nextcloud returned invalid folder information.')
        target_path = decoded_path(urllib.parse.urlsplit(target).path).rstrip('/')
        root_path = decoded_path(urllib.parse.urlsplit(connection['url']).path).rstrip('/')
        folders = {}
        found = False
        can_select = False
        for item in document.findall('{DAV:}response'):
            href = item.findtext('{DAV:}href')
            if not text_value(href, 4096):
                continue
            parsed = urllib.parse.urlsplit(urllib.parse.urljoin(target, href))
            if parsed.query or parsed.fragment or parsed.username or parsed.password or '\\' in href:
                continue
            origin = base_url(urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, '', '', '')))
            if origin not in config['allowedBaseUrls']:
                continue
            item_path = decoded_path(parsed.path).rstrip('/')
            collection, writable = directory_properties(item)
            if item_path == target_path and collection:
                found = True
                can_select = bool(path) and writable
                continue
            if not collection or not item_path.startswith(target_path + '/'):
                continue
            name = item_path[len(target_path) + 1:]
            if '/' in name or not name or not item_path.startswith(root_path + '/'):
                continue
            child = item_path[len(root_path) + 1:]
            try:
                relative_path(child, allow_root=False)
            except ConnectionError:
                continue
            folders[child] = {'name': name, 'path': child, 'canSelect': writable}
        require(found, 'invalid-folder', 'The selected Nextcloud path is not an accessible folder.')
        require(len(folders) <= 2000, 'folder-too-large', 'This Nextcloud folder contains too many subfolders to display.')
    except (ValueError, UnicodeError, ET.ParseError):
        raise ConnectionError('invalid-response', 'Nextcloud returned invalid folder information.') from None
    state['browsePath'] = path
    write_state(directory, state)
    result = public_state(state)
    result.update({'path': path, 'parentPath': path.rsplit('/', 1)[0] if '/' in path else '' if path else None,
                   'canSelect': can_select, 'folders': sorted(folders.values(), key=lambda item: (item['name'].casefold(), item['name']))})
    return result


def cancel(config, directory, state):
    pending = state.get('pending')
    if pending:
        receive(config, directory, state)
        pending = state['pending']
        if pending['state'] == 'waiting' and time.time() < pending['expiresAt']:
            result = public_state(state)
            result['message'] = 'Close the Nextcloud authorization page. This unfinished request expires after 20 minutes.'
            return result
        if pending['state'] == 'received':
            require(pending['id'] != config['activeConnectionId'], 'active-connection', 'The active project connection must be preserved.')
            revoke(config, pending)
        del state['pending']
    elif state.get('connection'):
        result = public_state(state)
        result['message'] = 'The connected account has been preserved. Manage completed Dev Workspace grants in Nextcloud Security settings.'
        return result
    write_state(directory, state)
    return public_state(state)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=('begin', 'poll', 'browse', 'status', 'cancel'))
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--state-dir', type=Path, default=STATE_DIRECTORY)
    arguments = parser.parse_args()
    lock = None
    try:
        config = configuration(arguments.config)
        private_directory(arguments.state_dir)
        descriptor = os.open(arguments.state_dir / '.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        lock = os.fdopen(descriptor, 'a')
        info = os.fstat(lock.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_mode & 0o077 == 0,
                'unsafe-state', 'The private Nextcloud connection lock is unsafe.')
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ConnectionError('busy', 'Another Nextcloud connection operation is in progress. Retry shortly.') from None
        state = read_state(arguments.state_dir)
        if arguments.command == 'status':
            result = public_state(state)
        else:
            result = {'begin': begin, 'poll': finish, 'browse': browse, 'cancel': cancel}[arguments.command](config, arguments.state_dir, state)
        print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
        return 0
    except ConnectionError as error:
        print(json.dumps({'ok': False, 'code': error.code, 'message': str(error)}, separators=(',', ':')))
        return 1
    except (OSError, ValueError, KeyError, TypeError, UnicodeError, ssl.SSLError):
        print(json.dumps({'ok': False, 'code': 'operation-failed', 'message': 'The Nextcloud connection operation could not finish safely. Existing account state was retained.'}, separators=(',', ':')))
        return 1
    finally:
        if lock is not None:
            lock.close()


if __name__ == '__main__':
    raise SystemExit(main())
