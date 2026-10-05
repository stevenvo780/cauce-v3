import importlib.util
import json
import os
import pwd
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HELPER = Path(__file__).resolve().parents[1] / 'launcher_write_journal.py'


class LauncherWriteJournal(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('launcher_write_journal', HELPER)
        cls.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.helper)

    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.root = Path(self.scratch.name)
        self.root.chmod(0o700)

    def tearDown(self):
        self.scratch.cleanup()

    def mounts(self, kind='bind', writable=True):
        return [{'Destination': str(self.root), 'Type': kind, 'RW': writable}]

    def test_persistent_mount_and_retry_preserve_records(self):
        path = self.helper.provision_journal(str(self.root), ['pty-governance-journal', 'a' * 64], self.mounts())
        receipt = Path(path) / 'own-receipt.json'
        receipt.write_text('{"state":"writing"}')
        repeated = self.helper.provision_journal(str(self.root), ['pty-governance-journal', 'a' * 64], self.mounts())
        self.assertEqual(path, repeated)
        self.assertEqual(receipt.read_text(), '{"state":"writing"}')
        self.assertEqual(stat.S_IMODE(Path(path).stat().st_mode), 0o700)
        self.assertEqual(Path(path).stat().st_uid, os.geteuid())

    def test_more_specific_unsafe_mount_overrides_persistent_parent(self):
        for mount in [{'Destination': str(self.root / 'pty-governance-journal'), 'Type': 'tmpfs', 'RW': True},
                      {'Destination': str(self.root), 'Type': 'volume', 'RW': False}]:
            with self.subTest(mount=mount), self.assertRaises(ValueError):
                self.helper.provision_journal(str(self.root), ['pty-governance-journal', 'scope'], self.mounts() + [mount])
        self.assertFalse((self.root / 'pty-governance-journal').exists())

    def test_nonpersistent_missing_and_readonly_mounts_rejected_before_creation(self):
        for mounts in [[], self.mounts('tmpfs'), self.mounts('overlay'), self.mounts('bind', False)]:
            with self.subTest(mounts=mounts), self.assertRaises(ValueError):
                self.helper.provision_journal(str(self.root), ['journal'], mounts)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_symlink_permissions_and_foreign_owner_rejected_without_repair(self):
        foreign = self.root / 'foreign'
        foreign.mkdir(mode=0o755)
        foreign.chmod(0o755)
        (self.root / 'journal').symlink_to(foreign, target_is_directory=True)
        with self.assertRaises((ValueError, OSError)):
            self.helper.provision_journal(str(self.root), ['journal'])
        (self.root / 'journal').unlink()
        with self.assertRaises(ValueError):
            self.helper.provision_journal(str(self.root), ['foreign'])
        self.assertEqual(stat.S_IMODE(foreign.stat().st_mode), 0o755)
        with patch.object(self.helper.os, 'geteuid', return_value=os.geteuid() + 1), self.assertRaises(ValueError):
            self.helper.provision_journal(str(self.root), ['journal'])
        self.assertFalse((self.root / 'journal').exists())

    def test_failure_removes_only_new_empty_directories(self):
        existing = self.root / 'existing'
        existing.mkdir(mode=0o700)
        record = existing / 'retained'
        record.write_text('own existing evidence')
        original = self.helper.os.fsync
        count = 0

        def fail_after_creation(fd):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError('fixture fsync failure')
            original(fd)

        with patch.object(self.helper.os, 'fsync', side_effect=fail_after_creation), self.assertRaises(OSError):
            self.helper.provision_journal(str(self.root), ['existing', 'new', 'leaf'])
        self.assertEqual(record.read_text(), 'own existing evidence')
        self.assertFalse((existing / 'new').exists())

    def test_host_alias_scopes_are_disjoint_and_cli_outputs_only_path(self):
        a = self.helper.provision_journal(str(self.root), ['.local', 'state', 'cauce-v3', 'pty-governance-journal', 'argos'])
        b = self.helper.provision_journal(str(self.root), ['.local', 'state', 'cauce-v3', 'pty-governance-journal', 'kant'])
        self.assertNotEqual(a, b)
        self.assertTrue(Path(a).is_dir())
        self.assertTrue(Path(b).is_dir())
        self.assertEqual(json.loads(json.dumps(self.mounts()))[0]['RW'], True)

    def test_host_container_identity_and_alias_keep_persistent_scopes_separate(self):
        a = self.helper.provision_host_journal(str(self.root), 'argos', 'host:qa-a')
        b = self.helper.provision_host_journal(str(self.root), 'argos', 'host:qa-b')
        c = self.helper.provision_host_journal(str(self.root), 'kant', 'host:qa-a')
        self.assertEqual(a, self.helper.provision_host_journal(str(self.root), 'argos', 'host:qa-a'))
        self.assertEqual(len({a, b, c}), 3)
        with self.assertRaises(ValueError):
            self.helper.provision_host_journal(str(self.root), '../foreign', 'host:qa-a')

    def test_launcher_execs_provisioner_as_mapped_runtime_user(self):
        control = self.root / 'control.py'
        calls = self.root / 'calls.json'
        control.write_text("import json,os,subprocess,sys\n"
            "args=sys.argv[1:]\n"
            "if args[0]=='inspect': print(os.environ['FIXTURE_MOUNTS'])\n"
            "else:\n"
            " open(os.environ['FIXTURE_CALLS'],'w').write(json.dumps(args))\n"
            " result=subprocess.run([sys.executable,'-',*args[-3:]],input=sys.stdin.read(),text=True,capture_output=True)\n"
            " sys.stdout.write(result.stdout);sys.stderr.write(result.stderr);sys.exit(result.returncode)\n")
        launcher = HELPER.with_name('cauce-pty-launcher.sh').read_text()
        begin = launcher.index('prepare_governance_journal() {')
        end = launcher.index('\n}\n', begin) + 3
        command = 'die() { echo "$1" >&2; exit "${2:-2}"; }; docker_control() { "$FIXTURE_PYTHON" "$FIXTURE_CONTROL" "$@"; }; '
        command += launcher[begin:end] + '\nprepare_governance_journal; printf "%s" "$governance_journal_dir"'
        container = 'a' * 64
        environment = {**os.environ, 'FIXTURE_CONTROL': str(control), 'FIXTURE_CALLS': str(calls),
                       'FIXTURE_PYTHON': sys.executable, 'FIXTURE_MOUNTS': json.dumps(self.mounts()),
                       'container_id': container, 'runtime_uid': str(os.geteuid()), 'runtime_gid': str(os.getegid()),
                       'state_directory': str(self.root), 'JOURNAL_SOURCE': str(HELPER)}
        result = subprocess.run(['bash', '-c', command], env=environment, capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout, str(self.root / 'pty-governance-journal' / container))
        self.assertEqual(json.loads(calls.read_text())[:4], ['exec', '-i', '--user', f'{os.geteuid()}:{os.getegid()}'])

    def test_actual_container_provisioner_and_bundle_serializer_keep_the_same_path(self):
        container = 'b' * 64
        result = subprocess.run([sys.executable, str(HELPER), str(self.root), container, json.dumps(self.mounts())],
                                capture_output=True, text=True, check=True)
        journal = result.stdout.strip()
        launcher = HELPER.with_name('cauce-pty-launcher.sh').read_text()
        begin = launcher.index('import json, os, sys', launcher.index('publish_bundle() {'))
        end = launcher.index('\nPYTHON', begin)
        pki = self.root / 'fixture-pki'
        pki.mkdir(mode=0o700)
        for name in ['client.crt', 'client.key', 'ca.crt']:
            (pki / name).write_text('synthetic fixture material')
        key = pki / 'alias-key.hex'
        key.write_text('a' * 64)
        values = {'TENANT': 'Steven', 'ALIAS': 'argos', 'CONTAINER': container, 'GENERATION': 'runtime-a',
                  'IMAGE': 'sha256:' + 'c' * 64, 'USER': 'fixture', 'UID': str(os.geteuid()), 'GID': str(os.getegid()),
                  'HOME': str(self.root), 'HARNESS': 'claude', 'RELAY_HOST': 'localhost', 'RELAY_PORT': '443',
                  'PKI_DIR': str(pki), 'KEY_FILE': str(key), 'SHELLS': '[]', 'HARNESS_COMMAND': 'null',
                  'TMUX_TUI': 'null', 'OPENCLAW_TUI': 'null', 'RUNTIME_FACTS': '{}', 'VERSION': 'fixture',
                  'JOURNAL': journal}
        environment = {**os.environ, **{'CAUCE_PTY_BUNDLE_' + name: value for name, value in values.items()}}
        encoded = subprocess.run([sys.executable, '-c', launcher[begin:end]], env=environment,
                                 capture_output=True, text=True, check=True)
        bundle = json.loads(encoded.stdout)
        self.assertEqual(bundle['governance_journal_dir'], journal)
        self.assertEqual(Path(journal).stat().st_uid, int(bundle['runtime_uid']))
        self.assertEqual(stat.S_IMODE(Path(journal).stat().st_mode), 0o700)
        self.assertEqual(result.stderr, '')

    def test_failed_fsync_closes_fds_and_preserves_replaced_directory(self):
        before = len(os.listdir('/proc/self/fd'))
        foreign = self.root / 'retained'
        foreign.mkdir(mode=0o700)
        record = foreign / 'record'
        record.write_text('prior evidence')
        original = self.helper.os.fsync
        changed = False

        def replace_then_fail(fd):
            nonlocal changed
            if not changed:
                changed = True
                (self.root / 'new').rename(self.root / 'original-new')
                foreign.rename(self.root / 'new')
                raise OSError('fixture replacement after creation')
            original(fd)

        with patch.object(self.helper.os, 'fsync', side_effect=replace_then_fail), self.assertRaises(OSError):
            self.helper.provision_journal(str(self.root), ['new'])
        self.assertEqual((self.root / 'new/record').read_text(), 'prior evidence')
        self.assertTrue((self.root / 'original-new').is_dir())
        self.assertEqual(len(os.listdir('/proc/self/fd')), before)


def runtime_control(method):
    def run(self):
        if os.geteuid() != 0:
            return method(self)
        account = pwd.getpwnam('nobody')
        with tempfile.TemporaryDirectory() as scratch:
            base = Path(scratch)
            root = base / 'pty-agent'
            tests = root / 'tests'
            tests.mkdir(parents=True)
            for source, destination in [(HELPER, root / HELPER.name),
                                        (HELPER.with_name('cauce-pty-launcher.sh'), root / 'cauce-pty-launcher.sh'),
                                        (Path(__file__), tests / Path(__file__).name)]:
                shutil.copyfile(source, destination)
            for path in [base, *base.rglob('*')]:
                path.chmod(0o700 if path.is_dir() else 0o600)
                os.chown(path, account.pw_uid, account.pw_gid)
            result = subprocess.run([sys.executable, str(tests / Path(__file__).name), '-k', method.__name__],
                                    user=account.pw_uid, group=account.pw_gid, extra_groups=[],
                                    env={'PATH': '/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE': '1'},
                                    capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
    return run


for _name in dir(LauncherWriteJournal):
    if _name.startswith('test_'):
        setattr(LauncherWriteJournal, _name, runtime_control(getattr(LauncherWriteJournal, _name)))


if __name__ == '__main__':
    unittest.main()
