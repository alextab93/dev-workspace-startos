#!/usr/bin/python3
import argparse
from datetime import datetime, timezone
import fcntl
import grp
import http.client
import json
import os
from pathlib import Path
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlencode


RUNTIME = Path('/run/dev-workspace-docker')
ENGINE_STATE = Path('/run/dev-workspace-engine')
SOCKET = RUNTIME / 'docker.sock'
STORAGE = Path('/var/lib/docker')
API_VERSION = (1, 48)
MAX_RESPONSE_BYTES = 16 * 1024 * 1024


class DockerError(Exception):
    pass


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, socket_path, timeout):
        super().__init__('localhost', timeout=timeout)
        self.socket_path = str(socket_path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.socket_path)


def request(socket_path, method, path, timeout=30):
    connection = UnixConnection(socket_path, timeout)
    try:
        connection.request(method, path, headers={'Accept': 'application/json'})
        response = connection.getresponse()
        if response.status != 200:
            raise DockerError('Docker engine request failed (HTTP ' + str(response.status) + ').')
        body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            raise DockerError('Docker engine response exceeds the supported size.')
        result = json.loads(body)
        if not isinstance(result, dict):
            raise DockerError('Docker engine returned an invalid response.')
        return result
    except (OSError, http.client.HTTPException):
        raise DockerError('The workspace Docker engine is unavailable.') from None
    except (ValueError, UnicodeError):
        raise DockerError('Docker engine returned an invalid response.') from None
    finally:
        connection.close()


def api(socket_path):
    version = request(socket_path, 'GET', '/version')
    try:
        maximum = tuple(int(part) for part in version['ApiVersion'].split('.'))
        minimum = tuple(int(part) for part in version.get('MinAPIVersion', '1.24').split('.'))
        if len(maximum) != 2 or len(minimum) != 2 or maximum < (1, 42) or minimum > API_VERSION:
            raise ValueError
        selected = min(maximum, API_VERSION)
        return '/v' + '.'.join(str(part) for part in selected), version
    except (KeyError, TypeError, ValueError, AttributeError):
        raise DockerError('The workspace Docker engine API version is unsupported.') from None


def integer(value, default=0):
    return value if type(value) is int and value >= 0 else default


def records(value):
    return [entry for entry in value if isinstance(entry, dict)] if isinstance(value, list) else []


def filesystem_report(runtime):
    try:
        path = runtime / 'storage.json'
        flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
        with os.fdopen(os.open(path, flags)) as file:
            metadata = os.fstat(file.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
                return None
            report = json.loads(file.read(4096))
        observed = datetime.fromisoformat(report['observedAt'])
        age = (datetime.now(timezone.utc) - observed).total_seconds()
        if not 0 <= age <= 60:
            return None
        if any(type(report.get(key)) is not int or report[key] < 0 for key in ('totalBytes', 'availableBytes', 'usedBytes')):
            return None
        return {key: report[key] for key in ('totalBytes', 'availableBytes', 'usedBytes', 'observedAt')}
    except (OSError, ValueError, KeyError, TypeError):
        return None


def storage_report(socket_path=SOCKET, runtime=RUNTIME):
    report = {
        'available': False,
        'engine': None,
        'filesystem': filesystem_report(runtime),
        'usage': None,
        'buildCache': {'scope': 'default-builder-only'},
        'error': None,
    }
    try:
        prefix, version = api(socket_path)
        info = request(socket_path, 'GET', prefix + '/info')
        usage = request(socket_path, 'GET', prefix + '/system/df', timeout=120)
        caches = records(usage.get('BuildCache'))
        volumes = records(usage.get('Volumes'))
        volume_usage = [entry['UsageData'] if isinstance(entry.get('UsageData'), dict) else {} for entry in volumes]
        report['engine'] = {
            'version': str(version.get('Version', 'unknown')),
            'apiVersion': prefix[2:],
            'storageDriver': str(info.get('Driver', 'unknown')),
            'cgroupDriver': str(info.get('CgroupDriver', 'unknown')),
            'cgroupVersion': str(info.get('CgroupVersion', 'unknown')),
            'containers': integer(info.get('Containers')),
            'runningContainers': integer(info.get('ContainersRunning')),
            'images': integer(info.get('Images')),
        }
        report['usage'] = {
            'imagesBytes': integer(usage.get('LayersSize')),
            'containerWritableBytes': sum(integer(entry.get('SizeRw')) for entry in records(usage.get('Containers'))),
            'volumesBytes': sum(integer(entry.get('Size')) for entry in volume_usage),
            'volumeSizesComplete': all(type(entry.get('Size')) is int and entry['Size'] >= 0 for entry in volume_usage),
            'volumeCount': len(volumes),
            'buildCacheBytes': sum(integer(entry.get('Size')) for entry in caches),
            'buildCacheReclaimableBytes': sum(integer(entry.get('Size')) for entry in caches if entry.get('InUse') is False),
        }
        report['available'] = True
    except DockerError as error:
        report['error'] = str(error)
    return report


def bounded_integer(value, minimum, maximum, name):
    if type(value) is not int or not minimum <= value <= maximum:
        raise DockerError(name + ' must be an integer from ' + str(minimum) + ' to ' + str(maximum) + '.')
    return value


def clean(target, older_than_hours, socket_path=SOCKET):
    bounded_integer(older_than_hours, 24, 8760, 'Cleanup age')
    if target not in ('cache', 'images'):
        raise DockerError('Cleanup target must be cache or images.')
    prefix, _ = api(socket_path)
    filters = {'until': [str(older_than_hours) + 'h']}
    if target == 'images':
        filters['dangling'] = ['false']
        route = '/images/prune'
        parameters = {'filters': json.dumps(filters, separators=(',', ':'))}
    else:
        route = '/build/prune'
        parameters = {'filters': json.dumps(filters, separators=(',', ':')), 'all': 'true'}
    result = request(socket_path, 'POST', prefix + route + '?' + urlencode(parameters), timeout=300)
    deleted = result.get('CachesDeleted' if target == 'cache' else 'ImagesDeleted') or []
    if not isinstance(deleted, list):
        raise DockerError('Docker engine returned an invalid cleanup result.')
    if target == 'images':
        count = len({entry['Deleted'] for entry in deleted if isinstance(entry, dict) and isinstance(entry.get('Deleted'), str)})
    else:
        count = len(deleted)
    return {
        'target': target,
        'olderThanHours': older_than_hours,
        'reclaimedBytes': integer(result.get('SpaceReclaimed')),
        'deletedCount': count,
    }


def atomic_json(path, value, mode=0o640):
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as file:
            os.fchmod(file.fileno(), mode)
            json.dump(value, file, separators=(',', ':'))
            file.write('\n')
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def write_filesystem_report(storage, runtime):
    filesystem = os.statvfs(storage)
    atomic_json(runtime / 'storage.json', {
        'totalBytes': filesystem.f_blocks * filesystem.f_frsize,
        'availableBytes': filesystem.f_bavail * filesystem.f_frsize,
        'usedBytes': (filesystem.f_blocks - filesystem.f_bfree) * filesystem.f_frsize,
        'observedAt': datetime.now(timezone.utc).isoformat(),
    }, mode=0o644)


def daemon_configuration(cache_budget_gib):
    bounded_integer(cache_budget_gib, 1, 1000, 'Build cache budget')
    return {
        'hosts': ['unix://' + str(SOCKET)],
        'group': 'dev',
        'data-root': str(STORAGE),
        'exec-root': str(ENGINE_STATE / 'exec'),
        'pidfile': str(ENGINE_STATE / 'docker.pid'),
        'storage-driver': 'fuse-overlayfs',
        'features': {'containerd-snapshotter': False},
        'default-runtime': 'runc-nested',
        'runtimes': {'runc-nested': {'path': '/usr/local/bin/runc-nested'}},
        'builder': {'gc': {'enabled': True, 'defaultKeepStorage': str(cache_budget_gib * 1024 ** 3)}},
        'log-driver': 'local',
        'log-opts': {'max-size': '10m', 'max-file': '3'},
        'shutdown-timeout': 20,
        'live-restore': False,
    }


def prepare_runtime():
    if os.geteuid() != 0:
        raise DockerError('The workspace Docker engine must start as root inside its dedicated container.')
    for path in (RUNTIME, STORAGE, ENGINE_STATE):
        path.mkdir(mode=0o750, parents=True, exist_ok=True)
        metadata = path.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0:
            raise DockerError('The workspace Docker storage directory is unsafe.')
    os.chown(RUNTIME, 0, grp.getgrnam('dev').gr_gid)
    RUNTIME.chmod(0o750)


def remove_stale_runtime(runtime, engine_state):
    pidfile = engine_state / 'docker.pid'
    try:
        pid = pidfile.read_text().strip()
        if pid.isdigit() and (Path('/proc') / pid / 'comm').read_text().strip() == 'dockerd':
            raise DockerError('A workspace Docker engine is already running. Stop and restart the service.')
    except (FileNotFoundError, ProcessLookupError):
        pass
    for path in (runtime / 'docker.sock', runtime / 'storage.json', pidfile):
        try:
            if path.is_dir() and not path.is_symlink():
                raise DockerError('The workspace Docker runtime contains an unexpected directory.')
            path.unlink()
        except FileNotFoundError:
            pass


def serve(cache_budget_gib):
    configuration = daemon_configuration(cache_budget_gib)
    prepare_runtime()
    descriptor = os.open(RUNTIME / 'engine.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    metadata = os.fstat(descriptor)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
        os.close(descriptor)
        raise DockerError('The workspace Docker engine lock is unsafe.')
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(descriptor)
        raise DockerError('A workspace Docker engine is already running.') from None
    try:
        return serve_locked(configuration, descriptor)
    finally:
        os.close(descriptor)


def serve_locked(configuration, lock_descriptor):
    remove_stale_runtime(RUNTIME, ENGINE_STATE)
    config_path = ENGINE_STATE / 'daemon.json'
    atomic_json(config_path, configuration)
    write_filesystem_report(STORAGE, RUNTIME)
    environment = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}
    daemon = subprocess.Popen(['/usr/bin/dockerd', '--config-file', str(config_path)], env=environment, pass_fds=(lock_descriptor,))
    stopping = None

    def forward(signum, frame):
        nonlocal stopping
        if stopping is None:
            stopping = time.monotonic()
        if daemon.poll() is None:
            daemon.send_signal(signum)

    previous = {signum: signal.signal(signum, forward) for signum in (signal.SIGTERM, signal.SIGINT)}
    try:
        updated = time.monotonic()
        while daemon.poll() is None:
            if stopping is not None and time.monotonic() - stopping > 45:
                daemon.kill()
            if time.monotonic() - updated >= 15:
                try:
                    write_filesystem_report(STORAGE, RUNTIME)
                except OSError:
                    pass
                updated = time.monotonic()
            try:
                daemon.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
        return daemon.returncode if daemon.returncode >= 0 else 128 - daemon.returncode
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)
        if daemon.poll() is None:
            daemon.terminate()
            try:
                daemon.wait(timeout=30)
            except subprocess.TimeoutExpired:
                daemon.kill()
                daemon.wait()
        try:
            (RUNTIME / 'storage.json').unlink()
        except FileNotFoundError:
            pass


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    engine = commands.add_parser('serve')
    engine.add_argument('--cache-budget-gib', type=int, default=10)
    commands.add_parser('status')
    cleanup = commands.add_parser('clean')
    cleanup.add_argument('--target', choices=('cache', 'images'), required=True)
    cleanup.add_argument('--older-than-hours', type=int, required=True)
    arguments = parser.parse_args()
    try:
        if arguments.command == 'serve':
            return serve(arguments.cache_budget_gib)
        result = storage_report() if arguments.command == 'status' else clean(arguments.target, arguments.older_than_hours)
        print(json.dumps(result, separators=(',', ':')))
        return 0
    except DockerError as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        return 1
    except (OSError, KeyError):
        print(json.dumps({'error': 'The workspace Docker operation could not complete.'}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
