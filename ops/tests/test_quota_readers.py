import base64
import importlib.machinery
import importlib.util
import io
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

    def test_grok_emits_stable_non_secret_account_id(self):
        import hashlib as _hashlib
        stub = ('globalThis.fetch=async(url,options={})=>{'
            'if(options.headers.authorization!=="Bearer " + "fixture-token-old")return new Response("{}",{status:401});'
            'return new Response(JSON.stringify({config:{creditUsagePercent:20,currentPeriod:{type:"weekly",'
            'start:"2026-10-01T00:00:00Z",end:"2026-10-08T00:00:00Z"}}}),{status:200});};')
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory)
            (home / '.grok').mkdir()
            auth = home / '.grok' / 'auth.json'
            auth.write_text(json.dumps({'fixture': {'key': 'fixture-token-old',
                'email': 'Fixture@Example.invalid'}}))
            auth.chmod(0o600)
            first = json.loads(self.run_reader(home, 'leer-cuota-grok.mjs', stub).stdout)
            second = json.loads(self.run_reader(home, 'leer-cuota-grok.mjs', stub).stdout)
        expected = 'grok:' + _hashlib.sha256(b'fixture@example.invalid').hexdigest()
        self.assertTrue(first['ok'])
        self.assertEqual(first['account_id'], expected)
        self.assertEqual(second['account_id'], expected)
        self.assertNotIn('fixture-token-old', json.dumps(first))

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
        self.assertFalse(probe.refresco_permitido('/srv/shared/.codex', '/home/node'))
        self.assertFalse(probe.refresco_permitido('/home/otro/.codex', '/home/otro'))
        self.assertFalse(probe.refresco_permitido('/home/node/.codex-200', '/home/node'))
        with tempfile.TemporaryDirectory() as directory:
            self.codex_home(directory, -3600)
            with patch.object(probe, 'pedir') as request, patch.object(probe, 'pedir_refresco') as refresh:
                denied = probe.sonda(directory, refresh=True)
            request.assert_not_called()
            refresh.assert_not_called()
            self.assertEqual(denied['error_code'], 'token_expired')

class MuseQuotaReaderTest(unittest.TestCase):
    def load(self, name, filename):
        loader = importlib.machinery.SourceFileLoader(name, str(ROOT / 'cuotas' / filename))
        spec = importlib.util.spec_from_loader(name, loader)
        module = importlib.util.module_from_spec(spec)
        loader.exec_module(module)
        return module

    def setUp(self):
        self.module = self.load('leer_cuota_muse', 'leer-cuota-muse')
        self.update = self.load('actualizar_muse', 'actualizar-muse')

    def auth(self, directory, **meta):
        home = pathlib.Path(directory)
        config = home / '.config' / 'muse'
        config.mkdir(parents=True)
        document = {'schema_version': 1, 'providers': {'meta': {
            'api_key': 'fixture-api-key', 'access_token': 'fixture-access-token',
            'api_base_url': 'https://api.meta.ai/v1', 'user_email': 'Person@Example.invalid',
            'mechanism': 'device', **meta}}}
        filename = config / 'auth.json'
        filename.write_text(json.dumps(document))
        filename.chmod(0o600)
        (config / 'settings.json').write_text(json.dumps({'model': 'muse-spark-1.3-contributor'}))
        return filename

    def opener(self, payload, status=200, error=None):
        class Response:
            def read(self, amount):
                return payload[:amount]

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        class Opener:
            def __init__(self):
                self.calls = []

            def open(self, request, timeout=None):
                self.calls.append((request, timeout))
                if error is not None:
                    raise error
                if status != 200:
                    raise urllib.error.HTTPError(request.full_url, status, 'fixture', hdrs=None, fp=io.BytesIO(b''))
                return Response()

        return Opener()

    def event(self):
        subscription = {'tier': 'contributor',
                        'window': {'used_percent': 28, 'resets_at': 1_800_000_000, 'window_duration_mins': 300},
                        'weekly': {'used_percent': 9, 'resets_at': 1_806_048_000}}
        return ('data: ' + json.dumps({'type': 'response.subscription_usage', 'subscription': subscription}) + '\n\n').encode()

    def test_sse_reports_five_hour_and_weekly_without_the_credential(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = self.auth(directory)
            before = filename.read_bytes()
            opener = self.opener(self.event())
            report = self.module.read_report(filename, opener)
            self.assertEqual(filename.read_bytes(), before)
        self.assertEqual(opener.calls[0][0].full_url, 'https://api.meta.ai/v1/chat/completions')
        self.assertEqual(opener.calls[0][0].get_header('Authorization'), 'Bearer fixture-api-key')
        self.assertEqual(report['account_id'], 'muse:' + __import__('hashlib').sha256(b'person@example.invalid').hexdigest())
        self.assertEqual(report['plan'], 'contributor')
        self.assertEqual(report['windows'][0]['key'], '5h')
        self.assertEqual(report['windows'][0]['windowMinutes'], 300)
        self.assertEqual(report['windows'][0]['usedPercent'], 28)
        self.assertEqual(report['windows'][0]['remainingPercent'], 72)
        self.assertEqual(report['windows'][0]['resetAt'], time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(1_800_000_000)))
        self.assertEqual(report['windows'][0]['status'], 'ok')
        self.assertEqual(report['windows'][1]['key'], '7d')
        self.assertEqual(report['windows'][1]['windowMinutes'], 10080)
        self.assertEqual(report['windows'][1]['remainingPercent'], 91)
        rendered = json.dumps(report)
        self.assertNotIn('fixture-api-key', rendered)
        self.assertNotIn('fixture-access-token', rendered)
        self.assertNotIn('Person@Example.invalid', rendered)

    def test_missing_auth_bad_host_and_http_errors_do_not_leak_or_rewrite(self):
        self.assertEqual(self.module.read_report(pathlib.Path('/tmp/cauce-muse-auth-missing.json'))['error_code'], 'not_authenticated')
        with tempfile.TemporaryDirectory() as directory:
            filename = self.auth(directory, api_base_url='https://evil.example/v1')
            before = filename.read_bytes()
            opener = self.opener(self.event())
            report = self.module.read_report(filename, opener)
            self.assertEqual(report['error_code'], 'provider_error')
            self.assertEqual(opener.calls, [])
            self.assertEqual(filename.read_bytes(), before)
            for base in ('http://api.meta.ai/v1', 'https://user:fixture-api-key@api.meta.ai/v1', 'https://api.meta.ai/other'):
                document = json.loads(before)
                document['providers']['meta']['api_base_url'] = base
                filename.write_text(json.dumps(document))
                opener = self.opener(self.event())
                self.assertEqual(self.module.read_report(filename, opener)['error_code'], 'provider_error')
                self.assertEqual(opener.calls, [])
            filename.write_text(json.dumps({'schema_version': 1, 'providers': {'meta': {
                'api_key': 'fixture-api-key', 'api_base_url': 'https://api.meta.ai/v1', 'user_email': 'Person@Example.invalid'}}}))
            before = filename.read_bytes()
            for status, code in ((401, 'token_expired'), (429, 'rate_limited'), (500, 'provider_error')):
                report = self.module.read_report(filename, self.opener(b'', status=status))
                self.assertEqual(report['error_code'], code)
                self.assertNotIn('fixture-api-key', json.dumps(report))
            report = self.module.read_report(filename, self.opener(b'', error=urllib.error.URLError('fixture-down')))
            self.assertEqual(report['error_code'], 'network')
            self.assertNotIn('fixture-down', json.dumps(report))
            report = self.module.read_report(filename, self.opener(b'A' * 65537))
            self.assertEqual(report['error_code'], 'provider_error')
            self.assertNotIn('AAAA', json.dumps(report))
            self.assertEqual(filename.read_bytes(), before)

    def test_refresh_flag_exits_zero_and_leaves_auth_bytes_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = self.auth(directory, api_base_url='https://evil.example/v1')
            before = filename.read_bytes()
            result = subprocess.run([str(ROOT / 'cuotas' / 'leer-cuota-muse'), '--refresh-own-session'],
                                    env={**os.environ, 'MUSE_AUTH_PATH': str(filename)},
                                    capture_output=True, text=True, timeout=15, check=False)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(filename.read_bytes(), before)
            report = json.loads(result.stdout)
            self.assertEqual(report['error_code'], 'provider_error')
            self.assertNotIn('fixture-api-key', result.stdout)
            self.assertNotIn('fixture-access-token', result.stdout)

    def test_pinned_cli_copy_refuses_a_symlink_outside_the_image(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            allowed = root / 'usr' / 'local' / 'bin'
            allowed.mkdir(parents=True)
            source = allowed / 'muse'
            source.write_bytes(b'muse-pin-1')
            source.chmod(0o755)
            secret = allowed / 'auth.json'
            secret.write_text('fixture-api-key')
            destination = root / 'home' / '.local' / 'bin' / 'muse'
            self.update.install_pinned_cli(source, destination, allowed)
            self.assertEqual(destination.read_bytes(), b'muse-pin-1')
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o755)
            self.assertEqual(secret.read_text(), 'fixture-api-key')
            source.write_bytes(b'muse-pin-2')
            self.update.install_pinned_cli(source, destination, allowed)
            self.assertEqual(destination.read_bytes(), b'muse-pin-2')
            outside = root / 'outside-muse'
            outside.write_bytes(b'not-the-pin')
            link = allowed / 'linked-muse'
            link.symlink_to(outside)
            with self.assertRaises(ValueError):
                self.update.install_pinned_cli(link, destination, allowed)
            self.assertEqual(destination.read_bytes(), b'muse-pin-2')
            self.assertEqual(outside.read_bytes(), b'not-the-pin')
            inside = allowed / 'real-muse'
            inside.write_bytes(b'muse-pin-3')
            pinned = allowed / 'muse-link'
            pinned.symlink_to(inside)
            self.update.install_pinned_cli(pinned, destination, allowed)
            self.assertEqual(destination.read_bytes(), b'muse-pin-3')


if __name__ == '__main__':
    unittest.main()
