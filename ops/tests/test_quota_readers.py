import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('codex_quota_probe', ROOT / 'cuotas' / 'codex-http-probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class QuotaReadersTest(unittest.TestCase):
    def test_codex_preserves_additional_limits_and_real_durations_without_refresh(self):
        usage = {'rate_limit': {'primary_window': {'used_percent': 8, 'limit_window_seconds': 604800}},
                 'additional_rate_limits': [{'limit_id': 'spark', 'limit_name': 'Spark', 'model': 'codex-spark',
                                             'rate_limit': {'primary_window': {'used_percent': 31, 'limit_window_seconds': 18000}}}]}
        with tempfile.TemporaryDirectory() as directory:
            auth = pathlib.Path(directory) / 'auth.json'
            auth.write_text(json.dumps({'tokens': {'access_token': 'fixture-token', 'account_id': 'fixture-seat'}}))
            before = auth.read_bytes()
            with patch.object(probe, 'pedir', return_value=usage):
                report = probe.sonda(directory)
            self.assertEqual(auth.read_bytes(), before)
        self.assertEqual(report['ventanas'][0]['windowMinutes'], 10080)
        extra = report['ventanas'][1]
        self.assertEqual((extra['clave'], extra['key'], extra['limitId'], extra['model']), ('Spark:5h', '5h', 'spark', 'codex-spark'))
        self.assertIsNone(extra['reset_at'])
        self.assertNotIn('fixture-token', json.dumps(report))

    def test_codex_429_keeps_windows_unknown_and_does_not_mutate_auth(self):
        with tempfile.TemporaryDirectory() as directory:
            auth = pathlib.Path(directory) / 'auth.json'
            auth.write_text(json.dumps({'tokens': {'access_token': 'fixture-token', 'account_id': 'fixture-seat'}}))
            before = auth.read_bytes()
            with patch.object(probe, 'pedir', side_effect=urllib.error.HTTPError('https://fixture.invalid', 429, 'limit', {}, None)):
                report = probe.sonda(directory)
            self.assertEqual(auth.read_bytes(), before)
        self.assertEqual(report['ventanas'], [])
        self.assertEqual(report['extra']['http_status'], 429)

    def claude(self, usage, http_status=200, expires_at=9_999_999_999_999):
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory)
            (home / '.claude').mkdir()
            auth = home / '.claude' / '.credentials.json'
            auth.write_text(json.dumps({'claudeAiOauth': {'accessToken': 'fixture-token', 'refreshToken': 'fixture-refresh', 'expiresAt': expires_at}}))
            before = auth.read_bytes()
            stub = home / 'fetch.mjs'
            stub.write_text('globalThis.fetch=async(url,options)=>{if(options.method && options.method!=="GET")throw Error("refresh forbidden");'
                            'return new Response(JSON.stringify(url.endsWith("/usage")?' + json.dumps(usage) +
                            ':{account:{has_claude_max:true}}),{status:' + str(http_status) + ',headers:{"retry-after":"8"}})};')
            response = subprocess.run(['node', '--import', str(stub), str(ROOT / 'cuotas' / 'leer-cuota.mjs')],
                                      env={**os.environ, 'HOME': directory}, capture_output=True, text=True, timeout=15, check=True)
            self.assertEqual(auth.read_bytes(), before)
            self.assertNotIn('fixture-token', response.stdout)
            self.assertNotIn('fixture-refresh', response.stdout)
            return json.loads(response.stdout)

    def test_claude_preserves_model_windows_and_nullable_resets(self):
        report = self.claude({'five_hour': {'utilization': 12, 'resets_at': None}, 'seven_day': {'utilization': 3},
                             'seven_day_sonnet': {'utilization': 86}, 'seven_day_opus': {'utilization': 97}, 'seven_day_oauth_apps': None})
        self.assertTrue(report['ok'])
        self.assertEqual(len(report['windows']), 4)
        self.assertEqual([row['model'] for row in report['windows']], [None, None, 'sonnet', 'opus'])
        self.assertEqual(report['windows'][0]['windowMinutes'], 300)
        self.assertTrue(all(row['resetAt'] is None for row in report['windows']))

    def test_claude_weekly_composition_does_not_become_a_quota_window(self):
        report = self.claude({
            'five_hour': {'utilization': 0, 'resets_at': None},
            'seven_day': {'utilization': 93, 'resets_at': None},
            'seven_day_breakdown': {'as_of': 'snapshot', 'window_started_at': 'start', 'rows': [
                {'key': 'work', 'display_name': 'Work', 'percent': 100},
                {'key': 'other', 'display_name': 'Other', 'percent': 0}]},
            'limits': [{'kind': 'unknown', 'group': 'unknown', 'percent': 100, 'scope': None}],
            'weekly_scoped_shares': [{'limit_index': 0, 'used_percent_of_weekly': 0,
                                      'allowance_percent_of_weekly': 50}],
        })
        self.assertTrue(report['ok'])
        self.assertEqual([(row['key'], row['usedPercent']) for row in report['windows']], [('5h', 0), ('7d', 93)])

    def test_claude_composition_is_never_a_window_even_with_utilization(self):
        report = self.claude({'seven_day': {'utilization': 4},
                             'seven_day_breakdown': {'utilization': 100, 'rows': [{'percent': 100}]}})
        self.assertEqual([(row['key'], row['usedPercent']) for row in report['windows']], [('7d', 4)])

    def test_claude_model_windows_require_numeric_utilization(self):
        report = self.claude({'five_hour': {}, 'seven_day': {'utilization': None},
                             'seven_day_sonnet': {'utilization': 0}, 'seven_day_opus': {'utilization': 97},
                             'seven_day_haiku': {'utilization': '100'}, 'seven_day_oauth_apps': {},
                             'seven_day_cowork': {'utilization': True}, 'seven_day_omelette': []})
        self.assertEqual([(row['key'], row['usedPercent']) for row in report['windows']],
                         [('5h', None), ('7d', None), ('seven_day_sonnet', 0), ('seven_day_opus', 97)])
        self.assertEqual([row['status'] for row in report['windows']], ['unknown', 'unknown', 'ok', 'ok'])

    def test_claude_429_and_expired_token_are_errors_without_refresh(self):
        self.assertTrue(self.claude({}, http_status=429)['rateLimited'])
        report = self.claude({}, expires_at=1)
        self.assertFalse(report['ok'])
        self.assertIn('caducado', report['nota'])

    def test_grok_401_does_not_refresh_or_rewrite_the_session(self):
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory)
            (home / '.grok').mkdir()
            auth = home / '.grok' / 'auth.json'
            auth.write_text(json.dumps({'fixture': {'key': 'fixture-token', 'refresh_token': 'fixture-refresh'}}))
            before = auth.read_bytes()
            stub = home / 'fetch.mjs'
            stub.write_text('globalThis.fetch=async(url)=>{if(!url.startsWith("https://cli-chat-proxy.grok.com/v1/billing"))'
                            'throw Error("refresh forbidden");return new Response("{}",{status:401})};')
            response = subprocess.run(['node', '--import', str(stub), str(ROOT / 'cuotas' / 'leer-cuota-grok.mjs')],
                                      env={**os.environ, 'HOME': directory}, capture_output=True, text=True, timeout=15, check=True)
            self.assertEqual(auth.read_bytes(), before)
        self.assertIn('HTTP 401', json.loads(response.stdout)['nota'])
        self.assertNotIn('fixture-token', response.stdout)
        self.assertNotIn('fixture-refresh', response.stdout)


if __name__ == '__main__':
    unittest.main()
