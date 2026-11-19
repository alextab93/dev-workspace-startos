import argparse
from pathlib import Path
import shlex
import subprocess
import uuid


def exercise(host, config):
    options = ['-F', config] if config else []
    name = 'dwtest' + uuid.uuid4().hex[:12]
    directory = '/home/dev/projects/' + name
    fixture = Path(__file__).parent / 'fixtures/supervised-project'

    def ssh(*args, data=None):
        return subprocess.run(['ssh', *options, '-oBatchMode=yes', '--', host, shlex.join(args)],
                              input=data, capture_output=True, text=True, check=True,
                              timeout=400).stdout.strip()

    def compose(*args):
        return ssh('workspace-compose', *args)

    def read(path):
        port = ssh('podman', 'port', name + '_web_1', '8000/tcp')
        return ssh('curl', '--retry-all-errors', '--retry', '4', '-fsS', 'http://' + port + '/' + path)

    ssh('mkdir', '-m', '700', directory)
    try:
        for filename in ('app.py', 'compose.yaml'):
            contents = (fixture / filename).read_text()
            if filename == 'compose.yaml':
                contents = contents.replace('127.0.0.1:18654:', '127.0.0.1::')
            ssh('sh', '-c', 'cat > "$1"', 'write', directory + '/' + filename, data=contents)
        secret = uuid.uuid4().hex
        ssh('sh', '-c', 'cat > "$1"', 'write', directory + '/.env', data='EXAMPLE_TOKEN=' + secret)
        assert secret not in compose('register', name, name, 'compose.yaml', 'off')
        assert secret not in compose('start', name)
        compose('start', name)
        assert read('write') == 'persisted row'
        status = compose('status', name)
        assert name + '_web_1' in status and secret not in status
        assert 'GET /write' in compose('logs', name)
        compose('stop', name)
        compose('unregister', name)
        assert name not in compose('list')
        ssh('podman', 'volume', 'exists', name + '_records')
        compose('register', name, name, 'compose.yaml', 'off')
        compose('start', name)
        assert read('read') == 'persisted row'
    finally:
        ssh('podman-compose', '-p', name, '-f', directory + '/compose.yaml', 'down', '-v')
        if name in compose('list'):
            compose('unregister', name)
        ssh('rm', '-r', '--', directory)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('host', help='SSH host for a disposable workspace with Podman enabled')
    parser.add_argument('--ssh-config', help='SSH configuration containing the disposable host')
    args = parser.parse_args()
    exercise(args.host, args.ssh_config)
