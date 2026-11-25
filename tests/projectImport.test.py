from pathlib import Path
import os
import resource
import runpy
import subprocess
import tempfile
import unittest


helper = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'assets/workspace-import.py'))


class ProjectImport(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.shared = Path(scratch.name) / 'shared'
        self.local = Path(scratch.name) / 'local'
        self.project = self.shared / 'project'
        self.project.mkdir(parents=True)
        self.local.mkdir()

    def copy(self, provider):
        return helper['import_project'](provider, 'project', 'copy', self.shared, self.local)

    def test_git_webdav_modes_local_edits_and_index_survive(self):
        def git(*args, cwd=self.project):
            return subprocess.check_output(['git', *args], cwd=cwd)
        git('init', '-q')
        script = self.project / 'script'
        script.write_bytes(b'original')
        script.chmod(0o755)
        link = self.project / 'link'
        link.symlink_to('script')
        git('add', '.')
        git('-c', 'user.name=Example', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')
        script.write_bytes(b'user edits')
        script.chmod(0o660)
        link.unlink()
        link.write_bytes(b'script')
        (self.project / '.notes').write_bytes(b'untracked')
        copy = self.local / 'copy'
        self.assertEqual(self.copy('nextcloud'), {'path': str(copy)})
        self.assertTrue(os.access(copy / 'script', os.X_OK))
        self.assertEqual((copy / 'script').read_bytes(), b'user edits')
        self.assertEqual(os.readlink(copy / 'link'), 'script')
        self.assertEqual((copy / '.notes').read_bytes(), b'untracked')
        self.assertEqual(git('status', '--porcelain', cwd=copy), b' M script\n?? .notes\n')
        self.assertFalse(link.is_symlink())
        self.assertFalse(os.access(script, os.X_OK))
        with self.assertRaises(FileExistsError):
            self.copy('nextcloud')

    def test_interrupted_copy_is_discarded_and_retry_succeeds(self):
        data = os.urandom(2 * 1024 * 1024)
        source = self.project / 'unfinished'
        source.write_bytes(data)
        child = os.fork()
        if child == 0:
            try:
                resource.setrlimit(resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024))
                self.copy('filebrowser')
            except subprocess.CalledProcessError:
                os._exit(0)
            os._exit(1)
        _, status = os.waitpid(child, 0)
        self.assertEqual(os.waitstatus_to_exitcode(status), 0)
        self.assertEqual(list(self.local.iterdir()), [])
        self.assertEqual(source.read_bytes(), data)
        self.copy('filebrowser')
        self.assertEqual((self.local / 'copy/unfinished').read_bytes(), data)

    def test_filebrowser_keeps_worktree_link_and_executable(self):
        script = self.project / 'run'
        script.write_bytes(b'work')
        script.chmod(0o750)
        (self.project / 'pointer').symlink_to('run')
        self.copy('filebrowser')
        self.assertEqual((self.local / 'copy/run').stat().st_mode & 0o777, 0o750)
        self.assertEqual(os.readlink(self.local / 'copy/pointer'), 'run')


if __name__ == '__main__':
    unittest.main()
