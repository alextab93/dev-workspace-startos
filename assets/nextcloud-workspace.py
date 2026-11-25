#!/usr/bin/python3
import argparse
import base64
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import ssl
import stat
import subprocess
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


STATE_DIRECTORY = Path('/run/dev-workspace-nextcloud')
CACHE_DIRECTORY = Path('/var/lib/dev-workspace/nextcloud-cache')
MOUNTPOINT = Path('/projects-shared')
PROPFIND = b'<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><d:resourcetype/><oc:permissions/></d:prop></d:propfind>'


class WorkspaceError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        raise WorkspaceError('The WebDAV endpoint redirected the request. Use its final HTTPS URL.')


def require(condition, message):
    if not condition:
        raise WorkspaceError(message)


def private_read(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as source:
        info = os.fstat(source.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_mode & 0o077 == 0,
                'Nextcloud settings must be a private regular file owned by the runtime account.')
        return source.read(131073)


def safe_text(value, limit):
    return isinstance(value, str) and 0 < len(value) <= limit and not any(unicodedata.category(char).startswith('C') for char in value)


def normalize_url(value):
    parts = urllib.parse.urlsplit(value)
    require(parts.scheme == 'https' and parts.hostname and not parts.username and not parts.password
            and not parts.query and not parts.fragment and '\\' not in value, 'Use an HTTPS WebDAV URL without embedded credentials, query, or fragment.')
    port = parts.port
    host = parts.hostname.lower()
    host = '[' + host + ']' if ':' in host else host.encode('idna').decode('ascii')
    authority = host + (':' + str(port) if port and port != 443 else '')
    decoded_path = urllib.parse.unquote(parts.path)
    require(not any(part in ('.', '..') for part in decoded_path.split('/'))
            and not any(unicodedata.category(char).startswith('C') for char in decoded_path)
            and '\\' not in decoded_path, 'The WebDAV URL path is invalid.')
    return urllib.parse.urlunsplit(('https', authority, parts.path.rstrip('/') + '/', '', ''))


def validate_cache_identity(value):
    require(isinstance(value, dict) and set(value) == {'url', 'username', 'subpath'}, 'The saved Nextcloud cache identity is invalid.')
    for key, limit in [('url', 2048), ('username', 256), ('subpath', 1024)]:
        require(safe_text(value.get(key), limit) and value[key].strip()
                and not any(unicodedata.category(char) in ('Zl', 'Zp') for char in value[key]), 'The saved Nextcloud cache identity is invalid.')
    require(':' not in value['username'], 'The saved Nextcloud cache identity is invalid.')
    url = normalize_url(value['url'])
    require(value['url'].strip() == value['url'], 'The saved Nextcloud cache identity is invalid.')
    path = urllib.parse.urlsplit(url).path
    require(re.search(r'/remote\.php/dav/files/[^/]+/$', path) is not None, 'The saved Nextcloud cache identity is invalid.')
    for part in path.split('/'):
        if part:
            require(re.search(r'%(?![0-9A-Fa-f]{2})', part) is None, 'The saved Nextcloud cache identity is invalid.')
            decoded = urllib.parse.unquote(part, errors='strict')
            require(decoded.strip() and decoded not in ('.', '..') and '/' not in decoded and '\\' not in decoded
                    and not any(unicodedata.category(char).startswith('C') or unicodedata.category(char) in ('Zl', 'Zp') for char in decoded), 'The saved Nextcloud cache identity is invalid.')
    subpath = value['subpath']
    require(not subpath.startswith('/') and not re.match(r'^[A-Za-z]:', subpath) and '\\' not in subpath
            and all(part.strip() and part not in ('.', '..') for part in subpath.split('/')), 'The saved Nextcloud cache identity is invalid.')
    return {'url': url, 'username': value['username'], 'subpath': subpath}


def load_config(path):
    try:
        raw = private_read(path)
        require(len(raw) <= 131072, 'Nextcloud settings are too large.')
        data = json.loads(raw)
        require(isinstance(data, dict), 'Nextcloud settings are invalid.')
        for key, limit in [('url', 4096), ('username', 256), ('appPassword', 4096), ('subpath', 1024)]:
            require(safe_text(data.get(key), limit), 'Nextcloud settings contain an invalid field.')
        require(':' not in data['username'], 'The Nextcloud username is invalid.')
        data['url'] = normalize_url(data['url'])
        subpath = data['subpath']
        require(not subpath.startswith('/') and '\\' not in subpath
                and all(part.strip() and part not in ('.', '..') for part in subpath.split('/')),
                'Choose an existing relative Nextcloud project folder without traversal components.')
        if 'cacheIdentity' in data:
            data['cacheIdentity'] = validate_cache_identity(data['cacheIdentity'])
            require(data['cacheIdentity']['subpath'] == subpath, 'The saved Nextcloud cache identity belongs to a different project folder.')
        root_ca = data.get('rootCa')
        require(root_ca is None or isinstance(root_ca, str) and len(root_ca) <= 65536, 'The Nextcloud trust certificate is invalid.')
        data['rootCa'] = root_ca
        return data
    except WorkspaceError:
        raise
    except (OSError, ValueError, TypeError, UnicodeError):
        raise WorkspaceError('Nextcloud settings could not be read safely.') from None


def identity(config):
    if 'cacheIdentity' in config:
        value = validate_cache_identity(config['cacheIdentity'])
        require(value['subpath'] == config['subpath'], 'The saved Nextcloud cache identity belongs to a different project folder.')
        return value
    return {key: config[key] for key in ('url', 'username', 'subpath')}


def cache_key(config):
    return hashlib.sha256(json.dumps(identity(config), sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def endpoint(config):
    return config['url'] + '/'.join(urllib.parse.quote(part, safe='') for part in config['subpath'].split('/')) + '/'


def opener(context):
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context), NoRedirect())


def check_remote(config, timeout=10):
    try:
        context = ssl.create_default_context()
        if config['rootCa']:
            context.load_verify_locations(cadata=config['rootCa'])
        url = endpoint(config)
        authorization = base64.b64encode((config['username'] + ':' + config['appPassword']).encode()).decode()
        request = urllib.request.Request(url, data=PROPFIND, method='PROPFIND', headers={
            'Authorization': 'Basic ' + authorization, 'Depth': '0', 'Content-Type': 'application/xml; charset=utf-8',
        })
        with opener(context).open(request, timeout=timeout) as response:
            require(response.status == 207, 'The selected endpoint did not return a WebDAV directory response.')
            body = response.read(1048577)
        require(len(body) <= 1048576 and b'<!DOCTYPE' not in body.upper() and b'<!ENTITY' not in body.upper(),
                'The WebDAV directory response is invalid.')
        document = ET.fromstring(body)
        expected_path = urllib.parse.unquote(urllib.parse.urlsplit(url).path).rstrip('/')
        for item in document.findall('{DAV:}response'):
            href = item.findtext('{DAV:}href')
            if not href:
                continue
            href_url = urllib.parse.urlsplit(urllib.parse.urljoin(url, href))
            if (href_url.scheme, href_url.netloc) != (urllib.parse.urlsplit(url).scheme, urllib.parse.urlsplit(url).netloc):
                continue
            if urllib.parse.unquote(href_url.path).rstrip('/') != expected_path:
                continue
            collection = False
            permissions = None
            for propstat in item.findall('{DAV:}propstat'):
                status_code = propstat.findtext('{DAV:}status', '').split()
                if len(status_code) >= 2 and status_code[1] == '200':
                    collection = collection or propstat.find('{DAV:}prop/{DAV:}resourcetype/{DAV:}collection') is not None
                    value = propstat.find('{DAV:}prop/{http://owncloud.org/ns}permissions')
                    if value is not None:
                        permissions = value.text or ''
            if collection:
                require(permissions is None or all(flag in permissions for flag in 'CKV'), 'Nextcloud reports insufficient create or update permissions for this folder.')
                return {'ok': True, 'directory': True, 'permissionsReported': permissions is not None}
        raise WorkspaceError('The selected Nextcloud path is not an accessible directory.')
    except WorkspaceError:
        raise
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            raise WorkspaceError('Nextcloud rejected the account or app password.') from None
        if error.code == 404:
            raise WorkspaceError('The selected Nextcloud folder does not exist.') from None
        raise WorkspaceError('Nextcloud could not validate the selected folder.') from None
    except (OSError, ValueError, ET.ParseError, urllib.error.URLError):
        raise WorkspaceError('Nextcloud could not be reached with a trusted HTTPS connection.') from None


def atomic_json(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.state-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(value, output, separators=(',', ':'))
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def private_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(not path.is_symlink() and path.is_dir() and path.stat().st_uid == os.geteuid(), 'A private Nextcloud runtime directory is unsafe.')
    path.chmod(0o700)


def files_in(path):
    files = {}
    uncertain = False
    if not path.exists():
        return files, path.is_symlink()
    if path.is_symlink() or not path.is_dir():
        return files, True
    def on_error(error):
        nonlocal uncertain
        uncertain = True
    for directory, children, names in os.walk(path, followlinks=False, onerror=on_error):
        for name in list(children):
            if (Path(directory) / name).is_symlink():
                children.remove(name)
                uncertain = True
        for name in names:
            item = Path(directory) / name
            if item.is_symlink() or not item.is_file():
                uncertain = True
            else:
                files[item.relative_to(path).as_posix()] = item
    return files, uncertain


def metadata_valid(value):
    if not isinstance(value, dict) or set(value) != {'ModTime', 'ATime', 'Size', 'Rs', 'Fingerprint', 'Dirty'} or type(value.get('Dirty')) is not bool or type(value.get('Size')) is not int or not 0 <= value['Size'] < 2 ** 63 or not isinstance(value.get('Fingerprint'), str):
        return False
    try:
        for key in ('ModTime', 'ATime'):
            if not isinstance(value[key], str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,9})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])', value[key]):
                return False
            datetime.datetime.fromisoformat(value[key].replace('Z', '+00:00'))
        ranges = value['Rs']
        return ranges is None or isinstance(ranges, list) and all(
            isinstance(item, dict) and set(item) == {'Pos', 'Size'} and type(item.get('Pos')) is int and 0 <= item['Pos'] < 2 ** 63
            and type(item.get('Size')) is int and 0 <= item['Size'] < 2 ** 63 and item['Pos'] + item['Size'] < 2 ** 63 for item in ranges)
    except (KeyError, TypeError, ValueError, AttributeError):
        return False


def scan_destination(path):
    dirty = 0
    uncertain = False
    try:
        descriptor = json.loads(private_read(path / 'identity.json'))
        require(isinstance(descriptor, dict) and set(descriptor) == {'url', 'username', 'subpath'}, 'The saved Nextcloud destination identity is invalid.')
        require(re.fullmatch('[0-9a-f]{64}', path.name) and cache_key(descriptor) == path.name, 'The saved Nextcloud destination identity is invalid.')
        data, data_error = files_in(path / 'vfs')
        metadata, metadata_error = files_in(path / 'vfsMeta')
        uncertain = data_error or metadata_error or bool(data.keys() - metadata.keys())
        for relative, file in metadata.items():
            try:
                value = json.loads(file.read_bytes())
                if not metadata_valid(value):
                    uncertain = True
                else:
                    if relative not in data and (value['Dirty'] or value['Size'] != 0 or value['Rs'] not in (None, [])):
                        uncertain = True
                    if value['Dirty']:
                        dirty += 1
            except (OSError, ValueError):
                uncertain = True
        for item in path.iterdir():
            if item.name not in ('identity.json', 'vfs', 'vfsMeta'):
                uncertain = True
    except (OSError, ValueError, KeyError, TypeError, WorkspaceError):
        uncertain = True
    return {'dirtyFiles': dirty, 'uncertain': uncertain}


def pending(cache_directory, excluded=None):
    dirty = 0
    uncertain = False
    if not cache_directory.exists():
        return {'pending': cache_directory.is_symlink(), 'dirtyFiles': 0, 'uncertain': cache_directory.is_symlink()}
    try:
        require(not cache_directory.is_symlink() and cache_directory.is_dir(), 'The Nextcloud cache directory is invalid.')
        for item in cache_directory.iterdir():
            if item.name in ('.lock', 'last-status.json'):
                if item.is_symlink() or not item.is_file():
                    uncertain = True
                continue
            if item.name == excluded and item.is_dir() and not item.is_symlink():
                continue
            if not re.fullmatch('[0-9a-f]{64}', item.name) or item.is_symlink() or not item.is_dir():
                uncertain = True
                continue
            result = scan_destination(item)
            dirty += result['dirtyFiles']
            uncertain = uncertain or result['uncertain']
    except (OSError, WorkspaceError):
        uncertain = True
    return {'pending': bool(dirty or uncertain), 'dirtyFiles': dirty, 'uncertain': uncertain}


def process_identity(pid):
    try:
        return Path('/proc/' + str(pid) + '/stat').read_text().rsplit(')', 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def rc_call(state_directory, state):
    context = ssl.create_default_context(cafile=str(state_directory / 'rc.crt'))
    authorization = base64.b64encode(('workspace:' + state['rcPassword']).encode()).decode()
    request = urllib.request.Request('https://127.0.0.1:' + str(state['rcPort']) + '/vfs/stats', data=b'{}', headers={
        'Content-Type': 'application/json', 'Authorization': 'Basic ' + authorization,
    })
    with opener(context).open(request, timeout=3) as response:
        value = json.loads(response.read(1048576))
    cache = value['diskCache']
    require(all(type(cache.get(key)) is int and cache[key] >= 0 for key in ('uploadsQueued', 'uploadsInProgress')), 'Nextcloud upload status is unavailable.')
    return cache


def status(state_directory, cache_directory, config_path):
    saved = pending(cache_directory)
    result = {'ready': False, 'mounted': False, 'pendingUploads': saved['dirtyFiles'], 'uncertain': saved['uncertain'], 'message': 'The Nextcloud workspace is stopped.'}
    try:
        state = json.loads(private_read(state_directory / 'state.json'))
        if not state['processIdentity'] or process_identity(state['pid']) != state['processIdentity'] or state['phase'] != 'ready':
            raise WorkspaceError('The Nextcloud workspace is not accepting SSH sessions.')
        cache = rc_call(state_directory, state)
        result['mounted'] = True
        result['pendingUploads'] = max(saved['dirtyFiles'], cache['uploadsQueued'] + cache['uploadsInProgress'])
        filesystem = os.statvfs(cache_directory)
        storage_full = filesystem.f_bavail <= 0
        result['uncertain'] = saved['uncertain'] or storage_full or bool(cache.get('outOfSpace')) or bool(cache.get('erroredFiles'))
        check_remote(load_config(config_path), timeout=5)
        result['ready'] = not result['uncertain']
        result['message'] = 'Nextcloud is mounted; local edits are awaiting upload.' if result['pendingUploads'] else 'Nextcloud is mounted and no pending cached uploads were found.'
        if result['uncertain']:
            result['message'] = 'Nextcloud cache status requires attention; cached data has been retained.'
        if storage_full:
            result['message'] = 'Nextcloud cache storage is full; free server space. Cached data has been retained.'
    except WorkspaceError as error:
        result['message'] = str(error)
    except (OSError, ValueError, KeyError, TypeError, urllib.error.URLError):
        result['message'] = 'Nextcloud mount or upload status is unavailable; cached data has been retained.'
    return result


def writers():
    found = []
    for process in Path('/proc').iterdir():
        if not process.name.isdigit():
            continue
        try:
            fields = process.joinpath('status').read_text().splitlines()
            user = next(line for line in fields if line.startswith('Uid:')).split()[1:]
            state = next(line for line in fields if line.startswith('State:')).split()[1]
            if '1000' in user and state not in ('Z', 'X'):
                found.append(int(process.name))
        except (OSError, StopIteration):
            pass
    return found


def stop_writers():
    deadline = time.monotonic() + 5
    while True:
        processes = writers()
        if not processes:
            return
        force = time.monotonic() >= deadline
        for pid in processes:
            try:
                os.kill(pid, signal.SIGKILL if force else signal.SIGTERM)
            except ProcessLookupError:
                pass
        if force:
            time.sleep(0.25)
            require(not writers(), 'Development processes could not be stopped; cached uploads were retained.')
            return
        time.sleep(0.1)


def stop_process(process, timeout=3):
    if process is None or process.poll() is not None:
        return
    try:
        process.terminate()
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            process.kill()
        except ProcessLookupError:
            return
        process.wait(timeout=2)


def mount_command(subpath, mountpoint, remote_config, destination, certificate, certificate_key, port):
    filesystem = os.statvfs(destination)
    capacity = filesystem.f_frsize * filesystem.f_blocks
    require(capacity > 0, 'The Nextcloud cache filesystem capacity could not be determined.')
    return ['rclone', 'mount', 'workspace:' + subpath, str(mountpoint), '--config', str(remote_config), '--cache-dir', str(destination),
               '--vfs-cache-mode', 'full', '--vfs-cache-poll-interval', '1s', '--vfs-cache-max-size', str(capacity), '--vfs-cache-max-age', str(2 ** 63 - 1) + 'ns', '--vfs-write-back', '1s', '--dir-cache-time', '5s', '--poll-interval', '0',
               '--uid', '1000', '--gid', '1000', '--file-perms', '0660', '--dir-perms', '0770', '--umask', '0007', '--allow-other', '--default-permissions',
               '--rc', '--rc-addr', '127.0.0.1:' + str(port), '--rc-cert', str(certificate), '--rc-key', str(certificate_key), '--log-level', 'ERROR']


def serve(arguments):
    require(os.geteuid() == 0, 'The Nextcloud workspace supervisor must run as root.')
    os.umask(0o077)
    config = load_config(arguments.config)
    key = cache_key(config)
    private_directory(arguments.cache_dir)
    private_directory(arguments.state_dir)
    lock = open(arguments.cache_dir / '.lock', 'a')
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise WorkspaceError('Another Nextcloud workspace is already using this cache.') from None
    others = pending(arguments.cache_dir, key)
    require(not others['pending'], 'Another Nextcloud destination has pending or uncertain cached uploads. Restore that destination before changing it.')
    destination = arguments.cache_dir / key
    if destination.exists():
        require(not scan_destination(destination)['uncertain'], 'Saved Nextcloud cache metadata is incomplete. Cached data was retained and the mount was not started.')
    else:
        private_directory(destination)
        atomic_json(destination / 'identity.json', identity(config))
    check_remote(config)
    mountpoint = arguments.mountpoint
    require(not os.path.ismount(mountpoint), 'The shared project directory is already mounted.')
    private_directory(mountpoint)
    require(not any(mountpoint.iterdir()), 'The unmounted shared project directory is not empty.')
    password = subprocess.run(['rclone', 'obscure', '-'], input=config['appPassword'] + '\n', text=True, capture_output=True, timeout=10)
    require(password.returncode == 0 and re.fullmatch(r'[A-Za-z0-9_-]+\s*', password.stdout), 'Nextcloud mount credentials could not be prepared.')
    remote_config = arguments.state_dir / 'rclone.conf'
    remote_config.write_text('[workspace]\ntype = webdav\nvendor = nextcloud\nurl = `' + config['url']
                             + '`\nuser = `' + config['username'] + '`\npass = ' + password.stdout.strip() + '\n')
    remote_config.chmod(0o600)
    exported = subprocess.run(['rclone', 'config', 'dump', '--config', str(remote_config)], capture_output=True, text=True, timeout=10)
    require(exported.returncode == 0, 'Nextcloud mount credentials could not be prepared.')
    values = json.loads(exported.stdout)['workspace']
    require(values.get('url') == config['url'] and values.get('user') == config['username'] and values.get('pass') == password.stdout.strip(),
            'Nextcloud settings contain unsupported credential characters.')
    certificate = arguments.state_dir / 'rc.crt'
    certificate_key = arguments.state_dir / 'rc.key'
    generated = subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '36500', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', str(certificate_key), '-out', str(certificate)], capture_output=True, timeout=20)
    require(generated.returncode == 0, 'Private Nextcloud status transport could not be prepared.')
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    state = {'pid': os.getpid(), 'processIdentity': process_identity(os.getpid()), 'key': key, 'phase': 'starting', 'rcPort': port, 'rcPassword': secrets.token_hex(32)}
    atomic_json(arguments.state_dir / 'state.json', state)
    command = mount_command(config['subpath'], mountpoint, remote_config, destination, certificate, certificate_key, port)
    if config['rootCa']:
        trust = arguments.state_dir / 'ca.pem'
        trust.write_text(Path('/etc/ssl/certs/ca-certificates.crt').read_text() + '\n' + config['rootCa'])
        command.extend(['--ca-cert', str(trust)])
    environment = {key: value for key, value in os.environ.items() if not key.startswith('RCLONE_') and key.lower() not in ('http_proxy', 'https_proxy', 'all_proxy')}
    environment.update({'RCLONE_RC_USER': 'workspace', 'RCLONE_RC_PASS': state['rcPassword']})
    stopping = False
    def request_stop(number, frame):
        nonlocal stopping
        stopping = True
    previous = {number: signal.signal(number, request_stop) for number in (signal.SIGTERM, signal.SIGINT)}
    rclone = None
    sshd = None
    drained = False
    failure = None
    log = open(arguments.state_dir / 'rclone.log', 'ab')
    try:
        rclone = subprocess.Popen(command, env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log)
        deadline = time.monotonic() + 45
        while not stopping:
            require(rclone.poll() is None, 'The Nextcloud filesystem mount failed. Cached data was retained.')
            if os.path.ismount(mountpoint):
                try:
                    rc_call(arguments.state_dir, state)
                    readable = subprocess.run(['/usr/bin/python3', '-c', 'import os,sys; os.stat(sys.argv[1]); next(os.scandir(sys.argv[1]), None)', str(mountpoint)],
                                              user=1000, group=1000, extra_groups=[], stdin=subprocess.DEVNULL, capture_output=True, timeout=5)
                    require(readable.returncode == 0, 'The shared Nextcloud directory is not readable by the development account.')
                    break
                except (OSError, ValueError, KeyError, WorkspaceError):
                    pass
            require(time.monotonic() < deadline, 'The Nextcloud filesystem did not become ready. Cached data was retained.')
            time.sleep(0.2)
        if not stopping:
            sshd = subprocess.Popen(['/usr/local/bin/workspace-session'], stdin=subprocess.DEVNULL)
            state['phase'] = 'ready'
            atomic_json(arguments.state_dir / 'state.json', state)
            while not stopping:
                require(rclone.poll() is None, 'The Nextcloud filesystem stopped unexpectedly. Cached data was retained.')
                require(sshd.poll() is None, 'SSH stopped unexpectedly. Cached data was retained.')
                time.sleep(0.25)
    except WorkspaceError as error:
        failure = error
    finally:
        cleanup_failed = False
        def cleanup(operation):
            nonlocal cleanup_failed
            try:
                return operation()
            except (OSError, ValueError, KeyError, TypeError, WorkspaceError, subprocess.SubprocessError):
                cleanup_failed = True
                return None
        state['phase'] = 'stopping'
        cleanup(lambda: atomic_json(arguments.state_dir / 'state.json', state))
        cleanup(lambda: stop_process(sshd))
        try:
            stop_writers()
            deadline = time.monotonic() + arguments.drain_timeout
            quiet = 0
            while rclone is not None and rclone.poll() is None and time.monotonic() < deadline:
                try:
                    cache = rc_call(arguments.state_dir, state)
                    saved = scan_destination(destination)
                    clear = not saved['dirtyFiles'] and not saved['uncertain'] and cache['uploadsQueued'] == 0 and cache['uploadsInProgress'] == 0 and not cache.get('outOfSpace') and not cache.get('erroredFiles')
                    quiet = quiet + 1 if clear else 0
                    if quiet >= 2:
                        drained = True
                        break
                except (OSError, ValueError, KeyError, WorkspaceError):
                    quiet = 0
                time.sleep(0.5)
        except (OSError, ValueError, KeyError, TypeError, WorkspaceError, subprocess.SubprocessError):
            cleanup_failed = True
        cleanup(lambda: stop_process(rclone))
        if os.path.ismount(mountpoint):
            unmounted = cleanup(lambda: subprocess.run(['fusermount3', '-u', str(mountpoint)], capture_output=True, timeout=5))
            cleanup_failed = cleanup_failed or unmounted is None or unmounted.returncode != 0
        remaining = scan_destination(destination)
        state['phase'] = 'stopped'
        cleanup(lambda: atomic_json(arguments.state_dir / 'state.json', state))
        cleanup(lambda: atomic_json(arguments.cache_dir / 'last-status.json', {'drained': drained and not cleanup_failed and not remaining['dirtyFiles'] and not remaining['uncertain'], **remaining}))
        cleanup(log.close)
        for number, handler in previous.items():
            cleanup(lambda: signal.signal(number, handler))
        cleanup(lambda: remote_config.unlink(missing_ok=True))
        cleanup(lock.close)
        if cleanup_failed:
            failure = WorkspaceError('Nextcloud shutdown could not be verified completely. Cached data has been retained.')
    if failure:
        raise failure
    require(drained and not remaining['dirtyFiles'] and not remaining['uncertain'], 'Nextcloud uploads did not drain completely. Cached data was retained; restart the same source to resume uploads.')
    return {'ok': True, 'drained': True}


def export_artifact(config, destination, staged):
    require(all(safe_text(part, 255) and part not in ('.', '..') and chr(92) not in part
                for part in destination.split('/')), 'Invalid export destination.')
    url = endpoint(config) + '/'.join(urllib.parse.quote(part, safe='') for part in destination.split('/'))
    context = ssl.create_default_context()
    if config['rootCa']:
        context.load_verify_locations(cadata=config['rootCa'])
    client = opener(context)
    auth = base64.b64encode((config['username'] + ':' + config['appPassword']).encode()).decode()
    headers = {'Authorization': 'Basic ' + auth}
    try:
        with client.open(urllib.request.Request(url, method='HEAD', headers=headers), timeout=10):
            raise WorkspaceError('The destination file already exists.')
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise WorkspaceError('Nextcloud could not check the destination. Check the folder and permissions.') from None
    with staged.open('rb') as source:
        size = os.fstat(source.fileno()).st_size
        expected = hashlib.file_digest(source, 'sha256').hexdigest()
        source.seek(0)
        request = urllib.request.Request(url, method='PUT', data=source, headers={
            **headers, 'Content-Type': 'application/octet-stream', 'Content-Length': str(size), 'If-None-Match': '*',
        })
        try:
            with client.open(request, timeout=120) as response:
                require(response.status == 201, 'Nextcloud did not confirm creation of a new file.')
        except urllib.error.HTTPError as error:
            if error.code == 412:
                raise WorkspaceError('The destination file already exists.') from None
            raise WorkspaceError('Nextcloud refused the upload. Check the destination folder and permissions.') from None
    with client.open(urllib.request.Request(url, headers=headers), timeout=120) as response:
        require(response.status == 200 and hashlib.file_digest(response, 'sha256').hexdigest() == expected,
                'Nextcloud read-back verification failed. Inspect the destination before retrying.')
    return {'file': destination, 'bytes': size, 'sha256': expected}


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('check', 'serve', 'status', 'pending', 'export'):
        command = commands.add_parser(name)
        command.add_argument('--config', type=Path, default=None if name == 'pending' else STATE_DIRECTORY / 'config.json')
        command.add_argument('--state-dir', type=Path, default=STATE_DIRECTORY)
        command.add_argument('--cache-dir', type=Path, default=CACHE_DIRECTORY)
        if name == 'export':
            command.add_argument('staged', type=Path)
            command.add_argument('destination')
        if name == 'serve':
            command.add_argument('--mountpoint', type=Path, default=MOUNTPOINT)
            command.add_argument('--drain-timeout', type=float, default=80)
    arguments = parser.parse_args()
    try:
        if arguments.command == 'export':
            readiness = status(arguments.state_dir, arguments.cache_dir, arguments.config)
            require(readiness['ready'] and readiness['pendingUploads'] == 0,
                    'Wait for queued Nextcloud uploads to finish before exporting.')
            result = export_artifact(load_config(arguments.config), arguments.destination, arguments.staged)
        elif arguments.command == 'check':
            result = check_remote(load_config(arguments.config))
        elif arguments.command == 'pending':
            excluded = cache_key(load_config(arguments.config)) if arguments.config else None
            result = pending(arguments.cache_dir, excluded)
        elif arguments.command == 'status':
            result = status(arguments.state_dir, arguments.cache_dir, arguments.config)
        else:
            result = serve(arguments)
        print(json.dumps(result, separators=(',', ':')))
        return 1 if arguments.command == 'pending' and result['pending'] else 0
    except WorkspaceError as error:
        print(json.dumps({'ok': False, 'message': str(error)}, separators=(',', ':')))
        return 1
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print(json.dumps({'ok': False, 'message': 'Nextcloud runtime operation failed safely. Cached data has been retained.'}, separators=(',', ':')))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
