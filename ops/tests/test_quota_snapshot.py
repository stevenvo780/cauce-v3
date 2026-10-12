import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
from quota_snapshot import normalize_cli_snapshot  # noqa: E402


class QuotaSnapshotErrorCodeTest(unittest.TestCase):
    def note(self, provider, raw):
        report = normalize_cli_snapshot(provider, raw, 'fixture-account')
        self.assertEqual(report['observation_status'], 'error')
        self.assertNotEqual(report['provider_report']['note'], 'quota probe unavailable')
        return report

    def test_reader_error_code_reaches_the_sample_note(self):
        report = self.note('claude', {'ok': False, 'error_code': 'token_expired', 'nota': 'token caducado'})
        self.assertEqual(report['provider_report']['note'], 'token_expired')

    def test_rate_limit_is_never_stored_as_exhaustion(self):
        report = self.note('claude', {'ok': False, 'rateLimited': True, 'retryAfter': 8, 'nota': 'HTTP 429: limitado'})
        self.assertEqual(report['provider_report']['note'], 'rate_limited')
        self.assertEqual(report['provider_report']['windows'], [])
        self.assertFalse(report['provider_report']['ok'])
        self.assertIsNone(report['provider_report']['effective_remaining_percent'])

    def test_missing_credential_is_not_authenticated(self):
        report = self.note('claude', {'ok': False, 'nota': 'sin autenticar: falta ~/.claude/.credentials.json'})
        self.assertEqual(report['provider_report']['note'], 'not_authenticated')

    def test_api_key_credential_is_forbidden_credential_type(self):
        report = self.note('codex', {'error': 'auth.json en modo API key: no hay asiento OAuth que medir',
                                     'ventanas': [], 'extra': {'estado': 'sin_credencial'}})
        self.assertEqual(report['provider_report']['note'], 'forbidden_credential_type')

    def test_codex_network_failure_is_network(self):
        report = self.note('codex', {'error': 'fallo de red/endpoint: URLError en https://chatgpt.com/backend-api/wham/usage',
                                     'ventanas': [], 'extra': {'estado': 'fallo_de_red'}})
        self.assertEqual(report['provider_report']['note'], 'network')

    def test_codex_http_500_is_provider_error_and_expired_is_token_expired(self):
        self.assertEqual(self.note('codex', {'error': 'fallo de red/endpoint: HTTP 500 en https://chatgpt.com/backend-api/wham/usage',
                                             'ventanas': [], 'extra': {'estado': 'fallo_de_red'}})['provider_report']['note'],
                         'provider_error')
        self.assertEqual(self.note('codex', {'error': 'access token vencido el 2026-10-01T00:00:00Z',
                                             'ventanas': [], 'extra': {'estado': 'token_invalidado'}})['provider_report']['note'],
                         'token_expired')

    def test_unknown_reader_code_falls_back_to_the_closed_set(self):
        report = self.note('claude', {'ok': False, 'error_code': 'anything-the-reader-invents', 'nota': 'fallo raro'})
        self.assertEqual(report['provider_report']['note'], 'provider_error')

    def test_status_numbers_only_count_as_http_tokens(self):
        for text, code in (('HTTP 429 del proveedor', 'rate_limited'), ('status: 401', 'token_expired'),
                           ('http_status=429', 'rate_limited')):
            self.assertEqual(self.note('claude', {'ok': False, 'nota': text})['provider_report']['note'], code)
        for text in ('fallo en la cuenta 4290 y 14011', 'ECONNRESET tras 429 bytes'):
            self.assertNotIn(self.note('claude', {'ok': False, 'nota': text})['provider_report']['note'],
                             ('rate_limited', 'token_expired'))

    def test_successful_sample_has_no_note(self):
        report = normalize_cli_snapshot('claude', {'ok': True, 'windows': [
            {'key': '5h', 'usedPercent': 10, 'windowMinutes': 300}]}, 'fixture-account')
        self.assertEqual(report['observation_status'], 'ok')
        self.assertIsNone(report['provider_report']['note'])


if __name__ == '__main__':
    unittest.main()
