#!/usr/bin/env python3
"""Quota freshness, account separation and missing-value regressions."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'ai-live-to-usage.py'
SPEC = importlib.util.spec_from_file_location('ai_live_to_usage', SCRIPT)
BRIDGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BRIDGE)


def account(email='first@example.test', **changes):
    return {'provider': 'claude', 'label': 'claude#1', 'email': email,
            'ok': True, 'fetched_at': 1000, 'libre_5h': 75, **changes}


class QuotaBridgeTest(unittest.TestCase):
    def test_missing_stale_and_future_observations_are_not_republished(self):
        for stamp in (None, 500, 1100, float('nan')):
            with self.subTest(stamp=stamp):
                report = BRIDGE.normalize({'cuentas': [account(fetched_at=stamp)]}, 1050, 180)
                provider = report['providers']['claude']
                self.assertFalse(provider['ok'])
                self.assertEqual(provider['windows'], [])

    def test_accounts_keep_separate_groups_and_oldest_actual_observation(self):
        report = BRIDGE.normalize({'cuentas': [account(), account('second@example.test',
                                  label='claude#2', fetched_at=1020, libre_5h=0)]}, 1050, 180)
        provider = report['providers']['claude']
        self.assertEqual({window['limitId'] for window in provider['windows']}, {'first', 'second'})
        self.assertEqual(provider['observedAt'], '1970-01-01T00:16:40Z')
        self.assertEqual(provider['windows'][1]['remainingPercent'], 0)

    def test_null_usage_is_not_reported_as_full_balance(self):
        report = BRIDGE.normalize({'cuentas': [account(libre_5h=None, libre_7d=None)]}, 1050, 180)
        provider = report['providers']['claude']
        self.assertFalse(provider['available'])
        self.assertEqual(provider['windows'], [])
        self.assertIn('sin ventanas válidas', provider['note'])

    def test_error_with_old_windows_does_not_contribute_quota(self):
        report = BRIDGE.normalize({'cuentas': [account(), account('second@example.test',
                                  ok=False, note='HTTP 429', libre_5h=100)]}, 1050, 180)
        provider = report['providers']['claude']
        self.assertTrue(provider['ok'])
        self.assertEqual(len(provider['windows']), 1)
        self.assertIn('HTTP 429', provider['note'])

    def test_extra_windows_and_invalid_percentages(self):
        windows = [{'key': 'model-week', 'usedPercent': 100, 'model': 'example'},
                   *({'key': 'invalid', 'remainingPercent': value}
                     for value in [True, float('nan'), float('inf'), -1, 101])]
        report = BRIDGE.normalize({'cuentas': [account(windows=windows)]}, 1050, 180)
        actual = report['providers']['claude']['windows']
        self.assertEqual(len(actual), 1)
        self.assertEqual(actual[0]['model'], 'example')
        self.assertNotIn('remainingPercent', actual[0])

    def test_producer_failure_does_not_echo_private_stderr(self):
        with tempfile.TemporaryDirectory() as directory:
            producer = Path(directory) / 'producer'
            producer.write_text('#!/bin/sh\necho private-marker >&2\nexit 2\n')
            producer.chmod(0o700)
            result = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True,
                                    env={**os.environ, 'CAUCE_AI_LIVE_BIN': str(producer)}, check=False)
            self.assertEqual(result.returncode, 1)
            self.assertNotIn('private-marker', result.stderr)
            self.assertEqual(result.stdout, '')

    def test_cli_emits_json_for_current_measurement(self):
        with tempfile.TemporaryDirectory() as directory:
            producer = Path(directory) / 'producer'
            producer.write_text('#!/usr/bin/env python3\nimport json,time\n'
                                'print(json.dumps({"cuentas":[{"provider":"claude","ok":True,'
                                '"email":"first@example.test","libre_5h":42,"fetched_at":time.time()}]}))\n')
            producer.chmod(0o700)
            result = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True,
                                    env={**os.environ, 'CAUCE_AI_LIVE_BIN': str(producer)}, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            window = json.loads(result.stdout)['providers']['claude']['windows'][0]
            self.assertEqual(window['remainingPercent'], 42)
            self.assertEqual(window['limitId'], 'first')


if __name__ == '__main__':
    unittest.main()
