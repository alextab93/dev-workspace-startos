import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid


ROOT = Path(__file__).resolve().parent.parent
SUITES = {
    'project-import': ('projectImport.test.py', None),
    'export-artifact': ('exportArtifact.test.py', None),
    'packages': ('packagesRuntime.test.py', 'DEV_WORKSPACE_PACKAGES_TEST_CONTAINER'),
    'nextcloud-connect': ('nextcloudConnect.test.py', None),
    'nextcloud-files': ('nextcloudRuntime.test.py', None),
    'startos-target': ('startosTarget.test.py', 'DEV_WORKSPACE_TARGET_TEST_CONTAINER'),
    'ssh-connections': ('sshConnections.test.py', 'DEV_WORKSPACE_SSH_TEST_CONTAINER'),
}


def remove_owned(container, run_id):
    inspection = subprocess.run(['docker', 'inspect', container], text=True, capture_output=True, timeout=15)
    if inspection.returncode:
        if 'no such' in inspection.stderr.lower():
            return
        raise RuntimeError('Could not verify owned test container cleanup: ' + inspection.stderr.strip())
    metadata = json.loads(inspection.stdout)[0]
    if metadata['Config']['Labels'].get('dev-workspace.runtime-tests') != run_id:
        raise RuntimeError('Refusing to remove a container without the fixture ownership label.')
    subprocess.run(['docker', 'rm', '-f', '-v', metadata['Id']], check=True, timeout=30, stdout=subprocess.DEVNULL)


def main():
    parser = argparse.ArgumentParser(description='Run workspace helper checks in disposable Linux containers.')
    parser.add_argument('--image', default=os.environ.get('DEV_WORKSPACE_TEST_IMAGE', 'dev-workspace:runtime-test'),
                        help='Current built workspace image tag or ID; also accepts DEV_WORKSPACE_TEST_IMAGE.')
    parser.add_argument('suites', nargs='*', choices=tuple(SUITES))
    options = parser.parse_args()
    inspection = subprocess.run(['docker', 'image', 'inspect', options.image], text=True, capture_output=True, timeout=15)
    if inspection.returncode:
        raise RuntimeError('Cannot inspect workspace image ' + options.image + ': ' + inspection.stderr.strip())
    image = json.loads(inspection.stdout)[0]
    if image['Os'] != 'linux':
        raise RuntimeError('Runtime checks require a built Linux workspace image.')
    print(json.dumps({'image': image['Id'], 'architecture': image['Architecture']}), flush=True)
    run_id = uuid.uuid4().hex
    failures = []
    for name in options.suites or SUITES:
        filename, guard = SUITES[name]
        container = 'dev-workspace-runtime-' + run_id + '-' + name
        command = ['docker', 'run', '--rm', '--name', container, '--label', 'dev-workspace.runtime-tests=' + run_id,
                   '--network', 'none', '--user', '0:0', '--env', 'PYTHONDONTWRITEBYTECODE=1',
                   '--mount', 'type=bind,source=' + str(ROOT) + ',target=/workspace-source,readonly',
                   '--workdir', '/workspace-source', '--entrypoint', 'python3']
        if guard:
            command += ['--env', guard + '=1']
        command += [image['Id'], '/workspace-source/tests/' + filename, '-v']
        print('Running ' + name + ' in a disposable container.', flush=True)
        try:
            result = subprocess.run(command, timeout=600)
            if result.returncode:
                failures.append(name)
        finally:
            remove_owned(container, run_id)
    if failures:
        raise RuntimeError('Runtime suites failed: ' + ', '.join(failures))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
