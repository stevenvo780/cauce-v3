import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'scripts/context-broker-preflight.py'
ENVIRONMENT = {**{name: value for name, value in os.environ.items() if not name.startswith('GIT_')},
               'LC_ALL': 'C', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
               'GIT_AUTHOR_NAME': 'zz-canary-outsider', 'GIT_AUTHOR_EMAIL': 'zz-canary-outsider@cauce.invalid',
               'GIT_COMMITTER_NAME': 'zz-canary-outsider', 'GIT_COMMITTER_EMAIL': 'zz-canary-outsider@cauce.invalid'}


def git(directory: pathlib.Path, *arguments: str) -> str:
    return subprocess.run(['git', '-C', str(directory), *arguments], env=ENVIRONMENT, capture_output=True, text=True,
                          check=True).stdout.strip()


class ContextBrokerPreflightTests(unittest.TestCase):
    """The broker preflight against a local bare remote: exit 0 only when every operational condition holds."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        self.remote, self.repository, self.outsider = self.root / 'remote.git', self.root / 'contexts', self.root / 'outsider'
        git(self.root, 'init', '--quiet', '--bare', '--initial-branch=main', str(self.remote))
        git(self.root, 'init', '--quiet', '--initial-branch=main', str(self.repository))
        self.repository.chmod(0o700)
        git(self.repository, 'commit', '--quiet', '--allow-empty', '-m', 'Initialize broker fixture')
        git(self.repository, 'remote', 'add', 'origin', str(self.remote))
        git(self.repository, 'push', '--quiet', 'origin', 'refs/heads/main:refs/heads/main')
        self.key = self.root / 'ssh/id_ed25519'
        self.key.parent.mkdir(mode=0o700)
        self.key.write_text('zz-canary-placeholder-not-a-key\n')
        self.key.chmod(0o600)
        git(self.repository, 'config', 'core.sshCommand', f'ssh -i {self.key} -o IdentitiesOnly=yes')

    def tearDown(self):
        self.temporary.cleanup()

    def preflight(self, *extra: str) -> tuple[int, dict, str]:
        result = subprocess.run([sys.executable, str(SCRIPT), '--repository', str(self.repository), '--uid', str(os.getuid()), *extra],
                                capture_output=True, text=True, timeout=120, check=False)
        return result.returncode, json.loads(result.stdout), result.stderr

    def failed(self, report: dict) -> list[str]:
        return [check['check'] for check in report['checks'] if not check['ok']]

    def refs(self) -> str:
        return git(self.repository, 'for-each-ref', '--format=%(refname) %(objectname)')

    def test_ready_broker_exits_zero_with_main_equal_to_the_remote_and_writes_nothing(self):
        before = self.refs()
        code, report, _ = self.preflight('--key', str(self.key))
        self.assertEqual((code, report['state'], self.failed(report)), (0, 'ready', []))
        self.assertEqual([check['check'] for check in report['checks']], ['repository_canonical', 'repository_private',
                         'git_metadata_private', 'deploy_key', 'main_matches_origin', 'push_dry_run'])
        local = git(self.repository, 'rev-parse', 'main')
        self.assertEqual(local, git(self.repository, 'ls-remote', 'origin', 'refs/heads/main').split()[0])
        self.assertIn(f'main={local} origin/main={local}', json.dumps(report))
        self.assertEqual(self.refs(), before)
        self.assertNotIn('zz-canary-placeholder', json.dumps(report))
        piped = subprocess.run([sys.executable, '-', '--repository', str(self.repository), '--uid', str(os.getuid())],
                               input=SCRIPT.read_text(), capture_output=True, text=True, timeout=120, check=False)
        self.assertEqual(piped.returncode, 0, piped.stderr)

    def test_public_root_writable_metadata_or_a_foreign_owner_fail(self):
        self.repository.chmod(0o755)
        code, report, stderr = self.preflight()
        self.assertEqual((code, self.failed(report)), (1, ['repository_private']))
        self.assertIn('repository_private', stderr)
        self.repository.chmod(0o700)
        (self.repository / '.git').chmod(0o777)
        self.assertEqual(self.failed(self.preflight()[1]), ['git_metadata_private'])
        (self.repository / '.git').chmod(0o755)
        foreign = subprocess.run([sys.executable, str(SCRIPT), '--repository', str(self.repository), '--uid', str(os.getuid() + 1)],
                                 capture_output=True, text=True, timeout=120, check=False)
        self.assertEqual(foreign.returncode, 1)
        self.assertEqual(self.failed(json.loads(foreign.stdout)), ['repository_private', 'git_metadata_private'])

    def test_missing_or_public_deploy_key_fails(self):
        git(self.repository, 'config', '--unset', 'core.sshCommand')
        self.assertEqual(self.failed(self.preflight()[1]), ['deploy_key'])
        git(self.repository, 'config', 'core.sshCommand', f'ssh -i {self.key}')
        self.key.chmod(0o644)
        self.assertEqual(self.failed(self.preflight()[1]), ['deploy_key'])
        self.key.chmod(0o600)
        self.assertEqual(self.failed(self.preflight('--key', '/run/cauce-context-git/id_ed25519')[1]), ['deploy_key'])

    def test_divergent_or_unreachable_remote_fails(self):
        git(self.root, 'clone', '--quiet', str(self.remote), str(self.outsider))
        git(self.outsider, 'commit', '--quiet', '--allow-empty', '-m', 'Outsider advances the remote')
        git(self.outsider, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main')
        self.assertEqual(self.failed(self.preflight()[1]), ['main_matches_origin', 'push_dry_run'])
        git(self.repository, 'fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main')
        git(self.repository, 'merge', '--quiet', '--ff-only', 'refs/remotes/origin/main')
        self.assertEqual(self.preflight()[0], 0)
        git(self.repository, 'commit', '--quiet', '--allow-empty', '-m', 'Local commit not yet pushed')
        self.assertEqual(self.failed(self.preflight()[1]), ['main_matches_origin'])
        git(self.repository, 'remote', 'set-url', 'origin', str(self.root / 'unreachable.git'))
        self.assertEqual(self.failed(self.preflight()[1]), ['main_matches_origin', 'push_dry_run'])


if __name__ == '__main__':
    unittest.main()
