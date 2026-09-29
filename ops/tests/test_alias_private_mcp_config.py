#!/usr/bin/env python3
import pathlib
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'scripts/container-adapter-supervisor.sh'
FUNCTION = SCRIPT.read_text().split('ensure_isolated_config() {', 1)[1].split('\n}\n', 1)[0]
PROGRAM = FUNCTION.split("/usr/bin/python3 -c '\n", 1)[1].split("\n' \"$destination\"", 1)[0]


class PrivateMcpConfig(unittest.TestCase):
    def test_alias_config_accepts_private_file_and_rejects_unsafe_replacements(self):
        for harness, identity, first, second in [
            ('codex', 'AGENTS.md', 'config.toml', 'auth.json'),
            ('claude', 'CLAUDE.md', '.credentials.json', '.claude.json'),
        ]:
            with self.subTest(harness=harness), tempfile.TemporaryDirectory() as temporary:
                root = pathlib.Path(temporary)
                source, destination = root / 'shared', root / 'alias'
                source.mkdir(mode=0o700)
                destination.mkdir(mode=0o700)
                for name in (identity, first, second):
                    (destination / name).write_text('{}')
                    (destination / name).chmod(0o600)
                command = [sys.executable, '-c', PROGRAM, str(destination), str(source),
                           harness, identity, first, second, 'settings.json']
                self.assertEqual(subprocess.run(command, check=False).returncode, 0)
                config = destination / (first if harness == 'codex' else second)
                config.chmod(0o666)
                self.assertNotEqual(subprocess.run(command, check=False).returncode, 0)
                config.unlink()
                foreign = root / 'foreign'
                foreign.write_text('{}')
                foreign.chmod(0o600)
                config.symlink_to(foreign)
                self.assertNotEqual(subprocess.run(command, check=False).returncode, 0)


if __name__ == '__main__':
    unittest.main()
