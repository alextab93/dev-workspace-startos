#!/usr/bin/python3
import json
import os
from pathlib import Path
import stat
import sys
import tempfile


def prepare_bundle(arguments):
    bundle = None
    for index, argument in enumerate(arguments):
        if argument in ('--bundle', '-b') and index + 1 < len(arguments):
            bundle = arguments[index + 1]
            break
        if argument.startswith('--bundle='):
            bundle = argument.split('=', 1)[1]
            break
    if bundle is None:
        return
    path = Path(bundle) / 'config.json'
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError('The OCI bundle configuration must be a regular file.')
    configuration = json.loads(path.read_text())
    linux = configuration.get('linux')
    sysctls = linux.get('sysctl') if isinstance(linux, dict) else None
    if not isinstance(sysctls, dict) or 'net.ipv4.ip_unprivileged_port_start' not in sysctls:
        return
    del sysctls['net.ipv4.ip_unprivileged_port_start']
    descriptor, temporary = tempfile.mkstemp(prefix='.runc-config-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as file:
            os.fchmod(file.fileno(), stat.S_IMODE(metadata.st_mode))
            os.fchown(file.fileno(), metadata.st_uid, metadata.st_gid)
            json.dump(configuration, file, separators=(',', ':'))
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def main():
    try:
        prepare_bundle(sys.argv[1:])
        os.execv('/usr/bin/runc', ['/usr/bin/runc', *sys.argv[1:]])
    except (OSError, ValueError, TypeError):
        print('The nested container runtime could not prepare its OCI configuration.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
