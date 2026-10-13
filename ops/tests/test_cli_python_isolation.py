from __future__ import annotations

import os
import pathlib
import subprocess
import tempfile
import unittest

CLI = pathlib.Path(__file__).resolve().parents[1] / 'cli'


class IsolatedPythonInvocationTest(unittest.TestCase):
    def test_panel_attach_and_diagnose_do_not_import_cwd_modules(self):
        panel = (CLI / 'cauce-panel').read_text(encoding='utf-8')
        diagnose = (CLI / 'cauce-diagnose').read_text(encoding='utf-8')
        self.assertIn('exec python3 -I -c ', panel)
        self.assertIn('exec python3 -I -B - ', diagnose)
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / 'shlex.py').write_text('raise SystemExit("poisoned-shlex")\n')
            (root / 'argparse.py').write_text('raise SystemExit("poisoned-argparse")\n')
            environment = os.environ.copy()
            environment['PYTHONDONTWRITEBYTECODE'] = '1'
            environment['CAUCE_FLEET_RUNTIME_STATE'] = '1'
            attached = subprocess.run(['bash', str(CLI / 'cauce-panel'), 'alias', '--attach'], cwd=root,
                                      env=environment, capture_output=True, text=True, timeout=20)
            self.assertNotIn('poisoned-shlex', attached.stdout + attached.stderr)
            diagnosed = subprocess.run(['bash', str(CLI / 'cauce-diagnose'), '--help'], cwd=root,
                                       env=environment, capture_output=True, text=True, timeout=20)
            self.assertEqual(diagnosed.returncode, 0, diagnosed.stderr)
            self.assertIn('--session-file', diagnosed.stdout)
            self.assertNotIn('poisoned-argparse', diagnosed.stdout + diagnosed.stderr)


if __name__ == '__main__':
    unittest.main()
