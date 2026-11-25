#!/usr/bin/python3
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import socket
import socketserver
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid


STATE = Path('/var/lib/dev-workspace/packages')
RUNTIME = Path('/run/dev-workspace-packages')
SOCKET = RUNTIME / 'manager.sock'
CLI = '/usr/local/bin/start-cli'
FILES = '/usr/local/bin/workspace-package-files'
SEED = Path('/run/dev-workspace/local-startos.json')
MAX_MESSAGE = 16 * 1024 * 1024


class PackageError(Exception):
    pass


def now():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, value):
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix='.state-')
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def read_json(path, default):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def private_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    metadata = path.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0:
        raise PackageError('Package manager storage must be a root-owned directory.')
    path.chmod(0o700)


def local_seed():
    metadata = SEED.parent.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
        raise PackageError('Local StartOS connection information is unavailable.')
    descriptor = os.open(SEED, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022 or metadata.st_size > 140000:
            raise PackageError('Local StartOS connection information is invalid.')
        with os.fdopen(descriptor, 'rb', closefd=False) as source:
            contents = source.read(140001)
        if len(contents) > 140000:
            raise PackageError('Local StartOS connection information is invalid.')
        seed = json.loads(contents)
    finally:
        os.close(descriptor)
    if not isinstance(seed, dict) or set(seed) != {'version', 'url', 'rootCa', 'restoreGeneration'} or type(seed['version']) is not int or seed['version'] != 1 or not isinstance(seed['rootCa'], str) or not isinstance(seed['url'], str):
        raise PackageError('Local StartOS connection information is invalid.')
    generation = seed['restoreGeneration']
    if generation is not None and (not isinstance(generation, str) or re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', generation) is None):
        raise PackageError('The workspace restore identity state is invalid. Repair service initialization before connecting.')
    if not re.fullmatch(r'https://(?:\[[0-9a-fA-F:]+\]|[0-9.]+)(?::[0-9]+)?', seed['url']):
        raise PackageError('Local StartOS connection information is invalid.')
    return seed


class Manager:
    def __init__(self, state=STATE):
        self.state = state
        private_directory(state)
        self.lock = threading.RLock()
        self.processes = set()
        self.scan_process = None
        self.cancel_requested = False
        self.scan_committed = False
        self.stopping = False
        self.job = read_json(state / 'job.json', None)
        if self.job and self.job['state'] == 'running':
            message = ('The workspace restarted. Inspect the shared destination before retrying.'
                       if self.job.get('operation', '').startswith('export-')
                       else 'The workspace restarted. Check the operation before retrying.')
            self.job.update(state='interrupted', message=message, finishedAt=now())
            write_json(state / 'job.json', self.job)
            history = read_json(state / 'history.json', [])
            history.append(dict(self.job))
            write_json(state / 'history.json', history[-30:])
        for entry in state.glob('stage-*.s9pk'):
            if entry.is_file() and not entry.is_symlink():
                entry.unlink()

    def environment(self):
        return {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(self.state), 'LANG': 'C.UTF-8', 'NO_COLOR': '1'}

    def identity_path(self, seed=None, create=False):
        generation = (seed if seed is not None else local_seed())['restoreGeneration']
        directory = self.state
        if generation is not None:
            directory = self.state / 'identities' / generation
            for path in (self.state / 'identities', directory):
                if not os.path.lexists(path) and not create:
                    return directory / 'id.key.pem'
                private_directory(path)
        return directory / 'id.key.pem'

    def identity_present(self, key=None):
        key = key if key is not None else self.identity_path()
        try:
            metadata = key.lstat()
        except FileNotFoundError:
            return False
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o077:
            raise PackageError('The package manager identity must be a private root-owned regular file.')
        return True

    def command(self, enrolling=False):
        for path in (self.state / '.startos/config.yaml', Path('/etc/startos/config.yaml'), Path('/run/startos/id.key.pem')):
            if os.path.lexists(path):
                raise PackageError('Ambient StartOS configuration prevents isolated package manager access.')
        seed = local_seed()
        key = self.identity_path(seed, create=enrolling)
        if not self.identity_present(key) and not enrolling:
            raise PackageError('Connect to StartOS before installing a package. Restored workspaces require a fresh connection.')
        ca = self.state / 'root-ca.pem'
        descriptor, temporary = tempfile.mkstemp(dir=self.state, prefix='.ca-')
        with os.fdopen(descriptor, 'w') as output:
            output.write(seed['rootCa'])
        os.replace(temporary, ca)
        return [CLI, '-H', seed['url'], '--root-ca', str(ca), '--id-key-path', str(key)]

    def run(self, command, timeout=60, environment=None, user=None, output=None, progress=None):
        options = {'user': user, 'group': user, 'extra_groups': []} if user is not None else {}
        with self.lock:
            if self.stopping:
                raise PackageError('The workspace is stopping.')
            if command[:2] == [FILES, 'scan'] and self.cancel_requested:
                raise PackageError('Scan cancelled. The previous catalog was retained.')
            process = subprocess.Popen(command, cwd='/' if user is not None else self.state, env=environment or self.environment(),
                                       stdin=subprocess.DEVNULL, stdout=output or subprocess.PIPE, stderr=subprocess.PIPE,
                                       start_new_session=True, **options)
            self.processes.add(process)
            if command[:2] == [FILES, 'scan']:
                self.scan_process = process
        try:
            if progress is None:
                stdout, stderr = process.communicate(timeout=timeout)
            else:
                deadline = time.monotonic() + timeout
                latest = None
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise subprocess.TimeoutExpired(command, timeout)
                    try:
                        stdout, stderr = process.communicate(timeout=min(1, remaining))
                        break
                    except subprocess.TimeoutExpired as pending:
                        lines = (pending.output or b'').split(b'\n')[:-1]
                        current = lines[-1] if lines else None
                        if current != latest and current in progress:
                            self.update(message=progress[current])
                            latest = current
            if process.returncode:
                if command[0] == '/usr/local/bin/workspace-import':
                    lines = stderr.decode(errors='replace').strip().splitlines()
                    raise PackageError(lines[-1][:512] if lines else 'Import interrupted. Retry the project import.')
                if command[:2] == ['/usr/local/bin/nextcloud-workspace', 'export']:
                    try:
                        message = json.loads(stdout)['message']
                    except (ValueError, KeyError, TypeError):
                        message = 'Nextcloud export was interrupted. Inspect the destination before retrying.'
                    raise PackageError(message)
                if command[:2] == [FILES, 'export-filebrowser']:
                    reason = stderr.decode('utf-8', errors='replace').strip()
                    if reason == 'The destination file already exists.':
                        raise PackageError(reason)
                    raise PackageError('Export failed. Check both paths, free space and destination permissions.')
                raise PackageError('The operation failed. Check server access, package compatibility, and signer trust before retrying.')
            return (stdout or b'').decode('utf-8')
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            with self.lock:
                self.processes.discard(process)
                if self.scan_process is process:
                    self.scan_process = None

    def installed(self):
        value = json.loads(self.run(self.command() + ['package', 'list', '--format', 'json']))
        if not isinstance(value, list):
            raise PackageError('StartOS returned an invalid package list.')
        return {entry['id']: entry for entry in value if isinstance(entry, dict) and 'id' in entry}

    def catalog(self):
        value = read_json(self.state / 'catalog.json', {'packages': [], 'errors': [], 'truncated': False, 'scannedAt': None})
        installed = {}
        connected = False
        try:
            if self.identity_present():
                installed = self.installed()
                connected = True
        except (PackageError, OSError, subprocess.SubprocessError, ValueError):
            pass
        architecture = {'AMD64': 'x86_64', 'arm64': 'aarch64'}.get(platform.machine(), platform.machine())
        packages = []
        for item in value['packages']:
            packages.append({**{key: item[key] for key in ('token', 'path', 'id', 'title', 'version', 'size', 'sha256', 'architectures')},
                             'compatible': architecture in item['architectures'],
                             'installedVersion': installed.get(item['id'], {}).get('version')})
        return {**value, 'packages': packages, 'connected': connected, 'architecture': architecture}

    def update(self, **fields):
        with self.lock:
            self.job.update(fields)
            write_json(self.state / 'job.json', self.job)

    def scan(self, scope):
        self.update(message='Scanning ' + scope + ' project folders. Large trees can take several minutes.')
        result = json.loads(self.run([FILES, 'scan', '--scope', scope], timeout=3900, user=1000))
        for item in result['packages']:
            item['token'] = uuid.uuid4().hex
        result['scannedAt'] = now()
        result['scope'] = scope
        with self.lock:
            if self.cancel_requested:
                raise PackageError('Scan cancelled. The previous catalog was retained.')
            write_json(self.state / 'catalog.json', result)
            self.scan_committed = True
            self.update(message='Scan finished: ' + str(len(result['packages'])) + ' packages found.' + (' Results are incomplete; check Browse S9PK Packages for details.' if result['truncated'] else ''))

    def connect(self, password):
        if not isinstance(password, str) or not 1 <= len(password) <= 4096 or '\0' in password:
            raise PackageError('Enter the StartOS password.')
        environment = self.environment()
        environment['PASSWORD'] = password
        try:
            self.run(self.command(enrolling=True) + ['auth', 'login'], environment=environment)
            self.installed()
        except (PackageError, subprocess.SubprocessError):
            raise PackageError('StartOS authorization failed. Check the server password and connection.') from None
        finally:
            environment.clear()
        self.update(message='StartOS is connected. The server password was not saved.')

    def disconnect(self):
        key = self.identity_path()
        if self.identity_present(key):
            self.run(self.command() + ['auth', 'logout'])
            key.unlink()
        self.update(message='The package manager identity was revoked and removed.')

    def install(self, item, trust):
        if not self.identity_present():
            raise PackageError('Connect to StartOS before installing a package. Restored workspaces require a fresh connection.')
        self.installed()
        if shutil.disk_usage(self.state).free < item['size'] + 512 * 1024 ** 2:
            raise PackageError('Insufficient local space to stage this package. At least the package size plus 512 MiB is required.')
        path = self.state / ('stage-' + uuid.uuid4().hex + '.s9pk')
        try:
            self.update(message='Copying the selected package to local storage.')
            with path.open('xb') as output:
                os.fchmod(output.fileno(), 0o600)
                try:
                    self.run([FILES, 'stream', item['path']], timeout=3600, user=1000, output=output)
                except (PackageError, subprocess.SubprocessError):
                    raise PackageError('The selected package could not be read. It may have changed, been removed, or its project source is unavailable. Restore source access and run Scan S9PK Packages again.') from None
                output.flush()
                os.fsync(output.fileno())
            if path.stat().st_size != item['size']:
                raise PackageError('The package changed after scanning. Run Scan S9PK Packages again.')
            with path.open('rb') as source:
                digest = hashlib.file_digest(source, 'sha256').hexdigest()
            if digest != item['sha256']:
                raise PackageError('The package changed after scanning. Run Scan S9PK Packages again.')
            self.update(message='Uploading and installing the verified local copy. StartOS checks signatures, integrity, and compatibility.')
            command = self.command() + ['package', 'install', '--sideload', str(path)]
            if trust:
                command.append('--trust')
            self.run(command, timeout=7200)
            installed = self.installed().get(item['id'])
            if not installed or installed.get('version') != item['version'] or installed.get('status') != 'installed':
                raise PackageError('Installation could not be confirmed. Check the service in StartOS before retrying.')
            self.update(message='Installed ' + item['title'] + ' ' + item['version'] + '.')
        finally:
            path.unlink(missing_ok=True)

    def start(self, operation, function, package=None):
        with self.lock:
            if self.job and self.job['state'] == 'running':
                raise PackageError('Another package operation is running. Check Installation Status.')
            self.job = {'id': uuid.uuid4().hex, 'operation': operation, 'state': 'running', 'startedAt': now(),
                        'finishedAt': None, 'message': 'Starting operation.', 'package': package}
            self.cancel_requested = False
            self.scan_committed = False
            write_json(self.state / 'job.json', self.job)
            def execute():
                final = {'state': 'succeeded'}
                try:
                    function()
                except (OSError, ValueError, KeyError, TypeError, PackageError, subprocess.SubprocessError) as error:
                    message = str(error) if isinstance(error, PackageError) else 'The operation could not finish. Check the service logs and server state before retrying.'
                    final = {'state': 'failed', 'message': message}
                finally:
                    with self.lock:
                        if operation == 'scan' and self.cancel_requested:
                            final = {'state': 'cancelled', 'message': 'Scan cancelled. The previous catalog was retained.'}
                        self.update(**final, finishedAt=now())
                        history = read_json(self.state / 'history.json', [])
                        history.append(dict(self.job))
                        write_json(self.state / 'history.json', history[-30:])
            threading.Thread(target=execute, daemon=True).start()
            return dict(self.job)

    def import_project(self, request):
        self.update(message='Copying the shared project to local staging and verifying its contents.')
        output = self.run(['/usr/local/bin/workspace-import', request['provider'], '--', request['source'],
                           request['destination']], user=1000, timeout=86400, progress={
            b'copy': 'Copying shared files into a new local staging directory.',
            b'verify': 'Verifying source and destination contents and checking for changed files.',
            b'git': 'Restoring Git executable permissions and symbolic links in the verified local copy.',
        })
        result = json.loads(output.splitlines()[-1])
        self.update(message='Verified. Open this folder in VS Code: ' + result['path'])

    def export_filebrowser(self, source, folder):
        if not isinstance(source, str) or not isinstance(folder, str):
            raise PackageError('Enter the local artifact path and shared destination directory.')
        self.update(message='Copying the artifact and verifying the destination SHA-256.')
        output = self.run([FILES, 'export-filebrowser', '--', source, folder], user=1000, timeout=7200,
                          progress={b'copy': 'Copying artifact to shared storage.',
                                    b'verify': 'Verifying the copied artifact SHA-256.'})
        result = json.loads(output.splitlines()[-1])
        self.update(message=f"Exported {result['file']} ({result['bytes']} bytes). SHA-256: {result['sha256']}")

    def export_nextcloud(self, source, folder):
        if not isinstance(source, str) or not isinstance(folder, str):
            raise PackageError('Enter the local artifact path and shared destination directory.')
        path, directory = Path(source), Path(folder)
        if path.is_absolute() or directory.is_absolute() or '..' in path.parts + directory.parts or not path.name:
            raise PackageError('Choose paths relative to the local and shared project directories.')
        with tempfile.NamedTemporaryFile(prefix='stage-', suffix='.s9pk', dir=self.state) as staged:
            self.update(message='Reading the completed artifact from local project storage.')
            self.run([FILES, 'stream', str(Path('/home/dev/projects') / path)], user=1000, output=staged, timeout=3600)
            staged.flush()
            self.update(message='Checking pending uploads, sending the file to Nextcloud and verifying its SHA-256 through WebDAV.')
            result = json.loads(self.run(['/usr/local/bin/nextcloud-workspace', 'export', '--', staged.name,
                                          str(directory / path.name)], timeout=7200))
            self.update(message=f"Exported {result['file']} ({result['bytes']} bytes). SHA-256: {result['sha256']}")

    def dispatch(self, request):
        operation = request.get('operation')
        if operation == 'import-project':
            if request.get('confirmed') is not True or request.get('provider') not in ('filebrowser', 'nextcloud'):
                raise PackageError('Confirm the new local project and select a shared provider.')
            return self.start(operation, lambda: self.import_project(request))
        if operation == 'export-nextcloud':
            return self.start(operation, lambda: self.export_nextcloud(request.get('source'), request.get('folder')))
        if operation == 'export-filebrowser':
            return self.start(operation, lambda: self.export_filebrowser(request.get('source'), request.get('folder')))
        if operation == 'catalog':
            return self.catalog()
        if operation == 'status':
            with self.lock:
                return {'job': self.job, 'history': read_json(self.state / 'history.json', [])}
        if operation == 'scan':
            scope = request.get('scope', 'both')
            if scope not in ('both', 'local', 'shared'):
                raise PackageError('Choose local projects, shared projects, or both.')
            return self.start('scan', lambda: self.scan(scope))
        if operation == 'cancel-scan':
            with self.lock:
                if not self.job or self.job['state'] != 'running' or self.job['operation'] != 'scan' or self.scan_committed:
                    raise PackageError('No package scan is running.')
                self.cancel_requested = True
                if self.scan_process and self.scan_process.poll() is None:
                    try:
                        os.killpg(self.scan_process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                return {'cancelRequested': True}
        if operation == 'connect':
            return self.start('connect', lambda: self.connect(request.get('password')))
        if operation == 'disconnect':
            return self.start('disconnect', self.disconnect)
        if operation == 'install':
            if request.get('confirmed') is not True or type(request.get('trust')) is not bool:
                raise PackageError('Confirm the selected package installation.')
            catalog = self.catalog()
            item = next((item for item in catalog['packages'] if item['token'] == request.get('token')), None)
            if not item:
                raise PackageError('The package selection expired. Open the package list again.')
            if not item['compatible']:
                raise PackageError('This package does not support the server architecture.')
            return self.start('install', lambda: self.install(item, request['trust']), {key: item[key] for key in ('id', 'version', 'title', 'sha256')})
        raise PackageError('Unknown package operation.')

    def stop(self):
        with self.lock:
            self.stopping = True
            for process in list(self.processes):
                if process.poll() is None:
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass


def receive(stream):
    value = stream.readline(MAX_MESSAGE + 1)
    if len(value) > MAX_MESSAGE or not value.endswith(b'\n'):
        raise PackageError('Invalid package manager request.')
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise PackageError('Invalid package manager request.')
    return parsed


def serve():
    if os.geteuid() != 0:
        raise PackageError('The package manager requires the service administrator.')
    private_directory(RUNTIME)
    lock = os.open(RUNTIME / 'manager.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if SOCKET.exists():
        if not stat.S_ISSOCK(SOCKET.lstat().st_mode):
            raise PackageError('Unexpected package manager socket path.')
        SOCKET.unlink()
    manager = Manager()
    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            self.request.settimeout(120)
            try:
                _, uid, _ = struct.unpack('3i', self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                if uid != 0:
                    raise PackageError('Package actions require the service administrator.')
                result = {'ok': True, 'value': manager.dispatch(receive(self.rfile))}
            except (OSError, ValueError, KeyError, TypeError, PackageError, subprocess.SubprocessError) as error:
                result = {'ok': False, 'error': str(error) if isinstance(error, PackageError) else 'The package manager operation failed.'}
            self.wfile.write((json.dumps(result) + '\n').encode())
    class Server(socketserver.ThreadingUnixStreamServer):
        daemon_threads = True
    with Server(str(SOCKET), Handler) as server:
        SOCKET.chmod(0o600)
        def stop(number, frame):
            manager.stop()
            raise SystemExit(0)
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        try:
            server.serve_forever(poll_interval=0.25)
        finally:
            SOCKET.unlink(missing_ok=True)
            os.close(lock)


def client():
    request = receive(sys.stdin.buffer)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(120)
        connection.connect(str(SOCKET))
        connection.sendall((json.dumps(request) + '\n').encode())
        with connection.makefile('rb') as stream:
            print(json.dumps(receive(stream)))


if __name__ == '__main__':
    os.umask(0o077)
    try:
        if sys.argv[1:] == ['serve']:
            serve()
        elif sys.argv[1:] == ['client']:
            client()
        else:
            raise PackageError('Unknown package manager command.')
    except (OSError, ValueError, PackageError):
        print('The package manager is unavailable. Start Dev Workspace and check its logs.', file=sys.stderr)
        sys.exit(1)
