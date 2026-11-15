from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
import importlib.util
import json
import os
from pathlib import Path
import socketserver
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.parse import parse_qs, urlsplit


ROOT = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True


def load(name, filename):
    specification = importlib.util.spec_from_file_location(name, ROOT / 'assets' / filename)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


helper = load('workspace_docker', 'workspace-docker.py')
runtime = load('runc_nested', 'runc-nested.py')


class DockerBoundary(BaseHTTPRequestHandler):
    def log_message(self, format, *arguments):
        pass

    def respond(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.server.mode == 'failure':
            self.respond({'message': 'private-fixture-token'}, 500)
        elif self.path == '/version':
            self.respond({'Version': '28.5.2', 'ApiVersion': '1.51', 'MinAPIVersion': '1.24'})
        elif self.path == '/v1.48/info':
            self.respond({'Driver': 'fuse-overlayfs', 'CgroupDriver': 'cgroupfs', 'CgroupVersion': '2',
                          'Containers': len(self.server.containers), 'ContainersRunning': 1, 'Images': len(self.server.images)})
        elif self.path == '/v1.48/system/df':
            self.respond({'LayersSize': sum(item['size'] for item in self.server.images),
                          'Containers': [{'SizeRw': item['size']} for item in self.server.containers],
                          'Volumes': [{'UsageData': {'Size': item['size']}} for item in self.server.volumes],
                          'BuildCache': [{'ID': item['id'], 'Size': item['size'], 'InUse': item['used']} for item in self.server.caches]})
        else:
            self.respond({'message': 'unsupported fixture operation'}, 404)

    def do_POST(self):
        parsed = urlsplit(self.path)
        query = parse_qs(parsed.query)
        try:
            filters = json.loads(query.get('filters', ['{}'])[0])
            age = int(filters.get('until', ['0h'])[0].removesuffix('h'))
        except (ValueError, TypeError):
            self.respond({'message': 'invalid filter'}, 400)
            return
        if parsed.path == '/v1.48/images/prune':
            candidates = [item for item in self.server.images if not item['used'] and item['age'] > age
                          and (not item['tagged'] or filters.get('dangling') == ['false'])]
            self.server.images = [item for item in self.server.images if item not in candidates]
            self.respond({'ImagesDeleted': [{'Deleted': item['id']} for item in candidates],
                          'SpaceReclaimed': sum(item['size'] for item in candidates)})
        elif parsed.path == '/v1.48/build/prune':
            candidates = [item for item in self.server.caches if not item['used'] and item['age'] > age]
            self.server.caches = [item for item in self.server.caches if item not in candidates]
            self.respond({'CachesDeleted': [item['id'] for item in candidates],
                          'SpaceReclaimed': sum(item['size'] for item in candidates)})
        else:
            self.respond({'message': 'unsupported fixture operation'}, 404)


class UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


class DockerRuntime(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='dw-docker-', dir='/tmp')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.socket = self.directory / 'docker.sock'
        self.server = UnixHTTPServer(str(self.socket), DockerBoundary)
        self.server.mode = 'normal'
        self.server.images = [
            {'id': 'unused-old', 'size': 100, 'age': 300, 'used': False, 'tagged': True},
            {'id': 'unused-new', 'size': 50, 'age': 3, 'used': False, 'tagged': False},
            {'id': 'in-stopped-container', 'size': 80, 'age': 300, 'used': True, 'tagged': True},
        ]
        self.server.caches = [
            {'id': 'old-cache', 'size': 200, 'age': 300, 'used': False},
            {'id': 'recent-cache', 'size': 70, 'age': 3, 'used': False},
            {'id': 'active-cache', 'size': 30, 'age': 300, 'used': True},
        ]
        self.server.containers = [{'id': 'running', 'size': 40}, {'id': 'stopped-with-work', 'size': 60}]
        self.server.volumes = [{'id': 'unattached-database', 'size': 500}]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_storage_report_shows_engine_and_separate_usage_categories(self):
        report = helper.storage_report(self.socket, self.directory)
        self.assertTrue(report['available'])
        self.assertEqual(report['engine'], {'version': '28.5.2', 'apiVersion': '1.48', 'storageDriver': 'fuse-overlayfs',
                                           'cgroupDriver': 'cgroupfs', 'cgroupVersion': '2', 'containers': 2,
                                           'runningContainers': 1, 'images': 3})
        self.assertEqual(report['usage'], {'imagesBytes': 230, 'containerWritableBytes': 100, 'volumesBytes': 500,
                                          'volumeSizesComplete': True, 'volumeCount': 1, 'buildCacheBytes': 300,
                                          'buildCacheReclaimableBytes': 270})
        self.assertEqual(report['buildCache'], {'scope': 'default-builder-only'})
        self.assertIsNone(report['filesystem'])
        self.assertIsNone(report['error'])

    def test_cache_cleanup_preserves_recent_active_cache_images_containers_and_volumes(self):
        result = helper.clean('cache', 168, self.socket)
        self.assertEqual(result, {'target': 'cache', 'olderThanHours': 168, 'reclaimedBytes': 200, 'deletedCount': 1})
        self.assertEqual([item['id'] for item in self.server.caches], ['recent-cache', 'active-cache'])
        self.assertEqual([item['id'] for item in self.server.images], ['unused-old', 'unused-new', 'in-stopped-container'])
        self.assertEqual(self.server.containers, [{'id': 'running', 'size': 40}, {'id': 'stopped-with-work', 'size': 60}])
        self.assertEqual(self.server.volumes, [{'id': 'unattached-database', 'size': 500}])

    def test_image_cleanup_preserves_recent_and_referenced_images_and_every_volume(self):
        result = helper.clean('images', 168, self.socket)
        self.assertEqual(result, {'target': 'images', 'olderThanHours': 168, 'reclaimedBytes': 100, 'deletedCount': 1})
        self.assertEqual([item['id'] for item in self.server.images], ['unused-new', 'in-stopped-container'])
        self.assertEqual([item['id'] for item in self.server.caches], ['old-cache', 'recent-cache', 'active-cache'])
        self.assertEqual(self.server.containers, [{'id': 'running', 'size': 40}, {'id': 'stopped-with-work', 'size': 60}])
        self.assertEqual(self.server.volumes, [{'id': 'unattached-database', 'size': 500}])

    def test_repeated_cleanup_reports_no_further_reclamation(self):
        helper.clean('cache', 168, self.socket)
        self.assertEqual(helper.clean('cache', 168, self.socket), {
            'target': 'cache', 'olderThanHours': 168, 'reclaimedBytes': 0, 'deletedCount': 0})

    def test_invalid_cleanup_policy_preserves_stored_objects(self):
        for target, age in [('volumes', 168), ('containers', 168), ('cache', 0), ('images', 8761), ('cache', True)]:
            with self.subTest(target=target, age=age), self.assertRaises(helper.DockerError):
                helper.clean(target, age, self.socket)
        self.assertEqual([item['id'] for item in self.server.images], ['unused-old', 'unused-new', 'in-stopped-container'])
        self.assertEqual([item['id'] for item in self.server.caches], ['old-cache', 'recent-cache', 'active-cache'])

    def test_unavailable_and_backend_failures_are_reported_without_private_bodies(self):
        unavailable = helper.storage_report(self.directory / 'missing.sock', self.directory)
        self.assertFalse(unavailable['available'])
        self.assertEqual(unavailable['error'], 'The workspace Docker engine is unavailable.')
        self.server.mode = 'failure'
        failed = helper.storage_report(self.socket, self.directory)
        self.assertFalse(failed['available'])
        self.assertEqual(failed['error'], 'Docker engine request failed (HTTP 500).')
        self.assertNotIn('private-fixture-token', json.dumps(failed))

    def test_command_ignores_user_docker_context_and_host(self):
        if helper.SOCKET.exists():
            self.skipTest('The fixed workspace socket already exists on this machine')
        environment = dict(os.environ, DOCKER_HOST='unix://' + str(self.socket), DOCKER_CONTEXT='external-fixture')
        result = subprocess.run([sys.executable, str(ROOT / 'assets/workspace-docker.py'), 'status'],
                                env=environment, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(json.loads(result.stdout)['available'])
        self.assertEqual(result.stderr, '')

    def test_engine_filesystem_report_describes_the_engine_volume(self):
        helper.write_filesystem_report(self.directory, self.directory)
        report = json.loads((self.directory / 'storage.json').read_text())
        filesystem = os.statvfs(self.directory)
        self.assertEqual(report['totalBytes'], filesystem.f_blocks * filesystem.f_frsize)
        self.assertGreaterEqual(report['availableBytes'], 0)
        self.assertGreater(report['totalBytes'], report['availableBytes'])
        self.assertLess((datetime.now(timezone.utc) - datetime.fromisoformat(report['observedAt'])).total_seconds(), 5)

    def test_stale_or_symlink_disk_reports_are_not_presented_as_current(self):
        report = {'totalBytes': 100, 'availableBytes': 60, 'usedBytes': 40,
                  'observedAt': (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat()}
        path = self.directory / 'storage.json'
        path.write_text(json.dumps(report))
        self.assertIsNone(helper.filesystem_report(self.directory))
        path.unlink()
        outside = self.directory / 'other.json'
        outside.write_text(json.dumps(report))
        path.symlink_to(outside)
        self.assertIsNone(helper.filesystem_report(self.directory))

    def test_daemon_configuration_uses_persistent_storage_local_socket_and_bounded_cache(self):
        configuration = helper.daemon_configuration(10)
        self.assertEqual(configuration['hosts'], ['unix:///run/dev-workspace-docker/docker.sock'])
        self.assertEqual(configuration['data-root'], '/var/lib/docker')
        self.assertEqual(configuration['exec-root'], '/run/dev-workspace-engine/exec')
        self.assertEqual(configuration['pidfile'], '/run/dev-workspace-engine/docker.pid')
        self.assertEqual(configuration['builder']['gc'], {'enabled': True, 'defaultKeepStorage': '10737418240'})
        self.assertEqual(configuration['log-driver'], 'local')
        self.assertEqual(configuration['log-opts'], {'max-size': '10m', 'max-file': '3'})
        self.assertFalse(configuration['live-restore'])
        for budget in [0, 1001, True]:
            with self.subTest(budget=budget), self.assertRaises(helper.DockerError):
                helper.daemon_configuration(budget)

    def test_stale_runtime_cleanup_retains_unrelated_files_and_engine_execution_tree(self):
        shared = self.directory / 'runtime'
        engine = self.directory / 'engine'
        shared.mkdir()
        engine.mkdir()
        (shared / 'docker.sock').write_text('stale socket fixture')
        (shared / 'storage.json').write_text('{}')
        (shared / 'unrelated').write_text('retained')
        (engine / 'docker.pid').write_text('999999999')
        (engine / 'exec').mkdir()
        (engine / 'exec' / 'potentially-mounted-data').write_text('never recursively delete')
        helper.remove_stale_runtime(shared, engine)
        self.assertEqual((shared / 'unrelated').read_text(), 'retained')
        self.assertEqual((engine / 'exec' / 'potentially-mounted-data').read_text(), 'never recursively delete')
        self.assertFalse((shared / 'docker.sock').exists())
        self.assertFalse((shared / 'storage.json').exists())
        self.assertFalse((engine / 'docker.pid').exists())


class NestedRuntime(unittest.TestCase):
    def test_bundle_rewrites_only_the_incompatible_sysctl_and_preserves_permissions(self):
        for option in ['--bundle', '-b', '--bundle=']:
            with self.subTest(option=option), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                config = directory / 'config.json'
                config.write_text(json.dumps({'ociVersion': '1.2.0', 'linux': {'sysctl': {
                    'net.ipv4.ip_unprivileged_port_start': '0', 'net.ipv4.ip_forward': '1'}}, 'process': {'args': ['true']}}))
                config.chmod(0o640)
                arguments = [option + str(directory)] if option.endswith('=') else [option, str(directory)]
                runtime.prepare_bundle(['--root', '/example', 'create', *arguments, 'example'])
                self.assertEqual(json.loads(config.read_text()), {
                    'ociVersion': '1.2.0', 'linux': {'sysctl': {'net.ipv4.ip_forward': '1'}}, 'process': {'args': ['true']}})
                self.assertEqual(config.stat().st_mode & 0o777, 0o640)

    def test_configuration_without_the_sysctl_remains_byte_identical(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / 'config.json'
            content = '{ "linux": {}, "process": {"args": ["true"]}}\n'
            config.write_text(content)
            runtime.prepare_bundle(['create', '--bundle', temporary, 'example'])
            self.assertEqual(config.read_text(), content)

    def test_bundle_symlink_is_rejected_without_changing_the_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            target = directory / 'target.json'
            target.write_text('{"linux":{}}')
            (directory / 'config.json').symlink_to(target)
            with self.assertRaises(ValueError):
                runtime.prepare_bundle(['create', '--bundle', temporary, 'example'])
            self.assertEqual(target.read_text(), '{"linux":{}}')


if __name__ == '__main__':
    unittest.main()
