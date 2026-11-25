#!/usr/bin/python3
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone


RUNTIME = Path('/run/dev-workspace-podman')
SOCKET = RUNTIME / 'podman.sock'
STORAGE = Path('/var/lib/containers')
USER_RUNTIME = Path('/run/user/1000')


def prepare():
    for path in (RUNTIME, STORAGE, USER_RUNTIME):
        path.mkdir(parents=True, exist_ok=True)
        if path.is_symlink() or not path.is_dir():
            raise RuntimeError('Podman storage must be a directory.')
        os.chown(path, 1000, 1000)
        path.chmod(0o700)


def enter_engine_namespace():
    if os.geteuid() != 0:
        raise RuntimeError('The engine launcher requires root to prepare its isolated ID mapping.')
    ready_read, ready_write = os.pipe2(os.O_CLOEXEC)
    release_read, release_write = os.pipe2(os.O_CLOEXEC)
    try:
        child = os.fork()
    except OSError:
        for descriptor in (ready_read, ready_write, release_read, release_write):
            os.close(descriptor)
        raise
    if child == 0:
        try:
            os.close(ready_read)
            os.close(release_write)
            os.unshare(os.CLONE_NEWUSER)
            os.write(ready_write, b'1')
            os.close(ready_write)
            os.read(release_read, 1)
            os._exit(0)
        except OSError as error:
            print('Cannot create the engine user namespace: ' + str(error), file=sys.stderr, flush=True)
            os._exit(1)
    os.close(ready_write)
    os.close(release_read)
    namespace = None
    try:
        if os.read(ready_read, 1) != b'1':
            raise RuntimeError('The engine user namespace could not be created.')
        process = Path('/proc') / str(child)
        mapping = '0 0 1\n1000 1000 64536\n65537 1 999\n'
        for name in ('uid_map', 'gid_map'):
            (process / name).write_text(mapping)
        namespace = os.open(process / 'ns/user', os.O_RDONLY | os.O_CLOEXEC)
    finally:
        os.close(ready_read)
        os.close(release_write)
        os.waitpid(child, 0)
    try:
        os.setns(namespace, os.CLONE_NEWUSER)
    finally:
        os.close(namespace)
    os.unshare(os.CLONE_NEWNS)
    subprocess.run(['mount', '--make-rprivate', '/'], check=True, timeout=10)
    with tempfile.TemporaryDirectory(prefix='workspace-podman-ids-', dir='/run') as temporary:
        for name in ('subuid', 'subgid'):
            source = Path(temporary) / name
            source.write_text('dev:1001:64535\ndev:65537:999\n')
            source.chmod(0o644)
            subprocess.run(['mount', '--bind', str(source), '/etc/' + name], check=True, timeout=10)
            subprocess.run(['mount', '-o', 'remount,bind,ro', '/etc/' + name], check=True, timeout=10)
    subprocess.run([
        'mount', '-t', 'tmpfs', '-o', 'mode=0700,uid=1000,gid=1000,nosuid,nodev,size=256m',
        'workspace-podman-runtime', str(USER_RUNTIME),
    ], check=True, timeout=10)
    subprocess.run([
        'mount', '-t', 'tmpfs', '-o', 'mode=1777,nosuid,nodev,size=64m',
        'workspace-podman-locks', '/dev/shm',
    ], check=True, timeout=10)
    os.setgroups([])
    os.setresgid(1000, 1000, 1000)
    os.setresuid(1000, 1000, 1000)


def serve(weekly, hours):
    enter_engine_namespace()
    os.umask(0o077)
    lock = os.open(RUNTIME / 'engine.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        metadata = SOCKET.lstat()
        if not stat.S_ISSOCK(metadata.st_mode) or metadata.st_uid != 1000:
            raise RuntimeError('Unexpected Podman socket path.')
        SOCKET.unlink()
    except FileNotFoundError:
        pass
    environment = os.environ.copy()
    environment.pop('CONTAINER_HOST', None)
    environment.pop('DOCKER_HOST', None)
    environment['XDG_RUNTIME_DIR'] = str(USER_RUNTIME)
    process = subprocess.Popen([
        '/usr/bin/podman', '--root', str(STORAGE / 'storage'),
        '--runroot', str(USER_RUNTIME / 'containers'), '--cgroup-manager', 'cgroupfs',
        '--storage-driver', 'overlay', '--storage-opt', 'overlay.mount_program=/usr/bin/fuse-overlayfs',
        'system', 'service', '--time', '0', 'unix://' + str(SOCKET),
    ], env=environment)
    if weekly:
        threading.Thread(target=schedule_cleanup, args=(hours,), daemon=True).start()
    def forward(signum, frame):
        if process.poll() is None:
            try:
                remote('stop', '--all', '--time', '20', timeout=90)
            except (OSError, RuntimeError, subprocess.SubprocessError):
                pass
            process.send_signal(signum)
    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    try:
        return process.wait()
    finally:
        SOCKET.unlink(missing_ok=True)
        os.close(lock)


def remote(*arguments, timeout=180):
    result = subprocess.run(['/usr/bin/podman', '--remote', '--url', 'unix://' + str(SOCKET), *arguments],
                            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('The Podman operation failed. Check the service logs and engine status.')
    return result.stdout.strip()


def filesystem_available():
    try:
        fs = os.statvfs(STORAGE)
        return fs.f_bavail * fs.f_frsize
    except OSError:
        return None


def policy_preview(hours):
    images = json.loads(remote('images', '--all', '--filter', 'until=' + str(hours) + 'h', '--format', 'json'))
    unused = {image['Id']: image['Size'] for image in images if image['Containers'] == 0}
    return (f'{len(unused)} old image IDs appear unused, up to {sum(unused.values())} image bytes. '
            'Shared layers can reduce the space freed.')


def container_logs():
    ids = remote('ps', '--all', '--quiet').splitlines()
    allocated = 0
    for offset in range(0, len(ids), 100):
        paths = remote('container', 'inspect', '--format', '{{.HostConfig.LogConfig.Path}}', *ids[offset:offset + 100])
        for raw in paths.split('\n'):
            path = Path(raw)
            if not path.resolve().is_relative_to(STORAGE) or path.name != 'ctr.log':
                return 'measurement unavailable'
            try:
                allocated += path.stat().st_blocks * 512
            except FileNotFoundError:
                continue
    return str(allocated) + ' allocated bytes in current Podman log files'


def cache_usage():
    try:
        usage = subprocess.check_output(['/usr/bin/du', '-skx', '/var/lib/dev-workspace/nextcloud-cache'],
                                        text=True, stderr=subprocess.DEVNULL, timeout=30)
        return str(int(usage.split()[0]) * 1024) + ' allocated bytes'
    except (OSError, ValueError, subprocess.SubprocessError):
        return 'measurement unavailable'


WEEK = 7 * 24 * 3600
SCHEDULE = RUNTIME / 'weekly-cleanup.json'


def read_schedule():
    data = json.loads(SCHEDULE.read_text())
    if type(data['next']) is not int or not 0 < data['next'] <= 253402300799:
        raise ValueError('Invalid weekly cleanup time.')
    if data['result'] not in ('waiting', 'running', 'failed', 'completed'):
        raise ValueError('Invalid weekly cleanup result.')
    return data


def save_schedule(due, result):
    with tempfile.NamedTemporaryFile(dir=RUNTIME, mode='w', delete=False) as tmp:
        try:
            json.dump({'next': due, 'result': result}, tmp)
            tmp.flush()
            os.fsync(tmp.fileno())
            os.replace(tmp.name, SCHEDULE)
        finally:
            Path(tmp.name).unlink(missing_ok=True)


def schedule_cleanup(hours):
    while True:
        try:
            now = int(time.time())
            try:
                due = read_schedule()['next']
            except FileNotFoundError:
                due = now + WEEK
                save_schedule(due, 'waiting')
            if due <= now:
                if not SOCKET.is_socket():
                    time.sleep(5)
                    continue
                save_schedule(now + 3600, 'running')
                try:
                    clean(hours)
                except (OSError, RuntimeError, subprocess.SubprocessError):
                    save_schedule(int(time.time()) + 3600, 'failed')
                    raise
                due = int(time.time()) + WEEK
                save_schedule(due, 'completed')
            time.sleep(max(1, min(3600, due - int(time.time()))))
        except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError) as error:
            print('Weekly cleanup needs attention: ' + str(error), file=sys.stderr, flush=True)
            time.sleep(3600)


def schedule_status(weekly):
    if not weekly:
        return 'Weekly cleanup is off. Clean Containers is available on demand.'
    try:
        data = read_schedule()
        due = datetime.fromtimestamp(data['next'], timezone.utc).isoformat()
        return f"Weekly cleanup: {data['result']}. Next attempt: {due}."
    except (OSError, ValueError, TypeError, KeyError, OverflowError):
        return 'Weekly cleanup is enabled. Schedule unavailable.'


def storage_report(hours, warn_below_gib, weekly=False):
    cache = cache_usage()
    if os.geteuid() == 0:
        os.setgroups([])
        os.setresgid(1000, 1000, 1000)
        os.setresuid(1000, 1000, 1000)
        os.environ['HOME'] = '/home/dev'
        os.environ['XDG_RUNTIME_DIR'] = str(USER_RUNTIME)
    info = json.loads(remote('info', '--format', 'json'))
    try:
        estimate = policy_preview(hours)
    except (OSError, ValueError, TypeError, KeyError, RuntimeError, subprocess.SubprocessError):
        estimate = 'Eligible image count unavailable.'
    try:
        logs = container_logs()
    except (OSError, RuntimeError, subprocess.SubprocessError):
        logs = 'measurement unavailable'
    available = filesystem_available()
    capacity = 'Storage filesystem availability unknown.' if available is None else f'Storage filesystem: {available} bytes available.'
    if warn_below_gib:
        capacity += f' Warning threshold: {warn_below_gib} GiB.'
        if available is not None and available < warn_below_gib * 1024 ** 3:
            capacity += ' Below threshold. Review Clean Containers or increase storage.'
    try:
        rows = json.loads(remote('system', 'df', '--format', 'json'))
        by_type = {row['Type']: row for row in rows}
    except (OSError, KeyError, TypeError, ValueError, RuntimeError, subprocess.SubprocessError):
        by_type = {}
    categories = []
    for name in dict.fromkeys(['Images', 'Containers', 'Local Volumes', *by_type]):
        row = by_type.get(name, {})
        values = []
        for field in ('Total', 'Active', 'Size', 'Reclaimable'):
            value = row.get(field)
            values.append(f"{field}: {value if value is not None and value != '' else 'Unavailable'}")
        categories.append({'name': name, 'value': '\n'.join(values)})
    notes = [f'Cleanup age: {hours} hours. ' + estimate,
             'Build layers are included in images. A separate size is unavailable.',
             'Container logs: ' + logs + '. Logs and named volumes are retained.',
             'Nextcloud private cache: ' + cache + '. Excluded from cleanup.', capacity, schedule_status(weekly)]
    return {
        'version': str(info['version']['Version']),
        'rootless': info['host']['security']['rootless'] is True,
        'driver': str(info['store']['graphDriverName']),
        'categories': categories,
        'notes': notes,
        'usage': '\n'.join([entry['name'] + '\n' + entry['value'] for entry in categories] + notes),
    }


def clean(hours):
    if type(hours) is not int or not 24 <= hours <= 8760:
        raise ValueError('Cleanup age must be between 24 and 8760 hours.')
    before = filesystem_available()
    with (RUNTIME / 'cleanup.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        output = remote('image', 'prune', '--all', '--force', '--filter', 'until=' + str(hours) + 'h', timeout=600)
    after = filesystem_available()
    change = ('Filesystem available bytes changed by ' + str(after - before) + ' during cleanup. Other writes affect this measurement.'
              if before is not None and after is not None else 'Filesystem change unavailable.')
    return {'olderThanHours': hours, 'output': (output or 'No unused images matched the cleanup age.') + '\n' + change}


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='operation', required=True)
    sub.add_parser('prepare')
    engine = sub.add_parser('serve')
    engine.add_argument('--weekly', action='store_true')
    engine.add_argument('--older-than-hours', type=int, default=168)
    status = sub.add_parser('status')
    status.add_argument('--weekly', action='store_true')
    status.add_argument('--warn-below-gib', type=int, default=0)
    status.add_argument('--older-than-hours', type=int, default=168)
    sub.add_parser('clean').add_argument('--older-than-hours', type=int, required=True)
    args = parser.parse_args()
    try:
        if args.operation == 'serve':
            return serve(args.weekly, args.older_than_hours)
        result = prepare() if args.operation == 'prepare' else storage_report(args.older_than_hours, args.warn_below_gib, args.weekly) if args.operation == 'status' else clean(args.older_than_hours)
        print(json.dumps(result))
        return 0
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
