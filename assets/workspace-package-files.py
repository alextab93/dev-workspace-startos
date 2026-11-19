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
MAX_DEPTH = 40


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


def inspect_file(filename, statistics=None):
    descriptor = open_project_file(filename)
    try:
        before = identity(os.fstat(descriptor))
        digest = hashlib.sha256()
        hashing_started = time.monotonic()
        hashed_bytes = 0
        try:
            while data := os.read(descriptor, 1024 * 1024):
                digest.update(data)
                hashed_bytes += len(data)
        finally:
            if statistics is not None:
                statistics['hashedBytes'] += hashed_bytes
                statistics['hashingSeconds'] += time.monotonic() - hashing_started
        inspection_started = time.monotonic()
        try:
            result = subprocess.run(['/usr/local/bin/start-cli', 's9pk', 'inspect', '/proc/self/fd/' + str(descriptor), 'manifest', '--format', 'json'],
                                    pass_fds=(descriptor,), stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60,
                                    cwd='/tmp', env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/tmp', 'LANG': 'C.UTF-8'})
        finally:
            if statistics is not None:
                statistics['inspectionSeconds'] += time.monotonic() - inspection_started
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
    started = time.monotonic()
    deadline = started + 3600
    truncated = False
    exhausted = False
    limits = set()
    statistics = {
        'roots': [
            {'path': str(root), 'status': 'not-scanned', 'durationSeconds': 0,
             'entriesVisited': 0, 'directoriesSkipped': 0, 'symlinksSkipped': 0,
             'otherEntriesSkipped': 0, 'candidates': 0, 'packagesFound': 0, 'errors': 0,
             'hashedBytes': 0, 'hashingSeconds': 0, 'inspectionSeconds': 0}
            for root in (ROOTS if roots is None else roots)
        ],
    }

    def report_error(root_statistics, path, message):
        root_statistics['errors'] += 1
        if len(errors) < 100:
            errors.append({'path': str(path), 'error': message[:300]})

    for root_statistics in statistics['roots']:
        if exhausted:
            break
        root = Path(root_statistics['path'])
        root_started = time.monotonic()
        root_statistics['status'] = 'complete'
        try:
            try:
                available = root.is_dir() and not root.is_symlink()
            except OSError:
                available = False
            if not available:
                root_statistics['status'] = 'unavailable'
                truncated = True
                report_error(root_statistics, root, 'Project directory is unavailable; it was not scanned.')
                continue
            stack = [(root, 0)]
            while stack:
                directory, depth = stack.pop()
                try:
                    with os.scandir(directory) as contents:
                        for entry in contents:
                            limit = ('entries' if entries >= MAX_ENTRIES else
                                     'packages' if candidates >= MAX_FILES else
                                     'time' if time.monotonic() > deadline else None)
                            if limit:
                                limits.add(limit)
                                truncated = True
                                exhausted = True
                                root_statistics['status'] = 'incomplete'
                                break
                            entries += 1
                            root_statistics['entriesVisited'] += 1
                            try:
                                if entry.is_symlink():
                                    root_statistics['symlinksSkipped'] += 1
                                elif entry.is_dir(follow_symlinks=False):
                                    if entry.name in ('.git', 'node_modules', '.venv', 'venv'):
                                        root_statistics['directoriesSkipped'] += 1
                                    elif depth >= MAX_DEPTH:
                                        limits.add('depth')
                                        truncated = True
                                        root_statistics['status'] = 'incomplete'
                                        report_error(root_statistics, entry.path, 'Directory depth limit reached; subtree was not scanned.')
                                    else:
                                        stack.append((Path(entry.path), depth + 1))
                                elif entry.name.lower().endswith('.s9pk') and entry.is_file(follow_symlinks=False):
                                    candidates += 1
                                    root_statistics['candidates'] += 1
                                    try:
                                        packages.append(inspect_file(entry.path, root_statistics))
                                        root_statistics['packagesFound'] += 1
                                    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
                                        report_error(root_statistics, entry.path, str(error))
                                else:
                                    root_statistics['otherEntriesSkipped'] += 1
                            except OSError:
                                truncated = True
                                root_statistics['status'] = 'incomplete'
                                report_error(root_statistics, entry.path, 'Directory entry could not be read.')
                except OSError:
                    truncated = True
                    root_statistics['status'] = 'incomplete'
                    report_error(root_statistics, directory, 'Directory could not be read.')
                if exhausted:
                    break
        finally:
            root_statistics['durationSeconds'] = time.monotonic() - root_started
    statistics['durationSeconds'] = time.monotonic() - started
    statistics['limitsReached'] = sorted(limits)
    return {'packages': packages, 'errors': errors, 'truncated': truncated, 'statistics': statistics}


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
