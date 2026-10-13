import pathlib
import re
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
        self.assertEqual(len(packages), 4)
        for package in packages:
            self.assertRegex(package, r'^@[\w-]+/[\w-]+@\$\{[A-Z_]+_VERSION\}$', package)
        for argument, version in [('CLAUDE_CODE_VERSION', r'\d+\.\d+\.\d+'), ('CODEX_VERSION', r'\d+\.\d+\.\d+'),
                                  ('GEMINI_CLI_VERSION', r'\d+\.\d+\.\d+'), ('GROK_VERSION', r'\d+\.\d+\.\d+')]:
            self.assertRegex(self.text, rf'(?m)^ARG {argument}={version}$', argument)

    def test_no_floating_install_or_retired_refresh_script(self):
        self.assertNotIn('@latest', self.text)
        self.assertNotIn('codex-refrescar', self.text)
        self.assertIn('RUN chmod 0555 /usr/local/bin/codex-http-probe.py', self.text)


if __name__ == '__main__':
    unittest.main()
