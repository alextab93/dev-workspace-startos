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


RUNTIME = Path('/run/dev-workspace-podman')
SOCKET = RUNTIME / 'podman.sock'
STORAGE = Path('/var/lib/containers')


def prepare():
    for path in (RUNTIME, STORAGE, Path('/run/user/1000')):
        path.mkdir(parents=True, exist_ok=True)
        if path.is_symlink() or not path.is_dir():
            raise RuntimeError('Podman storage must be a directory.')
        os.chown(path, 1000, 1000)
        path.chmod(0o700)


def serve():
    if os.geteuid() != 1000:
        raise RuntimeError('The Podman engine must run as UID 1000.')
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
    process = subprocess.Popen([
        '/usr/bin/podman', '--root', str(STORAGE / 'storage'),
        '--runroot', '/run/user/1000/containers', '--cgroup-manager', 'cgroupfs',
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
