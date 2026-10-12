import base64
import contextlib
import fcntl
import importlib.util
import io
import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import threading
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

    def test_codex_account_key_comes_from_private_host_config_or_id_prefix(self):
        usage = {'rate_limit': {'primary_window': {'used_percent': 1, 'limit_window_seconds': 604800}}}
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory)
            (home / 'auth.json').write_text(json.dumps({'tokens': {'access_token': 'fixture-token', 'account_id': 'fixture-seat-1234'}}))
            private = home / 'account-keys.json'
            private.write_text(json.dumps({'fixture-seat-1234': 'fixture-key', 'bad': 7}))
            with patch.object(probe, 'pedir', return_value=usage):
                with patch.dict(os.environ, {'CAUCE_CODEX_ACCOUNT_KEYS_FILE': str(private)}):
                    self.assertEqual(probe.sonda(directory)['cuenta'], 'fixture-key')
                with patch.dict(os.environ, {}, clear=False):
                    os.environ.pop('CAUCE_CODEX_ACCOUNT_KEYS_FILE', None)
                    self.assertEqual(probe.sonda(directory)['cuenta'], 'codex-fixture-')
                with patch.dict(os.environ, {'CAUCE_CODEX_ACCOUNT_KEYS_FILE': str(home / 'missing.json')}):
                    self.assertEqual(probe.sonda(directory)['cuenta'], 'codex-fixture-')

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

    def test_claude_three_concurrent_readers_refresh_once_and_leave_no_orphans(self):
        stub = (
            'import {appendFileSync} from "node:fs";'
            'globalThis.fetch=async(url,options={})=>{'
            'if(url.includes("/oauth/token")){appendFileSync(process.env.HOME+"/refreshes",".");'
            'const body=JSON.parse(options.body);'
            'if(body.refresh_token!=="fixture-refresh-old")throw Error("second refresh with a rotated token");'
            'await new Promise(r=>setTimeout(r,700));'
            'return new Response(JSON.stringify({access_token:"fixture-token-new",refresh_token:"fixture-refresh-new",'
            'expires_in:28800}),{status:200});}'
            'if(options.headers.authorization!=="Bearer fixture-token-new")return new Response("{}",{status:401});'
            'return new Response(JSON.stringify(url.endsWith("/usage")?{five_hour:{utilization:10}}'
            ':{account:{has_claude_max:true}}),{status:200});};')
        with tempfile.TemporaryDirectory() as directory:
            home, auth = self.claude_home(directory, 1)
            (home / 'fetch.mjs').write_text(stub)
            procs = [subprocess.Popen(['node', '--import', str(home / 'fetch.mjs'), str(ROOT / 'cuotas' / 'leer-cuota.mjs'),
                                       '--refresh-own-session'], env={**os.environ, 'HOME': str(home)},
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(3)]
            outputs = [proc.communicate(timeout=30)[0] for proc in procs]
            self.assertEqual([json.loads(out)['ok'] for out in outputs], [True, True, True])
            self.assertEqual((home / 'refreshes').read_text(), '.')
            saved = json.loads(auth.read_text())['claudeAiOauth']
            self.assertEqual((saved['accessToken'], saved['refreshToken']), ('fixture-token-new', 'fixture-refresh-new'))
            self.assertEqual(stat.S_IMODE(auth.stat().st_mode), 0o600)
            self.assertEqual(sorted(path.name for path in (home / '.claude').iterdir()), ['.credentials.json'])

    def test_grok_concurrent_readers_refresh_once_and_leave_no_orphans(self):
        stub = (
            'import {appendFileSync} from "node:fs";'
            'globalThis.fetch=async(url,options={})=>{'
            'if(url.endsWith("/.well-known/openid-configuration"))return new Response('
            'JSON.stringify({token_endpoint:"https://auth.fixture.invalid/oauth/token"}),{status:200});'
            'if(url==="https://auth.fixture.invalid/oauth/token"){appendFileSync(process.env.HOME+"/refreshes",".");'
            'if(new URLSearchParams(options.body).get("refresh_token")!=="fixture-refresh-old")throw Error("second refresh");'
            'await new Promise(r=>setTimeout(r,700));'
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
                                                     'oidc_issuer': 'https://auth.fixture.invalid', 'oidc_client_id': 'c'}}))
            auth.chmod(0o600)
            (home / 'fetch.mjs').write_text(stub)
            procs = [subprocess.Popen(['node', '--import', str(home / 'fetch.mjs'), str(ROOT / 'cuotas' / 'leer-cuota-grok.mjs'),
                                       '--refresh-own-session'], env={**os.environ, 'HOME': str(home)},
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(3)]
            outputs = [proc.communicate(timeout=30)[0] for proc in procs]
            self.assertEqual([json.loads(out)['ok'] for out in outputs], [True, True, True])
            self.assertEqual((home / 'refreshes').read_text(), '.')
            self.assertEqual(json.loads(auth.read_text())['fixture']['key'], 'fixture-token-new')
            self.assertEqual(sorted(path.name for path in (home / '.grok').iterdir()), ['auth.json'])

    def test_claude_stale_orphan_lock_is_reclaimed(self):
        with tempfile.TemporaryDirectory() as directory:
            home, auth = self.claude_home(directory, 1)
            lock = home / '.claude' / '.credentials.json.lock'
            lock.write_text('9999')
            old = time.time() - 600
            os.utime(lock, (old, old))
            response = self.run_reader(home, 'leer-cuota.mjs', self.CLAUDE_REFRESH_STUB, '--refresh-own-session')
            self.assertTrue(json.loads(response.stdout)['ok'])
            self.assertFalse(lock.exists())

    def test_claude_timeout_is_network_not_http(self):
        stub = ('globalThis.fetch=async()=>{throw new DOMException("timed out","TimeoutError")};')
        with tempfile.TemporaryDirectory() as directory:
            home, _ = self.claude_home(directory, 9_999_999_999_999)
            report = json.loads(self.run_reader(home, 'leer-cuota.mjs', stub).stdout)
        self.assertEqual(report['error_code'], 'network')
        self.assertNotIn('HTTP', report['nota'])

    def test_claude_preventive_refresh_failure_with_valid_token_continues(self):
        stub = ('globalThis.fetch=async(url,options={})=>{if(url.includes("/oauth/token"))throw new TypeError("fetch failed");'
                'return new Response(JSON.stringify(url.endsWith("/usage")?{five_hour:{utilization:4}}'
                ':{account:{has_claude_pro:true}}),{status:200});};')
        with tempfile.TemporaryDirectory() as directory:
            home, auth = self.claude_home(directory, int(time.time() * 1000) + 60_000)
            before = auth.read_bytes()
            report = json.loads(self.run_reader(home, 'leer-cuota.mjs', stub, '--refresh-own-session').stdout)
            self.assertEqual(auth.read_bytes(), before)
        self.assertTrue(report['ok'])

    def test_claude_200_with_non_json_body_is_provider_error(self):
        stub = ('globalThis.fetch=async()=>new Response("<html>oops</html>",{status:200});')
        with tempfile.TemporaryDirectory() as directory:
            home, _ = self.claude_home(directory, 9_999_999_999_999)
            report = json.loads(self.run_reader(home, 'leer-cuota.mjs', stub).stdout)
        self.assertEqual(report['error_code'], 'provider_error')

    def test_claude_credential_without_oauth_block_is_not_authenticated(self):
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory)
            (home / '.claude').mkdir()
            (home / '.claude' / '.credentials.json').write_text('{"other":{}}')
            report = json.loads(self.run_reader(home, 'leer-cuota.mjs', 'globalThis.fetch=async()=>{throw Error("x")};').stdout)
        self.assertEqual(report['error_code'], 'not_authenticated')

    def test_grok_timeout_is_network_and_non_json_is_provider_error(self):
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory)
            (home / '.grok').mkdir()
            (home / '.grok' / 'auth.json').write_text(json.dumps({'fixture': {'key': 'fixture-token'}}))
            timeout = json.loads(self.run_reader(
                home, 'leer-cuota-grok.mjs', 'globalThis.fetch=async()=>{throw new DOMException("t","TimeoutError")};').stdout)
            garbage = json.loads(self.run_reader(
                home, 'leer-cuota-grok.mjs', 'globalThis.fetch=async()=>new Response("nope",{status:200});').stdout)
        self.assertEqual(timeout['error_code'], 'network')
        self.assertNotIn('HTTP', timeout['nota'])
        self.assertEqual(garbage['error_code'], 'provider_error')

    def test_grok_failed_discovery_is_provider_error_not_a_json_crash(self):
        stub = ('globalThis.fetch=async(url)=>{if(url.endsWith("/.well-known/openid-configuration"))'
                'return new Response("<html>",{status:503});return new Response("{}",{status:401})};')
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory)
            (home / '.grok').mkdir()
            auth = home / '.grok' / 'auth.json'
            auth.write_text(json.dumps({'fixture': {'key': 'k', 'refresh_token': 'r', 'oidc_client_id': 'c'}}))
            report = json.loads(self.run_reader(home, 'leer-cuota-grok.mjs', stub, '--refresh-own-session').stdout)
            self.assertEqual(list((home / '.grok').glob('*.tmp*')), [])
        self.assertEqual(report['error_code'], 'provider_error')
        self.assertIn('HTTP 503', report['nota'])

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
                    probe, 'pedir_refresco', return_value={'access_token': renewed, 'refresh_token': 'fixture-refresh-new'}) as refresh, \
                    patch.object(probe, 'refresco_permitido', return_value=True):
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

    def test_codex_refresh_guard_only_allows_the_node_home_codex(self):
        self.assertTrue(probe.refresco_permitido('/home/node/.codex', '/home/node'))
        self.assertFalse(probe.refresco_permitido('/datos/agents/shared/.codex', '/home/node'))
        self.assertFalse(probe.refresco_permitido('/home/stev/.codex', '/home/stev'))
        self.assertFalse(probe.refresco_permitido('/home/node/.codex-200', '/home/node'))
        with tempfile.TemporaryDirectory() as directory:
            self.codex_home(directory, -3600)
            with patch.object(probe, 'pedir') as request, patch.object(probe, 'pedir_refresco') as refresh:
                denied = probe.sonda(directory, refresh=True)
            request.assert_not_called()
            refresh.assert_not_called()
            self.assertEqual(denied['error_code'], 'token_expired')

    def test_codex_cli_without_explicit_paths_never_refreshes_fleet_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            self.codex_home(directory, -3600)
            with patch.object(probe, 'HOMES_POR_DEFECTO', [directory]), patch.object(probe, 'pedir_refresco') as refresh, \
                    patch.object(probe, 'refresco_permitido', return_value=True), \
                    patch.object(sys, 'argv', ['codex-http-probe.py', '--refresh-own-session']), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(probe.main(), 1)
            refresh.assert_not_called()
            self.assertEqual(json.loads(output.getvalue())['error_code'], 'token_expired')

    def test_codex_refresh_adopts_a_token_refreshed_by_another_process(self):
        usage = {'rate_limit': {'primary_window': {'used_percent': 5, 'limit_window_seconds': 604800}}}
        other = self.jwt({'exp': int(time.time()) + 9 * 86400, 'client_id': 'fixture-client'})
        with tempfile.TemporaryDirectory() as directory:
            auth, _ = self.codex_home(directory, -3600)
            real_lock = probe.candado_directorio

            @contextlib.contextmanager
            def other_process_first(home):
                saved = json.loads(auth.read_text())
                saved['tokens']['access_token'] = other
                auth.write_text(json.dumps(saved))
                with real_lock(home):
                    yield

            with patch.object(probe, 'candado_directorio', other_process_first), \
                    patch.object(probe, 'pedir', return_value=usage) as request, \
                    patch.object(probe, 'pedir_refresco') as refresh, \
                    patch.object(probe, 'refresco_permitido', return_value=True):
                report = probe.sonda(directory, refresh=True)
            refresh.assert_not_called()
            self.assertEqual(request.call_args.args[1], other)
        self.assertIsNone(report['error'])

    def test_codex_refresh_waits_for_the_directory_lock(self):
        usage = {'rate_limit': {'primary_window': {'used_percent': 5, 'limit_window_seconds': 604800}}}
        renewed = self.jwt({'exp': int(time.time()) + 9 * 86400, 'client_id': 'fixture-client'})
        with tempfile.TemporaryDirectory() as directory:
            self.codex_home(directory, -3600)
            lock_fd = os.open(directory, os.O_RDONLY)
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            called = threading.Event()

            def fake_refresh(refresh_token, client_id):
                called.set()
                return {'access_token': renewed, 'refresh_token': 'fixture-refresh-new'}

            result = {}
            try:
                with patch.object(probe, 'pedir', return_value=usage), patch.object(probe, 'pedir_refresco', fake_refresh), \
                        patch.object(probe, 'refresco_permitido', return_value=True):
                    worker = threading.Thread(target=lambda: result.update(report=probe.sonda(directory, refresh=True)))
                    worker.start()
                    self.assertFalse(called.wait(0.3))
                    fcntl.flock(lock_fd, fcntl.LOCK_UN)
                    worker.join(5)
            finally:
                os.close(lock_fd)
            self.assertFalse(worker.is_alive())
            self.assertTrue(called.is_set())
        self.assertIsNone(result['report']['error'])

    def test_codex_save_oserror_is_provider_error_and_leaves_no_temp(self):
        with tempfile.TemporaryDirectory() as directory:
            auth, _ = self.codex_home(directory, -3600)
            before = auth.read_bytes()
            renewed = self.jwt({'exp': int(time.time()) + 9 * 86400, 'client_id': 'fixture-client'})
            with patch.object(probe, 'pedir'), patch.object(
                    probe, 'pedir_refresco', return_value={'access_token': renewed}), \
                    patch.object(probe, 'refresco_permitido', return_value=True), \
                    patch('os.replace', side_effect=OSError('disk full')):
                report = probe.sonda(directory, refresh=True)
            self.assertEqual(auth.read_bytes(), before)
            self.assertEqual(list(pathlib.Path(directory).glob('.auth-*')), [])
        self.assertEqual(report['error_code'], 'provider_error')

    def test_codex_403_is_provider_error_not_credential_type(self):
        with tempfile.TemporaryDirectory() as directory:
            self.codex_home(directory, 9 * 86400)
            with patch.object(probe, 'pedir', side_effect=urllib.error.HTTPError(
                    'https://fixture.invalid', 403, 'forbidden', {}, io.BytesIO(b'cf-block'))):
                report = probe.sonda(directory)
        self.assertEqual(report['error_code'], 'provider_error')
        self.assertEqual(report['extra']['http_status'], 403)
        self.assertNotIn('no refresca', report['error'])

    def test_codex_refresh_token_is_spent_at_most_once_per_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            self.codex_home(directory, 86400)
            with patch.object(probe, 'pedir', side_effect=urllib.error.HTTPError(
                    'https://fixture.invalid', 401, 'unauthorized', {}, io.BytesIO(b''))), \
                    patch.object(probe, 'pedir_refresco', side_effect=urllib.error.HTTPError(
                        'https://fixture.invalid', 500, 'error', {}, None)) as refresh, \
                    patch.object(probe, 'refresco_permitido', return_value=True):
                report = probe.sonda(directory, refresh=True)
            refresh.assert_called_once()
        self.assertEqual(report['error_code'], 'token_expired')

    def test_codex_valid_token_never_refreshes_even_with_flag(self):
        usage = {'rate_limit': {'primary_window': {'used_percent': 5, 'limit_window_seconds': 604800}}}
        with tempfile.TemporaryDirectory() as directory:
            auth, _ = self.codex_home(directory, 9 * 86400)
            before = auth.read_bytes()
            with patch.object(probe, 'pedir', return_value=usage), patch.object(probe, 'pedir_refresco') as refresh, \
                    patch.object(probe, 'refresco_permitido', return_value=True):
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
