import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid


sys.dont_write_bytecode = True


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


manager_module = load('packages', '/src/assets/workspace-packages.py')
files = load('package_files', '/src/assets/workspace-package-files.py')


class PackageFilesTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix='package-files-'))
        self.old_roots = files.ROOTS
        files.ROOTS = (str(self.directory),)

    def tearDown(self):
        files.ROOTS = self.old_roots
        shutil.rmtree(self.directory)

    def test_real_package_metadata_does_not_depend_on_filename(self):
        destination = self.directory / 'not-an-arm-package.S9PK'
        shutil.copyfile('/fixture.s9pk', destination)
        result = files.inspect_file(str(destination))
        self.assertEqual(result['id'], 'dev-workspace-podman-probe')
        self.assertEqual(result['version'], '0.1.0:1')
        self.assertEqual(result['architectures'], ['x86_64'])
        self.assertEqual(result['sha256'], hashlib.sha256(destination.read_bytes()).hexdigest())

    def test_scan_reports_invalid_packages_and_finds_nested_files(self):
        nested = self.directory / 'project' / 'build'
        nested.mkdir(parents=True)
        shutil.copyfile('/fixture.s9pk', nested / 'fixture.s9pk')
        (self.directory / 'broken.s9pk').write_bytes(b'not a package')
        result = files.scan()
        self.assertEqual([item['path'] for item in result['packages']], [str(nested / 'fixture.s9pk')])
        self.assertEqual([item['path'] for item in result['errors']], [str(self.directory / 'broken.s9pk')])
        self.assertEqual(result['truncated'], False)

    def test_symlinks_traversal_and_special_files_are_rejected(self):
        (self.directory / 'link.s9pk').symlink_to('/fixture.s9pk')
        (self.directory / 'linked').symlink_to('/tmp', target_is_directory=True)
        os.mkfifo(self.directory / 'pipe.s9pk')
        for path in (self.directory / 'link.s9pk', self.directory / 'linked/file.s9pk', self.directory / '../fixture.s9pk', self.directory / 'pipe.s9pk', Path('/fixture.s9pk')):
            with self.assertRaises((OSError, ValueError)):
                files.open_project_file(str(path))


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix='package-manager-'))
        self.project = Path('/home/dev/projects') / ('manager-test-' + uuid.uuid4().hex)
        self.project.mkdir(parents=True)
        self.project.chmod(0o755)
        self.artifact = self.project / 'fixture.s9pk'
        self.artifact.write_bytes(b'fixture package bytes')
        self.artifact.chmod(0o644)
        self.old_cli, self.old_files, self.old_seed = manager_module.CLI, manager_module.FILES, manager_module.SEED
        manager_module.FILES = '/usr/local/bin/workspace-package-files'
        manager_module.CLI = str(self.directory / 'cli')
        manager_module.SEED = self.directory / 'seed.json'
        manager_module.SEED.write_text(json.dumps({'version': 1, 'url': 'https://127.0.0.1', 'rootCa': 'public fixture ca'}))
        Path(manager_module.CLI).write_text('''#!/usr/bin/python3
import json, os, pathlib, sys
args = sys.argv[1:]
state = pathlib.Path.cwd()
if 'login' in args:
    if os.environ.get('PASSWORD') != 'fixture-password-secret':
        sys.exit(1)
    pathlib.Path(args[args.index('--id-key-path') + 1]).write_text('fixture signing identity')
elif 'logout' in args:
    pass
elif 'list' in args:
    print((state / 'installed.json').read_text() if (state / 'installed.json').exists() else '[]')
elif 'install' in args:
    if '--trust' not in args:
        sys.exit(1)
    data = pathlib.Path(args[args.index('--sideload') + 1]).read_bytes()
    (state / 'installed-artifact').write_bytes(data)
    (state / 'installed.json').write_text(json.dumps([{'id':'fixture','version':'1.0.0:0','status':'installed'}]))
else:
    sys.exit(1)
''')
        Path(manager_module.CLI).chmod(0o755)
        self.manager = manager_module.Manager(self.directory / 'state')
        self.item = {'token': uuid.uuid4().hex, 'path': str(self.artifact), 'id': 'fixture', 'title': 'Fixture', 'version': '1.0.0:0',
                     'size': self.artifact.stat().st_size, 'sha256': hashlib.sha256(self.artifact.read_bytes()).hexdigest(), 'architectures': ['x86_64', 'aarch64']}
        manager_module.write_json(self.manager.state / 'catalog.json', {'packages': [self.item], 'errors': [], 'truncated': False, 'scannedAt': manager_module.now()})

    def tearDown(self):
        self.manager.stop()
        manager_module.CLI, manager_module.FILES, manager_module.SEED = self.old_cli, self.old_files, self.old_seed
        shutil.rmtree(self.directory)
        shutil.rmtree(self.project)

    def wait(self):
        for _ in range(300):
            result = self.manager.dispatch({'operation': 'status'})
            if result['job']['state'] != 'running' and result['history'] and result['history'][-1]['id'] == result['job']['id']:
                return result['job']
            time.sleep(0.02)
        self.fail('The package operation did not finish.')

    def connect(self):
        self.manager.dispatch({'operation': 'connect', 'password': 'fixture-password-secret'})
        self.assertEqual(self.wait()['state'], 'succeeded')

    def install(self, trust=True):
        self.manager.dispatch({'operation': 'install', 'token': self.item['token'], 'trust': trust, 'confirmed': True})
        return self.wait()

    def test_connect_install_and_disconnect_preserve_original_and_never_save_password(self):
        self.connect()
        self.assertEqual(self.manager.catalog()['connected'], True)
        self.assertEqual(self.install()['state'], 'succeeded')
        self.assertEqual((self.manager.state / 'installed-artifact').read_bytes(), b'fixture package bytes')
        self.assertEqual(self.artifact.read_bytes(), b'fixture package bytes')
        self.assertEqual(self.manager.catalog()['packages'][0]['installedVersion'], '1.0.0:0')
        self.assertEqual(list(self.manager.state.glob('stage-*.s9pk')), [])
        for file in self.manager.state.iterdir():
            if file.is_file():
                self.assertNotIn(b'fixture-password-secret', file.read_bytes())
        self.manager.dispatch({'operation': 'disconnect'})
        self.assertEqual(self.wait()['state'], 'succeeded')
        self.assertEqual((self.manager.state / 'id.key.pem').exists(), False)

    def test_changed_file_is_not_installed(self):
        self.connect()
        self.artifact.write_bytes(b'changed package bytes')
        result = self.install()
        self.assertEqual(result['state'], 'failed')
        self.assertIn('changed after scanning', result['message'])
        self.assertEqual((self.manager.state / 'installed.json').exists(), False)
        self.assertEqual(list(self.manager.state.glob('stage-*.s9pk')), [])

    def test_untrusted_signer_failure_is_visible_and_does_not_install(self):
        self.connect()
        self.assertEqual(self.install(trust=False)['state'], 'failed')
        self.assertEqual((self.manager.state / 'installed.json').exists(), False)

    def test_invalid_password_is_not_reported_as_connected(self):
        self.manager.dispatch({'operation': 'connect', 'password': 'wrong-secret'})
        self.assertEqual(self.wait()['state'], 'failed')
        self.assertEqual(self.manager.catalog()['connected'], False)
        self.assertNotIn('wrong-secret', (self.manager.state / 'history.json').read_text())

    def test_confirmation_stale_selection_and_foreign_architecture_are_rejected(self):
        self.connect()
        with self.assertRaisesRegex(manager_module.PackageError, 'Confirm'):
            self.manager.dispatch({'operation': 'install', 'token': self.item['token'], 'trust': False, 'confirmed': False})
        with self.assertRaisesRegex(manager_module.PackageError, 'expired'):
            self.manager.dispatch({'operation': 'install', 'token': 'unknown', 'trust': False, 'confirmed': True})
        self.item['architectures'] = ['riscv64']
        manager_module.write_json(self.manager.state / 'catalog.json', {'packages': [self.item], 'errors': [], 'truncated': False, 'scannedAt': manager_module.now()})
        with self.assertRaisesRegex(manager_module.PackageError, 'architecture'):
            self.manager.dispatch({'operation': 'install', 'token': self.item['token'], 'trust': False, 'confirmed': True})
        self.assertEqual((self.manager.state / 'installed.json').exists(), False)

    def test_restart_reports_interruption_and_discards_only_owned_staging_files(self):
        self.manager.job = {'id': uuid.uuid4().hex, 'operation': 'install', 'state': 'running', 'startedAt': manager_module.now(), 'finishedAt': None, 'message': 'Installing', 'package': None}
        manager_module.write_json(self.manager.state / 'job.json', self.manager.job)
        (self.manager.state / 'stage-fixture.s9pk').write_bytes(b'incomplete')
        restarted = manager_module.Manager(self.manager.state)
        self.assertEqual(restarted.dispatch({'operation': 'status'})['job']['state'], 'interrupted')
        self.assertEqual(list(self.manager.state.glob('stage-*.s9pk')), [])
        self.assertEqual(self.artifact.read_bytes(), b'fixture package bytes')

    def test_cancel_scan_retains_last_catalog_and_project_files(self):
        previous = self.manager.catalog()
        self.manager.dispatch({'operation': 'scan', 'scope': 'local'})
        self.assertEqual(self.manager.dispatch({'operation': 'cancel-scan'}), {'cancelRequested': True})
        result = self.wait()
        self.assertEqual(result['state'], 'cancelled')
        self.assertEqual(result['message'], 'Scan cancelled. The previous catalog was retained.')
        self.assertEqual(self.manager.catalog(), previous)
        self.assertEqual(self.artifact.read_bytes(), b'fixture package bytes')
        with self.assertRaisesRegex(manager_module.PackageError, 'No package scan'):
            self.manager.dispatch({'operation': 'cancel-scan'})

    def test_unknown_scan_scope_is_rejected(self):
        with self.assertRaisesRegex(manager_module.PackageError, 'Choose local'):
            self.manager.dispatch({'operation': 'scan', 'scope': '/etc'})
        self.assertEqual(self.manager.catalog()['packages'][0]['path'], str(self.artifact))


class ManagerRpcTests(unittest.TestCase):
    def test_running_manager_discovers_shared_files_and_denies_developer_control(self):
        shared = Path('/projects-shared')
        shared.mkdir(exist_ok=True)
        fixture = shared / 'rpc-fixture.s9pk'
        shutil.copyfile('/fixture.s9pk', fixture)
        local = Path('/home/dev/projects/rpc-local.s9pk')
        local.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile('/fixture.s9pk', local)
        process = subprocess.Popen(['python3', '/src/assets/workspace-packages.py', 'serve'])
        def request(value):
            result = subprocess.run(['python3', '/src/assets/workspace-packages.py', 'client'], input=json.dumps(value) + '\n', text=True, capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        try:
            for _ in range(100):
                if manager_module.SOCKET.exists():
                    break
                time.sleep(0.05)
            denied = subprocess.run(['python3', '/src/assets/workspace-packages.py', 'client'], input='{"operation":"status"}\n', text=True, capture_output=True, user=1000, group=1000, extra_groups=[], timeout=5)
            self.assertEqual(denied.returncode, 1)
            self.assertEqual(request({'operation': 'scan', 'scope': 'shared'})['ok'], True)
            for _ in range(300):
                status = request({'operation': 'status'})['value']['job']
                if status['state'] != 'running':
                    break
                time.sleep(0.05)
            self.assertEqual(status['state'], 'succeeded', status)
            catalog = request({'operation': 'catalog'})['value']
            self.assertEqual(catalog['connected'], False)
            self.assertEqual([item['path'] for item in catalog['packages']], [str(fixture)])
            self.assertEqual(catalog['packages'][0]['architectures'], ['x86_64'])
            self.assertEqual(fixture.read_bytes(), Path('/fixture.s9pk').read_bytes())
            self.assertEqual(request({'operation': 'scan', 'scope': 'local'})['ok'], True)
            for _ in range(300):
                status = request({'operation': 'status'})['value']['job']
                if status['state'] != 'running':
                    break
                time.sleep(0.05)
            self.assertEqual(status['state'], 'succeeded', status)
            catalog = request({'operation': 'catalog'})['value']
            self.assertEqual([item['path'] for item in catalog['packages']], [str(local)])
        finally:
            process.terminate()
            process.wait(timeout=10)
            fixture.unlink()
            local.unlink()
        self.assertEqual(manager_module.SOCKET.exists(), False)


if __name__ == '__main__':
    unittest.main()
