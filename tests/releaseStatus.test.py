import json
import os
import runpy
import tempfile
import unittest
from pathlib import Path

tool = runpy.run_path(str(Path(__file__).resolve().parents[1] / "assets/workspace-release-status.py"))
read_project = tool["read_project"]
report = {"checkedAt": "2026-11-23T10:00:00Z", "validated": {"revision": "abc"}, "published": None, "deployed": None}


class ProjectReport(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        read_project.__globals__["ROOT"] = self.root
        self.folder = self.root / "nested/repo/.ai-workspace"
        self.folder.mkdir(parents=True)
        self.file = self.folder / "release-status.json"
        self.file.write_text(json.dumps(report))

    def test_reads_nested_project_report(self):
        self.assertEqual(read_project("nested/repo"), report)

    def test_rejects_paths_outside_the_selected_tree(self):
        (self.root / "linked").symlink_to(self.folder.parent, target_is_directory=True)
        for path in ("../nested/repo", str(self.root), "linked"):
            with self.subTest(path=path), self.assertRaises((ValueError, OSError)):
                read_project(path)
        self.file.rename(self.root / "outside")
        self.file.symlink_to(self.root / "outside")
        with self.assertRaises(OSError):
            read_project("nested/repo")

    def test_rejects_fifo_and_oversized_reports(self):
        self.file.unlink()
        os.mkfifo(self.file)
        with self.assertRaisesRegex(ValueError, "regular"):
            read_project("nested/repo")
        self.file.unlink()
        self.file.write_bytes(b" " * 65537)
        with self.assertRaisesRegex(ValueError, "64 KiB"):
            read_project("nested/repo")


if __name__ == "__main__":
    unittest.main()
