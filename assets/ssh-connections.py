#!/usr/bin/python3
import json
import os
from pathlib import Path
import pwd
import stat
import sys


PROC = Path('/proc')
PIDFILE = Path('/run/sshd/sshd.pid')
DAEMON = Path('/usr/sbin/sshd')


class ProcessGone(Exception):
    pass


def process_stat(pid):
    try:
        text = (PROC / str(pid) / 'stat').read_text()
    except (FileNotFoundError, ProcessLookupError):
        raise ProcessGone from None
    opening = text.index('(')
    closing = text.rindex(')')
    fields = text[closing + 2:].split()
    if int(text[:opening].strip()) != pid or len(fields) < 20:
        raise ValueError('Invalid process state')
    if fields[0] in ('Z', 'X', 'x'):
        raise ProcessGone
    return (pid, int(fields[1]), int(fields[19]), text[opening + 1:closing])


def process_details(identity):
    pid = identity[0]
    try:
        status = (PROC / str(pid) / 'status').read_text()
        command = (PROC / str(pid) / 'cmdline').read_bytes()
    except (FileNotFoundError, ProcessLookupError):
        raise ProcessGone from None
    if process_stat(pid) != identity:
        raise ProcessGone
    users = [line.split()[1:] for line in status.splitlines() if line.startswith('Uid:')]
    if len(users) != 1 or len(users[0]) != 4:
        raise ValueError('Invalid process owner')
    return tuple(int(value) for value in users[0]), command.rstrip(b'\0 ').decode('utf-8', 'strict')


def daemon_pid():
    directory = PIDFILE.parent.lstat()
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0 or directory.st_mode & 0o022:
        raise ValueError('Untrusted SSH state directory')
    descriptor = os.open(PIDFILE, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
            raise ValueError('Untrusted SSH PID file')
        value = os.read(descriptor, 65)
    finally:
        os.close(descriptor)
    value = value.strip()
    if not value or len(value) > 20 or not value.isdigit() or int(value) < 1:
        raise ValueError('Invalid SSH PID')
    return int(value)


def daemon_identity(pid):
    identity = process_stat(pid)
    users, command = process_details(identity)
    executable = (PROC / str(pid) / 'exe').stat()
    expected = DAEMON.stat()
    if (
        users != (0, 0, 0, 0)
        or identity[3] != 'sshd'
        or not command.startswith('sshd: /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config [listener]')
        or (executable.st_dev, executable.st_ino) != (expected.st_dev, expected.st_ino)
        or expected.st_uid != 0
        or expected.st_mode & 0o022
    ):
        raise ValueError('Untrusted SSH listener')
    if process_stat(pid) != identity:
        raise ProcessGone
    return identity


def connections():
    if os.geteuid() != 0:
        raise PermissionError('Root is required')
    user = pwd.getpwnam('dev')
    if user.pw_uid == 0:
        raise ValueError('Invalid development account')
    listener = daemon_identity(daemon_pid())
    children = {}
    for entry in PROC.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            identity = process_stat(int(entry.name))
        except ProcessGone:
            continue
        children.setdefault(identity[1], []).append(identity)
    count = 0
    for monitor in children.get(listener[0], []):
        try:
            users, command = process_details(monitor)
            if users != (0, 0, 0, 0) or monitor[3] not in ('sshd-session', 'sshd'):
                continue
            if command != monitor[3] + ': dev [priv]':
                continue
            authenticated = []
            for child in children.get(monitor[0], []):
                try:
                    child_users, child_command = process_details(child)
                    if child_users != (user.pw_uid,) * 4:
                        continue
                    prefix = monitor[3] + ': dev'
                    if child[3] != monitor[3] or not (
                        child_command == prefix or child_command.startswith(prefix + '@')
                    ):
                        raise ValueError('Unrecognized authenticated SSH process')
                    authenticated.append(child)
                except ProcessGone:
                    continue
            if len(authenticated) > 1:
                raise ValueError('Ambiguous authenticated SSH transport')
            if authenticated and process_stat(monitor[0]) == monitor and process_stat(authenticated[0][0]) == authenticated[0]:
                count += 1
        except ProcessGone:
            continue
    if daemon_pid() != listener[0] or daemon_identity(listener[0]) != listener:
        raise ValueError('SSH listener changed during observation')
    return count


def main():
    try:
        result = connections()
    except (OSError, ValueError, KeyError, ProcessGone):
        print('SSH connection count is unavailable.', file=sys.stderr)
        return 1
    print(json.dumps({'connections': result}, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
