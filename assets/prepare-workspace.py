#!/usr/bin/python3
import fcntl
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile


def directory(path, mode, owner=None):
    try:
        path.mkdir(mode=mode)
    except FileExistsError:
        if path.is_symlink() or not path.is_dir():
            raise RuntimeError(f"Expected a directory at {path}")
    else:
        if owner is not None:
            os.chown(path, *owner, follow_symlinks=False)


def prepare():
    os.umask(0o077)
    home = Path('/home/dev')
    keys = Path('/var/lib/dev-workspace/ssh')
    directory(home, 0o750, (1000, 1000))
    if home.stat().st_uid == 0:
        os.chown(home, 1000, 1000, follow_symlinks=False)
        home.chmod(0o750)
    if home.stat().st_uid != 1000:
        raise RuntimeError('Workspace home must belong to development user UID 1000')
    directory(keys, 0o755)
    os.chown(keys, 0, 0, follow_symlinks=False)
    keys.chmod(0o755)
    directory(Path('/run/sshd'), 0o755)
    with open(keys / '.init.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        directory(home / 'projects', 0o750, (1000, 1000))
        agents = home / '.agents'
        if not os.path.lexists(agents) or (agents.is_dir() and not agents.is_symlink()):
            directory(agents, 0o700, (1000, 1000))
            skills = agents / 'skills'
            if not os.path.lexists(skills) or (skills.is_dir() and not skills.is_symlink()):
                directory(skills, 0o700, (1000, 1000))
                skill = skills / 'startos-server'
                if not os.path.lexists(skill):
                    skill.symlink_to('/usr/local/share/dev-workspace/skills/startos-server', target_is_directory=True)
                    os.lchown(skill, 1000, 1000)
        for source in Path('/usr/local/share/dev-workspace/home-defaults').iterdir():
            destination = home / source.name
            if os.path.lexists(destination):
                continue
            fd, temporary = tempfile.mkstemp(prefix='.workspace-default-', dir=home)
            try:
                with os.fdopen(fd, 'wb') as output, source.open('rb') as input_file:
                    shutil.copyfileobj(input_file, output)
                    os.fchown(output.fileno(), 1000, 1000)
                    output.flush()
                    os.fsync(output.fileno())
                try:
                    os.link(temporary, destination, follow_symlinks=False)
                except FileExistsError:
                    pass
            finally:
                Path(temporary).unlink(missing_ok=True)
        host_key = keys / 'ssh_host_ed25519_key'
        if host_key.is_symlink():
            raise RuntimeError('SSH host key must not be a symbolic link')
        if not host_key.exists():
            with tempfile.TemporaryDirectory(prefix='.host-key-', dir=keys) as temporary:
                candidate = Path(temporary) / 'key'
                subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(candidate)], check=True)
                os.replace(candidate, host_key)
                os.replace(candidate.with_suffix('.pub'), host_key.with_suffix('.pub'))
        if not stat.S_ISREG(host_key.stat().st_mode):
            raise RuntimeError('SSH host key must be a regular file')
        os.chown(host_key, 0, 0, follow_symlinks=False)
        host_key.chmod(0o600)
        public_key = subprocess.run(['ssh-keygen', '-y', '-f', str(host_key)], check=True, capture_output=True, text=True).stdout
        public_path = host_key.with_suffix('.pub')
        if public_path.is_symlink():
            raise RuntimeError('SSH public host key must not be a symbolic link')
        with tempfile.NamedTemporaryFile(mode='w', dir=keys, delete=False) as output:
            public_temporary = Path(output.name)
            output.write(public_key)
            os.fchmod(output.fileno(), 0o644)
        os.replace(public_temporary, public_path)
        authorized = keys / 'authorized_keys'
        if authorized.is_symlink():
            raise RuntimeError('Authorized keys must not be a symbolic link')
        authorized.touch(exist_ok=True)
        os.chown(authorized, 0, 0, follow_symlinks=False)
        authorized.chmod(0o644)
        if not stat.S_ISREG(authorized.stat().st_mode):
            raise RuntimeError('Authorized keys must be a regular file')
        subprocess.run(['/usr/sbin/sshd', '-t', '-f', '/etc/ssh/sshd_config'], check=True)


if __name__ == '__main__':
    prepare()
