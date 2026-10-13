import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'ops/scripts/harness-descriptor-approvals.py'
DESCRIPTORS = ROOT / 'packages/adapter-sdk/descriptors'


def run(*arguments):
    return subprocess.run([sys.executable, '-B', str(SCRIPT), *arguments], capture_output=True, text=True, timeout=30)


class HarnessDescriptorApprovalsTest(unittest.TestCase):
    def test_pins_exactly_the_named_descriptors_by_their_bytes(self):
        result = run('codex', 'grok')
        self.assertEqual(result.returncode, 0, result.stderr)
        pins = json.loads(result.stdout)
        self.assertEqual(sorted(pins), ['codex', 'grok'])
        for harness, pin in pins.items():
            self.assertEqual(pin, hashlib.sha256((DESCRIPTORS / f'{harness}.json').read_bytes()).hexdigest())
            self.assertIn(f'approve {harness} {pin}', result.stderr)
        self.assertEqual(json.loads(run().stdout), {})

    def test_rejects_unknown_invalid_or_repeated_harnesses_with_the_reason(self):
        with tempfile.TemporaryDirectory() as directory:
            descriptors = pathlib.Path(directory)
            (descriptors / 'broken.json').write_text(json.dumps({'schema_version': 1, 'harness': 'broken',
                'operations': {'execute': 'native-execution', 'quota': 'quota-collector'},
                'context': {'native_document': 'AGENTS.md', 'max_bytes': 4096}}))
            for arguments, reason in [(['ghost'], "no published descriptor declares 'ghost'"),
                                      (['broken'], 'provider.quota_argv: required when operations.quota is declared'),
                                      (['Codex'], 'must match'), (['codex', 'codex'], 'named twice')]:
                with self.subTest(arguments=arguments):
                    source = ['--descriptors', str(descriptors)] if arguments == ['broken'] else []
                    result = run(*arguments, *source)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(reason, result.stderr)
                    self.assertEqual(result.stdout, '')

    def test_writes_a_public_file_atomically_and_never_overwrites_by_accident(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / 'approvals.json'
            self.assertEqual(run('codex', '--output', str(output)).returncode, 0)
            self.assertEqual(output.stat().st_mode & 0o777, 0o644)
            first = output.read_bytes()
            refused = run('claude', '--output', str(output))
            self.assertNotEqual(refused.returncode, 0)
            self.assertIn('pass --replace', refused.stderr)
            self.assertEqual(output.read_bytes(), first)
            self.assertEqual(run('claude', '--output', str(output), '--replace').returncode, 0)
            self.assertEqual(sorted(json.loads(output.read_bytes())), ['claude'])
            self.assertEqual(sorted(path.name for path in pathlib.Path(directory).iterdir()), ['approvals.json'])
            self.assertNotEqual(run('codex', '--output', 'relative.json').returncode, 0)


if __name__ == '__main__':
    unittest.main()
