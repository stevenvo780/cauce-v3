import base64
import importlib.util
import json
import os
import pathlib
import stat
import subprocess
import tempfile
import time
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
        self.assertEqual(report['error_code'], 'rate_limited')

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
        limited = self.claude({}, http_status=429)
        self.assertTrue(limited['rateLimited'])
        self.assertEqual(limited['error_code'], 'rate_limited')
        report = self.claude({}, expires_at=1)
        self.assertFalse(report['ok'])
        self.assertIn('caducado', report['nota'])
        self.assertEqual(report['error_code'], 'token_expired')

    def run_reader(self, home, script, stub_text, *args):
        stub = home / 'fetch.mjs'
        stub.write_text(stub_text)
        return subprocess.run(['node', '--import', str(stub), str(ROOT / 'cuotas' / script), *args],
                              env={**os.environ, 'HOME': str(home)}, capture_output=True, text=True, timeout=15, check=True)

    CLAUDE_REFRESH_STUB = (
        'globalThis.fetch=async(url,options={})=>{'
        'if(url.includes("/oauth/token")){const body=JSON.parse(options.body);'
        'if(body.refresh_token!=="fixture-refresh-old")throw Error("wrong refresh token");'
        'return new Response(JSON.stringify({access_token:"fixture-token-new",refresh_token:"fixture-refresh-new",'
        'expires_in:28800,scope:"user:inference"}),{status:200});}'
        'if(options.headers.authorization!=="Bearer fixture-token-new")return new Response("{}",{status:401});'
        'return new Response(JSON.stringify(url.endsWith("/usage")?{five_hour:{utilization:10}}'
        ':{account:{has_claude_max:true}}),{status:200});};')

    def claude_home(self, directory, expires_at):
        home = pathlib.Path(directory)
        (home / '.claude').mkdir()
        auth = home / '.claude' / '.credentials.json'
        auth.write_text(json.dumps({'claudeAiOauth': {'accessToken': 'fixture-token-old',
                                                       'refreshToken': 'fixture-refresh-old', 'expiresAt': expires_at}}))
        auth.chmod(0o600)
        return home, auth

    def test_claude_expired_token_refreshes_only_with_own_session_flag(self):
        with tempfile.TemporaryDirectory() as directory:
            home, auth = self.claude_home(directory, 1)
            response = self.run_reader(home, 'leer-cuota.mjs', self.CLAUDE_REFRESH_STUB, '--refresh-own-session')
            saved = json.loads(auth.read_text())
            self.assertEqual(saved['claudeAiOauth']['accessToken'], 'fixture-token-new')
            self.assertEqual(saved['claudeAiOauth']['refreshToken'], 'fixture-refresh-new')
            self.assertEqual(stat.S_IMODE(auth.stat().st_mode), 0o600)
            self.assertEqual(list((home / '.claude').glob('*.tmp*')), [])
        report = json.loads(response.stdout)
        self.assertTrue(report['ok'])
        for secret in ('fixture-token-old', 'fixture-token-new', 'fixture-refresh-old', 'fixture-refresh-new'):
            self.assertNotIn(secret, response.stdout)
            self.assertNotIn(secret, response.stderr)

    def test_claude_rejected_token_refreshes_once_with_flag_and_retries(self):
        with tempfile.TemporaryDirectory() as directory:
            home, auth = self.claude_home(directory, 9_999_999_999_999)
            response = self.run_reader(home, 'leer-cuota.mjs', self.CLAUDE_REFRESH_STUB, '--refresh-own-session')
            self.assertEqual(json.loads(auth.read_text())['claudeAiOauth']['accessToken'], 'fixture-token-new')
        self.assertTrue(json.loads(response.stdout)['ok'])

    def test_claude_failed_refresh_keeps_the_credential_and_reports_token_expired(self):
        with tempfile.TemporaryDirectory() as directory:
            home, auth = self.claude_home(directory, 1)
            before = auth.read_bytes()
            stub = ('globalThis.fetch=async(url)=>{if(url.includes("/oauth/token"))'
                    'return new Response(JSON.stringify({error:"invalid_grant"}),{status:400});'
                    'throw Error("usage must not run after a failed refresh")};')
            response = self.run_reader(home, 'leer-cuota.mjs', stub, '--refresh-own-session')
            self.assertEqual(auth.read_bytes(), before)
            self.assertEqual(list((home / '.claude').glob('*.tmp*')), [])
        report = json.loads(response.stdout)
        self.assertFalse(report['ok'])
        self.assertEqual(report['error_code'], 'token_expired')
        self.assertNotIn('fixture-refresh-old', response.stdout)
        self.assertNotIn('fixture-refresh-old', response.stderr)

    def test_claude_valid_token_never_refreshes_even_with_flag(self):
        with tempfile.TemporaryDirectory() as directory:
            home, auth = self.claude_home(directory, 9_999_999_999_999)
            before = auth.read_bytes()
            stub = ('globalThis.fetch=async(url,options={})=>{if(url.includes("/oauth/token"))throw Error("refresh forbidden");'
                    'if(options.headers.authorization!=="Bearer fixture-token-old")return new Response("{}",{status:401});'
                    'return new Response(JSON.stringify(url.endsWith("/usage")?{five_hour:{utilization:4}}'
                    ':{account:{has_claude_pro:true}}),{status:200});};')
            response = self.run_reader(home, 'leer-cuota.mjs', stub, '--refresh-own-session')
            self.assertEqual(auth.read_bytes(), before)
        self.assertTrue(json.loads(response.stdout)['ok'])

    def test_grok_401_refreshes_only_with_own_session_flag(self):
        stub = (
            'globalThis.fetch=async(url,options={})=>{'
            'if(url.endsWith("/.well-known/openid-configuration"))return new Response('
            'JSON.stringify({token_endpoint:"https://auth.fixture.invalid/oauth/token"}),{status:200});'
            'if(url==="https://auth.fixture.invalid/oauth/token"){const body=new URLSearchParams(options.body);'
            'if(body.get("refresh_token")!=="fixture-refresh-old")throw Error("wrong refresh token");'
            'return new Response(JSON.stringify({access_token:"fixture-token-new",refresh_token:"fixture-refresh-new",'
            'expires_in:21600}),{status:200});}'
            'if(options.headers.authorization!=="Bearer fixture-token-new")return new Response("{}",{status:401});'
            'return new Response(JSON.stringify({config:{creditUsagePercent:20,currentPeriod:{type:"weekly",'
            'start:"2026-10-01T00:00:00Z",end:"2026-10-08T00:00:00Z"}}}),{status:200});};')
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory)
            (home / '.grok').mkdir()
            auth = home / '.grok' / 'auth.json'
            auth.write_text(json.dumps({'fixture': {'key': 'fixture-token-old', 'refresh_token': 'fixture-refresh-old',
                                                     'oidc_issuer': 'https://auth.fixture.invalid', 'oidc_client_id': 'fixture-client'}}))
            auth.chmod(0o600)
            without_flag = json.loads(self.run_reader(home, 'leer-cuota-grok.mjs', stub).stdout)
            self.assertEqual(without_flag['error_code'], 'token_expired')
            self.assertEqual(json.loads(auth.read_text())['fixture']['key'], 'fixture-token-old')
            response = self.run_reader(home, 'leer-cuota-grok.mjs', stub, '--refresh-own-session')
            saved = json.loads(auth.read_text())['fixture']
            self.assertEqual(saved['key'], 'fixture-token-new')
            self.assertEqual(saved['refresh_token'], 'fixture-refresh-new')
            self.assertEqual(stat.S_IMODE(auth.stat().st_mode), 0o600)
            self.assertEqual(list((home / '.grok').glob('*.tmp*')), [])
        self.assertTrue(json.loads(response.stdout)['ok'])
        for secret in ('fixture-token-old', 'fixture-token-new', 'fixture-refresh-old', 'fixture-refresh-new'):
            self.assertNotIn(secret, response.stdout)
            self.assertNotIn(secret, response.stderr)

    @staticmethod
    def jwt(payload):
        segment = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip('=')
        return f'fixture.{segment}.fixture'

    def codex_home(self, directory, expires_in):
        home = pathlib.Path(directory)
        access = self.jwt({'exp': int(time.time()) + expires_in, 'client_id': 'fixture-client'})
        auth = home / 'auth.json'
        auth.write_text(json.dumps({'tokens': {'access_token': access, 'refresh_token': 'fixture-refresh-old',
                                                'account_id': 'fixture-seat'}}))
        auth.chmod(0o600)
        return auth, access

    def test_codex_expired_token_refreshes_atomically_only_with_flag(self):
        usage = {'rate_limit': {'primary_window': {'used_percent': 5, 'limit_window_seconds': 604800}}}
        renewed = self.jwt({'exp': int(time.time()) + 9 * 86400, 'client_id': 'fixture-client'})
        with tempfile.TemporaryDirectory() as directory:
            auth, expired = self.codex_home(directory, -3600)
            with patch.object(probe, 'pedir') as request, patch.object(probe, 'pedir_refresco') as refresh:
                denied = probe.sonda(directory)
            request.assert_not_called()
            refresh.assert_not_called()
            self.assertEqual(denied['error_code'], 'token_expired')
            self.assertIn('vencido', denied['error'])
            with patch.object(probe, 'pedir', return_value=usage) as request, patch.object(
                    probe, 'pedir_refresco', return_value={'access_token': renewed, 'refresh_token': 'fixture-refresh-new'}) as refresh:
                report = probe.sonda(directory, refresh=True)
            refresh.assert_called_once_with('fixture-refresh-old', 'fixture-client')
            self.assertEqual(request.call_args.args[1], renewed)
            saved = json.loads(auth.read_text())
            self.assertEqual(saved['tokens']['access_token'], renewed)
            self.assertEqual(saved['tokens']['refresh_token'], 'fixture-refresh-new')
            self.assertEqual(stat.S_IMODE(auth.stat().st_mode), 0o600)
        self.assertIsNone(report['error'])
        for secret in (expired, renewed, 'fixture-refresh-old', 'fixture-refresh-new'):
            self.assertNotIn(secret, json.dumps(report))

    def test_codex_valid_token_never_refreshes_even_with_flag(self):
        usage = {'rate_limit': {'primary_window': {'used_percent': 5, 'limit_window_seconds': 604800}}}
        with tempfile.TemporaryDirectory() as directory:
            auth, _ = self.codex_home(directory, 9 * 86400)
            before = auth.read_bytes()
            with patch.object(probe, 'pedir', return_value=usage), patch.object(probe, 'pedir_refresco') as refresh:
                report = probe.sonda(directory, refresh=True)
            refresh.assert_not_called()
            self.assertEqual(auth.read_bytes(), before)
        self.assertIsNone(report['error'])

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
        self.assertEqual(json.loads(response.stdout)['error_code'], 'token_expired')
        self.assertNotIn('fixture-token', response.stdout)
        self.assertNotIn('fixture-refresh', response.stdout)


if __name__ == '__main__':
    unittest.main()
