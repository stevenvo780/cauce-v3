import pathlib
import re
import subprocess
import unittest

DOCKERFILE = pathlib.Path(__file__).resolve().parents[1] / 'cuotas' / 'Dockerfile'


class CuotasDockerfileTest(unittest.TestCase):
    def setUp(self):
        self.text = DOCKERFILE.read_text()

    def test_base_image_is_pinned_by_digest(self):
        from_line = next(line for line in self.text.splitlines() if line.startswith('FROM '))
        self.assertRegex(from_line, r'^FROM node:22-slim@sha256:[a-f0-9]{64}$')

    def test_every_cli_is_pinned_to_an_exact_version(self):
        install = re.search(r'RUN npm install -g (.+?)\n && npm cache clean', self.text, re.S)
        self.assertIsNotNone(install, 'global npm install not found')
        packages = re.findall(r'"([^"]+)"', install.group(1))
        self.assertEqual(len(packages), 3)
        for package in packages:
            self.assertRegex(package, r'^@[\w-]+/[\w-]+@\$\{[A-Z_]+_VERSION\}$', package)
        self.assertNotIn('gemini', install.group(1))
        for argument, version in [('CLAUDE_CODE_VERSION', r'\d+\.\d+\.\d+'), ('CODEX_VERSION', r'\d+\.\d+\.\d+'),
                                  ('GROK_VERSION', r'\d+\.\d+\.\d+')]:
            self.assertRegex(self.text, rf'(?m)^ARG {argument}={version}$', argument)

    def test_no_floating_install_or_retired_refresh_script(self):
        self.assertNotIn('@latest', self.text)
        self.assertNotIn('GEMINI_CLI_VERSION', self.text)
        self.assertNotIn('codex-refrescar', self.text)
        self.assertIn('RUN chmod 0555 /usr/local/bin/codex-http-probe.py', self.text)
        helper = (DOCKERFILE.parent / 'cuota-auth').read_text()
        self.assertNotIn('NO_BROWSER=true', helper)
        self.assertIn('no tiene ejecutor', helper)

    def test_local_quota_image_grok_matches_the_dockerfile_pin(self):
        pin = re.search(r'(?m)^ARG GROK_VERSION=(\S+)$', self.text)
        self.assertIsNotNone(pin)
        probe = subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'grok',
                                'cauce-cuotas-test:local', '--version'], capture_output=True, text=True, timeout=90)
        self.assertEqual(probe.returncode, 0, probe.stderr)
        self.assertIn(pin.group(1), probe.stdout)


if __name__ == '__main__':
    unittest.main()
