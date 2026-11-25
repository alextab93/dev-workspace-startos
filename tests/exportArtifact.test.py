import hashlib
import os
from pathlib import Path
import resource
import runpy
import signal
import tempfile
import unittest


@unittest.skipUnless(hasattr(os, 'O_TMPFILE'), 'requires Linux anonymous temporary files')
class ExportArtifactTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.local = Path(temporary.name) / 'local'
        self.shared = Path(temporary.name) / 'shared'
        self.local.mkdir()
        self.shared.mkdir()
        module = Path(__file__).resolve().parents[1] / 'assets/workspace-package-files.py'
        self.export = runpy.run_path(str(module))['export_filebrowser']
        self.export.__globals__['ROOTS'] = (str(self.shared), str(self.local))

    def test_verified_copy_and_collision(self):
        artifact = self.local / 'build.s9pk'
        content = os.urandom(1024 * 1024 + 31)
        artifact.write_bytes(content)
        result = self.export(artifact.name, '.')
        self.assertEqual(result['sha256'], hashlib.sha256(content).hexdigest())
        artifact.write_bytes(b'new build')
        with self.assertRaises(FileExistsError):
            self.export(artifact.name, '.')
        self.assertEqual((self.shared / artifact.name).read_bytes(), content)

    def test_interrupted_copy_and_retry(self):
        artifact = self.local / 'interrupted.s9pk'
        content = os.urandom(3 * 1024 * 1024)
        artifact.write_bytes(content)
        child = os.fork()
        if child == 0:
            try:
                signal.signal(signal.SIGXFSZ, signal.SIG_DFL)
                resource.setrlimit(resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024))
                self.export(artifact.name, '.')
            finally:
                os._exit(1)
        _, status = os.waitpid(child, 0)
        self.assertEqual(os.waitstatus_to_exitcode(status), -signal.SIGXFSZ)
        self.assertEqual(list(self.shared.iterdir()), [])
        self.assertEqual(artifact.read_bytes(), content)
        self.export(artifact.name, '.')
        self.assertEqual((self.shared / artifact.name).read_bytes(), content)

    def test_destination_symlink_is_rejected(self):
        (self.local / 'artifact').write_bytes(b'artifact')
        (self.shared / 'other').symlink_to(self.local)
        with self.assertRaises(OSError):
            self.export('artifact', 'other')
        self.assertEqual(sorted(self.local.iterdir()), [self.local / 'artifact'])


if __name__ == '__main__':
    unittest.main()
