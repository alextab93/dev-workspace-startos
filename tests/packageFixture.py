import json
import os
from pathlib import Path
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parent.parent


def build_fixture(destination):
    destination = Path(destination).resolve()
    if destination.exists():
        raise FileExistsError(destination)
    environment = {'PATH': os.environ['PATH'], 'LANG': 'C.UTF-8'}
    with tempfile.TemporaryDirectory(prefix='s9pk-metadata-fixture-') as temporary:
        workspace = Path(temporary)
        state = workspace / '.startos'
        state.mkdir(mode=0o700)
        configuration = state / 'config.yaml'
        configuration.write_text('{}\n')
        key = state / 'build.key.pem'
        subprocess.run(['start-cli', '--config', str(configuration), '--id-key-path', str(key), 'init-key'],
                       cwd=workspace, env=environment, check=True, capture_output=True, timeout=30)
        key.chmod(0o600)
        manifest = subprocess.run(['node', str(ROOT / 'tests/packageFixture.cjs')],
                                  cwd=ROOT, env=environment, check=True, capture_output=True, text=True, timeout=30)
        metadata = json.loads(manifest.stdout)
        javascript = workspace / 'javascript'
        javascript.mkdir()
        (javascript / 'index.js').write_text('exports.manifest = ' + json.dumps(metadata) + '\n')
        instructions = workspace / 'instructions.md'
        instructions.write_text('Disposable metadata fixture for automated package inspection. This archive has no application runtime and must not be installed.\n')
        subprocess.run(['start-cli', '--config', str(configuration), 's9pk', 'pack', str(workspace),
                        '--javascript', str(javascript), '--icon', str(ROOT / 'icon.svg'),
                        '--license', str(ROOT / 'LICENSE'), '--instructions', str(instructions),
                        '--no-assets', '--arch', 'x86_64', '--output', str(destination)],
                       cwd=workspace, env=environment, check=True, capture_output=True, timeout=90)
        destination.chmod(0o644)
    return destination
