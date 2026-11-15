#!/usr/bin/python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time


ROOTS = ('/projects-shared', '/home/dev/projects')
MAX_SIZE = 32 * 1024 ** 3
MAX_FILES = 2000
MAX_ENTRIES = 200000


def open_project_file(filename):
    path = Path(filename)
    root = next((Path(root) for root in ROOTS if path.is_relative_to(root)), None)
    if root is None or '..' in path.parts:
        raise ValueError('The package must be inside a project directory.')
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        parts = path.relative_to(root).parts
        if not parts:
            raise ValueError('Select a package file.')
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        file = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
    finally:
        os.close(descriptor)
    metadata = os.fstat(file)
    if not stat.S_ISREG(metadata.st_mode) or not 0 < metadata.st_size <= MAX_SIZE:
        os.close(file)
        raise ValueError('The package must be a regular file between 1 byte and 32 GiB.')
    return file


def identity(metadata):
    return [metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns]


def inspect_file(filename):
    descriptor = open_project_file(filename)
    try:
        before = identity(os.fstat(descriptor))
        digest = hashlib.sha256()
        while data := os.read(descriptor, 1024 * 1024):
            digest.update(data)
        result = subprocess.run(['/usr/local/bin/start-cli', 's9pk', 'inspect', '/proc/self/fd/' + str(descriptor), 'manifest', '--format', 'json'],
                                pass_fds=(descriptor,), stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60,
                                cwd='/tmp', env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/tmp', 'LANG': 'C.UTF-8'})
        if result.returncode or len(result.stdout) > 2 * 1024 * 1024:
            raise ValueError('Invalid or unreadable S9PK manifest.')
        manifest = json.loads(result.stdout)
        architectures = manifest['hardwareRequirements']['arch']
        if not isinstance(architectures, list) or not architectures or any(value not in ('x86_64', 'aarch64', 'riscv64') for value in architectures):
            raise ValueError('The package architecture is unsupported.')
        for key in ('id', 'version', 'title'):
            if not isinstance(manifest[key], str) or not manifest[key] or len(manifest[key]) > 256 or any(ord(c) < 32 for c in manifest[key]):
                raise ValueError('The package metadata is invalid.')
        if identity(os.fstat(descriptor)) != before:
            raise ValueError('The file changed while being scanned. Scan again after the build or upload completes.')
        return {'path': filename, 'id': manifest['id'], 'version': manifest['version'], 'title': manifest['title'],
                'architectures': architectures, 'size': before[2], 'sha256': digest.hexdigest(), 'identity': before}
    finally:
        os.close(descriptor)


def scan(roots=None):
    packages, errors = [], []
    entries, candidates = 0, 0
    deadline = time.monotonic() + 3600
    truncated = False
    for root in ROOTS if roots is None else roots:
        if not Path(root).exists():
            continue
        stack = [Path(root)]
        while stack:
            directory = stack.pop()
            try:
                with os.scandir(directory) as contents:
                    for entry in contents:
                        entries += 1
                        if entries > MAX_ENTRIES or candidates >= MAX_FILES or time.monotonic() > deadline:
                            truncated = True
                            break
                        if entry.is_dir(follow_symlinks=False):
                            if entry.name not in ('.git', 'node_modules', '.venv', 'venv') and len(Path(entry.path).parts) < 40:
                                stack.append(Path(entry.path))
                        elif entry.name.lower().endswith('.s9pk') and entry.is_file(follow_symlinks=False):
                            candidates += 1
                            try:
                                packages.append(inspect_file(entry.path))
                            except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
                                errors.append({'path': entry.path, 'error': str(error)[:300]})
            except OSError:
                errors.append({'path': str(directory), 'error': 'Directory could not be read.'})
            if truncated:
                break
        if truncated:
            break
    return {'packages': packages, 'errors': errors[:100], 'truncated': truncated}


def stream(filename):
    descriptor = open_project_file(filename)
    try:
        before = identity(os.fstat(descriptor))
        remaining = before[2]
        while remaining and (data := os.read(descriptor, min(remaining, 1024 * 1024))):
            sys.stdout.buffer.write(data)
            remaining -= len(data)
        sys.stdout.buffer.flush()
        if identity(os.fstat(descriptor)) != before:
            raise ValueError('The package changed while being copied.')
    finally:
        os.close(descriptor)


if __name__ == '__main__':
    try:
        parser = argparse.ArgumentParser()
        commands = parser.add_subparsers(dest='operation', required=True)
        commands.add_parser('scan').add_argument('--scope', choices=('both', 'local', 'shared'), default='both')
        commands.add_parser('stream').add_argument('path')
        args = parser.parse_args()
        if args.operation == 'scan':
            roots = ROOTS if args.scope == 'both' else (ROOTS[1],) if args.scope == 'local' else (ROOTS[0],)
            print(json.dumps(scan(roots)))
        else:
            stream(args.path)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print('The project package could not be read safely.', file=sys.stderr)
        sys.exit(1)
