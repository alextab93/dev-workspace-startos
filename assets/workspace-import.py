#!/usr/bin/python3
import argparse
import contextlib
import ctypes
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile


SHARED = Path('/projects-shared')
LOCAL = Path('/home/dev/projects')
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


@contextlib.contextmanager
def open_directory(root, relative):
    if relative.is_absolute() or '..' in relative.parts:
        raise ValueError('Choose a directory inside the shared folder.')
    fd = os.open(root, DIRECTORY)
    try:
        for component in relative.parts:
            child = os.open(component, DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def restore_git_modes(repository, index, git_dir):
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(git_dir), 'GIT_CONFIG_NOSYSTEM': '1',
           'GIT_DIR': str(git_dir), 'GIT_INDEX_FILE': str(index)}
    entries = subprocess.check_output(['git', 'ls-files', '--stage', '-z'], env=env)
    for entry in entries.split(b'\0'):
        if not entry:
            continue
        metadata, name = entry.split(b'\t', 1)
        mode, _, stage = metadata.split()
        if stage != b'0':
            raise ValueError('Resolve the Git index conflict before importing from Nextcloud.')
        if mode not in (b'120000', b'100755', b'100644'):
            continue
        path = Path(os.fsdecode(name))
        if path.is_absolute() or '..' in path.parts or '.git' in path.parts:
            raise ValueError('Invalid path in the Git index.')
        try:
            with open_directory(repository, path.parent) as parent:
                info = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode):
                    continue
                descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
                with os.fdopen(descriptor, 'rb') as file:
                    if mode == b'120000':
                        target = file.read(4097)
                        if not target or len(target) > 4095 or b'\0' in target:
                            raise ValueError('Invalid Git symlink target on the shared source.')
                        os.unlink(path.name, dir_fd=parent)
                        os.symlink(target, os.fsencode(path.name), dir_fd=parent)
                    else:
                        permissions = stat.S_IMODE(info.st_mode) & 0o666
                        if mode == b'100755':
                            permissions |= (permissions & 0o444) >> 2
                        os.fchmod(file.fileno(), permissions)
        except FileNotFoundError:
            continue
        except NotADirectoryError:
            continue


def restore_repositories(tree):
    with tempfile.TemporaryDirectory() as temporary:
        bare = Path(temporary) / 'reader.git'
        subprocess.run(['git', 'init', '--quiet', '--bare', '--template=', str(bare)], check=True)
        for directory, children, files in os.walk(tree):
            if '.git' in files:
                raise ValueError('A linked Git worktree needs its own independent checkout before import.')
            if '.git' in children:
                children.remove('.git')
                repository = Path(directory)
                metadata = repository / '.git'
                if metadata.is_symlink():
                    raise ValueError('Cannot import external Git metadata.')
                index = metadata / 'index'
                if index.is_symlink():
                    raise ValueError('Cannot import an external Git index.')
                if index.is_file():
                    restore_git_modes(repository, index, bare)


def import_project(provider, source, name, shared=SHARED, local=LOCAL, progress=None):
    if name in ('', '.', '..') or name.startswith('.') or '/' in name or '\0' in name:
        raise ValueError('Enter a new project folder name without a path.')
    target = local / name
    if os.path.lexists(target):
        raise FileExistsError('The local project already exists.')
    with open_directory(shared, Path(source)) as origin, tempfile.TemporaryDirectory(prefix='.workspace-import-', dir=local) as temporary:
        stage = Path(temporary) / 'project'
        stage.mkdir()
        locations = [f'/proc/self/fd/{origin}/', str(stage) + '/']
        options = ['rsync', '--recursive', '--links', '--perms', '--times', '--hard-links', '--no-devices']
        if progress:
            progress('copy')
        copied = subprocess.run(options + ['--', *locations], pass_fds=(origin,), check=True, stdout=subprocess.PIPE)
        if copied.stdout:
            raise ValueError('The shared folder contains entries that could not be copied.')
        if progress:
            progress('verify')
        changes = subprocess.check_output(options + ['--dry-run', '--checksum', '--itemize-changes', '--delete',
                                                     '--', *locations], pass_fds=(origin,))
        if changes:
            raise ValueError('The source changed or a file failed verification. Retry with the project idle.')
        if provider == 'nextcloud':
            if progress:
                progress('git')
            restore_repositories(stage)
        rename = ctypes.CDLL(None, use_errno=True).renameat2
        if rename(-100, os.fsencode(stage), -100, os.fsencode(target), 1) != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
        return {'path': str(target)}


def interrupt(signum, frame):
    raise InterruptedError('Import interrupted.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('provider', choices=['filebrowser', 'nextcloud'])
    parser.add_argument('source')
    parser.add_argument('destination')
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, interrupt)
    try:
        print(json.dumps(import_project(args.provider, args.source, args.destination, progress=lambda phase: print(phase, flush=True))))
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
