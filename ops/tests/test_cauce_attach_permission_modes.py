import pathlib
import unittest
from importlib import machinery, util

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'ops/guardias/cauce-attach'


def load_attach():
    loader = machinery.SourceFileLoader('cauce_attach_permission_test', str(SOURCE))
    spec = util.spec_from_loader(loader.name, loader)
    module = util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class TestPermissionModes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.attach = load_attach()

    def test_claude_resume_uses_both_bypass_controls(self):
        command = self.attach.resume_cli('claude', 'fixture-session')
        self.assertEqual(command, [
            'claude', '--dangerously-skip-permissions', '--permission-mode',
            'bypassPermissions', '--resume', 'fixture-session',
        ])
        self.assertTrue(self.attach.resumes_session(command, 'fixture-session'))

    def test_codex_resume_uses_full_bypass(self):
        command = self.attach.resume_cli('codex', 'fixture-session')
        self.assertEqual(command, ['codex', '--yolo', 'resume', 'fixture-session'])
        self.assertTrue(self.attach.resumes_session(command, 'fixture-session'))

    def test_detector_accepts_legacy_argv_and_rejects_other_sessions(self):
        self.assertTrue(self.attach.resumes_session(
            ['claude', '--resume', 'fixture-session'], 'fixture-session'))
        self.assertTrue(self.attach.resumes_session(
            ['codex', 'resume', 'fixture-session'], 'fixture-session'))
        self.assertFalse(self.attach.resumes_session(
            ['claude', '--dangerously-skip-permissions'], 'fixture-session'))
        self.assertFalse(self.attach.resumes_session(
            self.attach.resume_cli('claude', 'other-session'), 'fixture-session'))

    def test_process_listing_detects_the_launched_argv(self):
        command = self.attach.resume_cli('claude', 'fixture-session')
        listing = f"42 pts/7 00:01 {' '.join(command)}"
        original = self.attach.in_container
        self.attach.in_container = lambda _container, _script: listing
        try:
            self.assertEqual(
                self.attach.interactive_writers({'container': 'fixture'}, 'fixture-session', False),
                [('42', 'pts/7', '00:01')],
            )
        finally:
            self.attach.in_container = original


if __name__ == '__main__':
    unittest.main()
