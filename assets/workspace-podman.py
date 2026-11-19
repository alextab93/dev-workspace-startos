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


def serve():
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


def storage_report():
    info = json.loads(remote('info', '--format', 'json'))
    return {
        'version': str(info['version']['Version']),
        'rootless': info['host']['security']['rootless'] is True,
        'driver': str(info['store']['graphDriverName']),
        'usage': remote('system', 'df'),
    }


def clean(hours):
    if type(hours) is not int or not 24 <= hours <= 8760:
        raise ValueError('Cleanup age must be between 24 and 8760 hours.')
    output = remote('image', 'prune', '--all', '--force', '--filter', 'until=' + str(hours) + 'h', timeout=600)
    return {'olderThanHours': hours, 'output': output or 'No unused images matched the cleanup age.'}


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='operation', required=True)
    for name in ('prepare', 'serve', 'status'):
        sub.add_parser(name)
    sub.add_parser('clean').add_argument('--older-than-hours', type=int, required=True)
    args = parser.parse_args()
    try:
        if args.operation == 'serve':
            return serve()
        result = prepare() if args.operation == 'prepare' else storage_report() if args.operation == 'status' else clean(args.older_than_hours)
        print(json.dumps(result))
        return 0
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
