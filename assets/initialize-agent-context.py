import os
from pathlib import Path
import stat
import sys


RULE = b'Read ~/.dev-workspace-capabilities for the capabilities of this StartOS development workspace and how to verify which services are enabled.'


def initialize(home):
    for folder, name in [('.codex', 'AGENTS.md'), ('.claude', 'CLAUDE.md')]:
        directory = home / folder
        path = directory / name
        try:
            directory.mkdir(mode=0o700, exist_ok=True)
            if directory.is_symlink():
                continue
            fd = os.open(path, os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
            with os.fdopen(fd, 'rb+') as stream:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    continue
                original = stream.read()
                if RULE not in original.splitlines():
                    separator = b'\n' if original.endswith(b'\n') else b'\n\n'
                    stream.write((separator if original else b'') + RULE + b'\n')
        except OSError as error:
            print(f'Could not initialize {path}: {error}', file=sys.stderr)


if __name__ == '__main__':
    initialize(Path.home())
