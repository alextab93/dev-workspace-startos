import json
import runpy
import unittest
from pathlib import Path
from unittest.mock import patch

report = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'assets/workspace-podman.py'))['storage_report']


class StorageReportTest(unittest.TestCase):
    def read(self, rows):
        def podman(*command):
            if command[0] == 'info':
                return json.dumps({'version': {'Version': '5.4.2'}, 'host': {'security': {'rootless': True}}, 'store': {'graphDriverName': 'overlay'}})
            if command[:2] == ('system', 'df') and rows is not None:
                return json.dumps(rows)
            raise RuntimeError('Measurement unavailable')

        with patch.dict(report.__globals__, remote=podman), patch('os.geteuid', return_value=1000):
            return {row['name']: row['value'] for row in report(168, 0)['categories']}

    def test_zero_usage_and_missing_measurements(self):
        result = self.read([{'Type':'Images','Total':0,'Active':0,'Size':'0B','Reclaimable':'0B (0%)'}])
        self.assertEqual(result['Images'], 'Total: 0\nActive: 0\nSize: 0B\nReclaimable: 0B (0%)')
        self.assertIn('Size: Unavailable', result['Local Volumes'])
        self.assertIn('Reclaimable: Unavailable', self.read(None)['Images'])


if __name__ == '__main__':
    unittest.main()
