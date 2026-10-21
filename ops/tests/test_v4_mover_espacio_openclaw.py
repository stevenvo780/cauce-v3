"""A moved OpenClaw agent keeps its own documents in the workspace V4 OpenClaw reads (Argos, 21-oct)."""
from __future__ import annotations

import json
import os
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
import v4_mover_agente as mover  # noqa: E402
import v4_mover_host as host  # noqa: E402


class SeedWorkspaceTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='cauce-mover-espacio-')
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.state = self.root / 'restore' / 'argos'
        self.space = self.state / 'space'
        legacy = self.space / 'projects' / 'argos-clawd'
        (legacy / 'memory').mkdir(parents=True)
        for name, text in {'AGENTS.md': 'Soy Argos, director de la flota.\n', 'IDENTITY.md': '- **Name:** Argos\n',
                           'DIRECTIVAS-OPERATIVAS.md': 'directivas\n', 'BOOTSTRAP.md': '# BOOTSTRAP.md - Hello, World\n',
                           '.oculto.md': 'no\n', 'notas.txt': 'no\n', 'memory/2026-10-20.md': 'no\n'}.items():
            (legacy / name).write_text(text)
        outside = self.root / 'ajeno.md'
        outside.write_text('ajeno\n')
        (legacy / 'enlace.md').symlink_to(outside)
        self.request = {'directory': str(self.space), 'roots': [
            {'name': 'clawd', 'path': '/datos/agents/ctrl-infra-config/clawd', 'target': 'projects/argos-clawd', 'workspace': True},
            {'name': 'openclaw', 'path': '/datos/agents/ctrl-infra-config/.openclaw', 'target': 'data/openclaw'}]}

    def test_marked_legacy_root_seeds_its_top_level_documents_without_bootstrap(self):
        self.assertEqual(host.seed_workspace(self.request), ['AGENTS.md', 'DIRECTIVAS-OPERATIVAS.md', 'IDENTITY.md'])
        workspace = self.state / 'workspace'
        self.assertEqual(workspace.stat().st_mode & 0o777, 0o700)
        self.assertEqual(sorted(path.name for path in workspace.iterdir()), ['AGENTS.md', 'DIRECTIVAS-OPERATIVAS.md', 'IDENTITY.md'])
        self.assertEqual((workspace / 'IDENTITY.md').read_text(), '- **Name:** Argos\n')
        self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600 and not path.is_symlink() for path in workspace.iterdir()))
        self.assertTrue((self.space / 'projects' / 'argos-clawd' / 'AGENTS.md').exists())

    def test_existing_workspace_content_is_never_overwritten(self):
        workspace = self.state / 'workspace'
        workspace.mkdir(mode=0o700)
        (workspace / 'AGENTS.md').write_text('otro\n')
        with self.assertRaises(ValueError):
            host.seed_workspace(self.request)
        self.assertEqual((workspace / 'AGENTS.md').read_text(), 'otro\n')

    def test_without_a_marked_root_nothing_is_created(self):
        self.request['roots'][0].pop('workspace')
        self.assertEqual(host.seed_workspace(self.request), [])
        self.assertFalse((self.state / 'workspace').exists())


class PlanWorkspaceMarkTest(unittest.TestCase):
    def plan(self, roots):
        directory = tempfile.TemporaryDirectory(prefix='cauce-mover-plan-')
        self.addCleanup(directory.cleanup)
        path = pathlib.Path(directory.name) / 'plan.json'
        endpoint = {'route': 'local', 'machine_id_sha256': '0' * 16}
        path.write_text(json.dumps({'company': 'humanizar', 'tenant': 'Steven', 'session_file': 'sesion.json',
                                    'source': endpoint, 'destination': {**endpoint, 'host_id': 'server2'}, 'roots': roots}))
        os.chmod(path, 0o600)
        return path

    def test_only_one_boolean_workspace_root_is_accepted(self):
        root = {'name': 'clawd', 'path': '/legacy/clawd', 'target': 'projects/argos-clawd'}
        other = {'name': 'notas', 'path': '/legacy/notas', 'target': 'projects/notas'}
        self.assertEqual(mover.load_plan(self.plan([{**root, 'workspace': True}, other]), 'argos')['roots'][0]['workspace'], True)
        for roots in ([{**root, 'workspace': 'yes'}], [{**root, 'workspace': True}, {**other, 'workspace': True}]):
            with self.subTest(roots=roots), self.assertRaises(ValueError):
                mover.load_plan(self.plan(roots), 'argos')


    def test_an_openclaw_move_requires_its_workspace_mark_and_other_harnesses_refuse_it(self):
        marked = {'roots': [{'name': 'clawd', 'target': 'projects/argos-clawd', 'workspace': True}]}
        unmarked = {'roots': [{'name': 'clawd', 'target': 'projects/argos-clawd'}]}
        mover.check_workspace_mark(marked, {'harness_id': 'openclaw'})
        mover.check_workspace_mark(unmarked, {'harness_id': 'muse'})
        for plan, harness in ((unmarked, 'openclaw'), (marked, 'muse')):
            with self.subTest(harness=harness), self.assertRaises(ValueError):
                mover.check_workspace_mark(plan, {'harness_id': harness})


if __name__ == '__main__':
    unittest.main()
