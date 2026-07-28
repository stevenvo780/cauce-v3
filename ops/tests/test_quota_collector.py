#!/usr/bin/env python3
"""
Tests del recolector de cuotas (ops/scripts/quota-collector.py).

No hay PostgreSQL ni kratos en esta maquina, asi que estos tests cubren lo que SI se puede
probar sin ellos: que el script parsea correctamente la forma real de ai-usage (fixture tomado
del shape descrito en el pedido), que separa grupos por limitId, que degrada con gracia ante
datos rotos o un CLI ausente (en vez de no publicar nada), y que el camino mTLS real -- incluida
la verificacion de hostname contra una IP -- funciona de punta a punta contra un servidor
descartable. Los tests que necesitan generar certificados (openssl) se saltean con un aviso si
la herramienta no esta instalada, en vez de fallar: no es una dependencia del script, solo de
estos tests.
"""

from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / 'scripts' / 'quota-collector.py'
FIXTURES = pathlib.Path(__file__).resolve().parent / 'fixtures'


def load_module():
    spec = importlib.util.spec_from_file_location('quota_collector', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_cli(args, env=None, timeout=15):
    full_env = os.environ.copy()
    # Aislar de cualquier CAUCE_QUOTA_* que ya este exportado en el entorno del que corre los
    # tests: cada test declara explicitamente lo que necesita.
    for key in list(full_env):
        if key.startswith('CAUCE_QUOTA_'):
            del full_env[key]
    if env:
        full_env.update(env)
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True, text=True, timeout=timeout, env=full_env,
    )


# --------------------------------------------------------------------------------------------
# 1. El script existe y tiene la forma esperada.
# --------------------------------------------------------------------------------------------

def test_script_exists_and_shebang():
    assert SCRIPT.exists(), 'quota-collector.py existe'
    content = SCRIPT.read_text()
    assert content.startswith('#!/usr/bin/env python3'), 'shebang correcto'
    print('✓ el script existe con shebang correcto')


# --------------------------------------------------------------------------------------------
# 2. Normalizacion del fixture realista (shape real de ai-usage descrito en el pedido).
# --------------------------------------------------------------------------------------------

def test_dry_run_normalizes_realistic_fixture():
    result = run_cli([
        '--dry-run',
        '--input-file', str(FIXTURES / 'ai-usage-sample.json'),
        '--account-bindings-file', str(FIXTURES / 'account-bindings-sample.json'),
        '--host', 'kratos',
    ])
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload['host'] == 'kratos'
    assert payload['schema_version'] == 2
    assert payload['app_version'] == '0.12.0'

    providers = {p['provider']: p for p in payload['providers']}
    assert set(providers) == {'claude', 'codex', 'antigravity', 'opencode'}

    # El caso que motivo el contrato: codex tiene que separarse en dos grupos por limitId, no
    # aplastarse a un numero (uno esta agotado, el otro libre).
    codex_groups = {g['group_key']: g for g in providers['codex']['groups']}
    assert set(codex_groups) == {'codex', 'codex_bengalfox'}
    assert codex_groups['codex']['account_id'] == 'codex-pro-steven'
    assert codex_groups['codex']['windows'][0]['used_percent'] == 100.0
    assert codex_groups['codex']['windows'][0]['status'] == 'rate-limited'
    assert codex_groups['codex_bengalfox']['account_id'] is None, 'grupo sin entrada en bindings queda sin atar'
    assert 'sin binding' in codex_groups['codex_bengalfox']['binding_note']

    claude_groups = {g['group_key']: g for g in providers['claude']['groups']}
    assert set(claude_groups) == {'default'}
    assert len(claude_groups['default']['windows']) == 2
    assert claude_groups['default']['account_id'] == 'claude-steven-max'

    opencode_window = providers['opencode']['groups'][0]['windows'][0]
    assert opencode_window['used_units'] == 0
    assert opencode_window['limit_units'] == 12
    print('✓ normaliza el fixture realista (codex se separa por grupo, claude/opencode quedan en default)')


# --------------------------------------------------------------------------------------------
# 3. Robustez: un proveedor roto o una ventana sin datos no tumban la publicacion del resto.
# --------------------------------------------------------------------------------------------

def test_malformed_provider_and_windows_without_numbers_dont_crash():
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as fh:
        json.dump({
            'schemaVersion': 2,
            'providers': {
                'claude': 'esto no es un objeto',
                'codex': {'ok': True, 'available': True, 'windows': [{'key': 'vacia', 'label': 'sin numeros'}]},
            },
        }, fh)
        path = fh.name
    try:
        result = run_cli(['--dry-run', '--input-file', path, '--host', 'kratos'])
        assert result.returncode == 0, result.stderr
        payload = json.loads(result.stdout)
        providers = {p['provider']: p for p in payload['providers']}
        assert providers['claude']['ok'] is False
        assert 'no es un objeto' in providers['claude']['note']
        assert providers['codex']['ok'] is True, 'el proveedor sigue reportandose ok, solo pierde la ventana rota'
        assert providers['codex']['groups'] == [], 'la ventana sin usedPercent/remainingPercent/usedUnits se descarta'
        assert 'descartada' in providers['codex']['note']
    finally:
        os.unlink(path)
    print('✓ un proveedor malformado y una ventana sin numeros no tumban la publicacion del resto')


def test_missing_providers_key_falls_back_to_configured_list():
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as fh:
        json.dump({'algo': 'inesperado'}, fh)
        path = fh.name
    try:
        result = run_cli(['--dry-run', '--input-file', path, '--host', 'kratos'],
                          env={'CAUCE_QUOTA_PROVIDERS': 'claude,codex'})
        assert result.returncode == 0, result.stderr
        payload = json.loads(result.stdout)
        names = {p['provider'] for p in payload['providers']}
        assert names == {'claude', 'codex'}
        assert all(p['ok'] is False for p in payload['providers'])
    finally:
        os.unlink(path)
    print("✓ JSON sin 'providers' cae al fallback configurado en vez de abortar sin publicar nada")


def test_ai_usage_binary_missing_publishes_failure_report():
    result = run_cli(['--dry-run', '--host', 'kratos'], env={
        'CAUCE_QUOTA_AI_USAGE_CMD': 'ai-usage-que-no-existe-en-este-host --json',
        'CAUCE_QUOTA_PROVIDERS': 'claude,codex,antigravity,opencode',
    })
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert len(payload['providers']) == 4
    assert all(p['ok'] is False and 'no respondio' in (p['note'] or '') for p in payload['providers'])
    print('✓ ai-usage ausente publica un reporte de falla total en vez de no publicar nada (exit 0)')


def test_invalid_host_exits_with_config_error():
    result = run_cli(['--dry-run', '--input-file', str(FIXTURES / 'ai-usage-sample.json'), '--host', 'kratos invalido'])
    assert result.returncode == 2
    assert 'host invalido' in result.stderr
    print('✓ un host invalido frena con exit 2 antes de intentar publicar nada')


# --------------------------------------------------------------------------------------------
# 4. Funciones puras de saneamiento (unit-level, via importlib).
# --------------------------------------------------------------------------------------------

def test_sanitizers_are_defensive():
    module = load_module()
    assert module.sanitize_key(None, 'default') == 'default'
    assert module.sanitize_key('codex bengalfox raro!', 'default').startswith(('c', 'x'))
    assert module.KEY_RE.match(module.sanitize_key('   ', 'default'))
    assert module.PROVIDER_RE.match(module.sanitize_provider('Codex Raro!'))
    assert module.trim('   ', 10) is None, 'una cadena vacia tras strip no debe pasar el CHECK de longitud > 0'
    assert module.trim('x' * 20, 5) == 'xxxx…'
    assert module.to_number(100.5) == 100.0, 'un desborde chico (redondeo) se clampea'
    assert module.to_number(-0.5) == 0.0, 'un desborde chico (redondeo) se clampea'
    assert module.to_number(250) is None, 'un desborde grande NO se clampea a 100: seria leer un dato roto como sano'
    assert module.to_number(-50) is None, 'un desborde grande NO se clampea a 0: seria leer un dato roto como agotado'
    assert module.to_number('no-es-un-numero') is None
    assert module.to_units(-1, 0) is None, 'used_units negativo se descarta (CHECK >= 0)'
    assert module.to_units(0, 0) == 0
    try:
        module.sanitize_host('con espacios')
        raise AssertionError('sanitize_host deberia haber levantado QuotaCollectionError')
    except module.QuotaCollectionError:
        pass
    print('✓ los saneadores (host/provider/key/numero) son defensivos ante datos crudos raros')


def test_malformed_pki_fails_clean_not_with_traceback():
    with tempfile.TemporaryDirectory() as pki_dir:
        for name in ('client.crt', 'client.key', 'ca.crt'):
            pathlib.Path(pki_dir, name).write_text('esto no es un PEM valido\n')
        result = run_cli([
            '--input-file', str(FIXTURES / 'ai-usage-sample.json'), '--host', 'kratos',
            '--pki-dir', pki_dir, '--gateway-url', 'https://127.0.0.1:1/v3/quotas/samples',
        ])
        assert result.returncode == 2, result.stderr
        assert 'Traceback' not in result.stderr, 'un PEM invalido no debe crashear con traceback sin manejar'
        assert 'PKI invalida' in result.stderr
    print('✓ PKI con PEM invalido falla limpio (exit 2), sin traceback')


# --------------------------------------------------------------------------------------------
# 5. mTLS real de punta a punta (requieren openssl para generar certificados descartables;
#    se saltean con aviso si no esta disponible -- no es una dependencia del script en si).
# --------------------------------------------------------------------------------------------

def _openssl_available() -> bool:
    return shutil.which('openssl') is not None


def _run_openssl(*cmd):
    subprocess.run(['openssl', *cmd], capture_output=True, text=True, check=True)


def _generate_ca_and_client(tmp_dir: str):
    ca_key, ca_crt = f'{tmp_dir}/ca.key', f'{tmp_dir}/ca.crt'
    client_key, client_csr, client_crt = f'{tmp_dir}/client.key', f'{tmp_dir}/client.csr', f'{tmp_dir}/client.crt'
    _run_openssl('req', '-x509', '-newkey', 'rsa:2048', '-keyout', ca_key, '-out', ca_crt,
                  '-days', '2', '-nodes', '-subj', '/CN=quota-collector-test-ca')
    _run_openssl('req', '-newkey', 'rsa:2048', '-keyout', client_key, '-out', client_csr,
                  '-nodes', '-subj', '/CN=quota-collector-test')
    _run_openssl('x509', '-req', '-in', client_csr, '-CA', ca_crt, '-CAkey', ca_key,
                  '-CAcreateserial', '-out', client_crt, '-days', '2')
    return ca_key, ca_crt, client_key, client_crt


def _generate_server_cert(tmp_dir: str, ca_key: str, ca_crt: str, cn: str, san_line: str):
    server_key, server_csr, server_crt = f'{tmp_dir}/server.key', f'{tmp_dir}/server.csr', f'{tmp_dir}/server.crt'
    ext_file = f'{tmp_dir}/ext.cnf'
    pathlib.Path(ext_file).write_text(f'subjectAltName = {san_line}\n')
    _run_openssl('req', '-newkey', 'rsa:2048', '-keyout', server_key, '-out', server_csr, '-nodes', '-subj', f'/CN={cn}')
    _run_openssl('x509', '-req', '-in', server_csr, '-CA', ca_crt, '-CAkey', ca_key,
                 '-CAcreateserial', '-out', server_crt, '-days', '2', '-extfile', ext_file)
    return server_key, server_crt


def _start_fake_server(pki_dir: str, port: int) -> subprocess.Popen:
    proc = subprocess.Popen(
        [sys.executable, str(FIXTURES / 'fake_quota_server.py'), pki_dir, str(port)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    line = proc.stdout.readline()
    assert 'listening' in line, f'el servidor de prueba no arranco: {line!r}'
    time.sleep(0.2)
    return proc


def test_mtls_round_trip_with_ip_san_succeeds():
    if not _openssl_available():
        print('⚠️  test_mtls_round_trip_with_ip_san_succeeds salteado: openssl no disponible')
        return
    with tempfile.TemporaryDirectory() as tmp_dir:
        ca_key, ca_crt, client_key, client_crt = _generate_ca_and_client(tmp_dir)
        _generate_server_cert(tmp_dir, ca_key, ca_crt, '127.0.0.1', 'IP:127.0.0.1')
        port = 8901
        server = _start_fake_server(tmp_dir, port)
        try:
            result = run_cli([
                '--input-file', str(FIXTURES / 'ai-usage-sample.json'),
                '--account-bindings-file', str(FIXTURES / 'account-bindings-sample.json'),
                '--host', 'kratos', '--pki-dir', tmp_dir,
                '--gateway-url', f'https://127.0.0.1:{port}/v3/quotas/samples',
            ])
            assert result.returncode == 0, result.stderr
            assert '-> 202' in result.stderr
            assert 'collection_id=test-collection-id' in result.stderr
        finally:
            server.terminate()
            server.wait(timeout=5)
    print('✓ handshake mTLS real + POST exitoso contra un cert con SAN de IP (check_hostname sigue prendido)')


def test_hostname_verification_is_enforced_and_override_works():
    """Prueba que el fix de seguridad es real: SIN el override, un cert que no matchea la IP de
    conexion se RECHAZA (o sea que check_hostname=True esta genuinamente activo, no es un
    no-op); CON --gateway-server-name (el mismo escape hatch que RELAY_SERVER_NAME en
    ops/pty-agent), la verificacion pasa contra el nombre configurado."""
    if not _openssl_available():
        print('⚠️  test_hostname_verification_is_enforced_and_override_works salteado: openssl no disponible')
        return
    with tempfile.TemporaryDirectory() as tmp_dir:
        ca_key, ca_crt, client_key, client_crt = _generate_ca_and_client(tmp_dir)
        # A proposito SIN SAN de IP: solo un nombre DNS que no matchea 127.0.0.1.
        _generate_server_cert(tmp_dir, ca_key, ca_crt, 'quota-gateway.internal', 'DNS:quota-gateway.internal')
        port = 8902
        server = _start_fake_server(tmp_dir, port)
        try:
            without_override = run_cli([
                '--input-file', str(FIXTURES / 'ai-usage-sample.json'), '--host', 'kratos',
                '--pki-dir', tmp_dir, '--gateway-url', f'https://127.0.0.1:{port}/v3/quotas/samples',
            ])
            assert without_override.returncode == 1, without_override.stderr
            assert 'CERTIFICATE_VERIFY_FAILED' in without_override.stderr or 'IP address mismatch' in without_override.stderr

            with_override = run_cli([
                '--input-file', str(FIXTURES / 'ai-usage-sample.json'), '--host', 'kratos',
                '--pki-dir', tmp_dir, '--gateway-url', f'https://127.0.0.1:{port}/v3/quotas/samples',
                '--gateway-server-name', 'quota-gateway.internal',
            ])
            assert with_override.returncode == 0, with_override.stderr
            assert '-> 202' in with_override.stderr
        finally:
            server.terminate()
            server.wait(timeout=5)
    print('✓ la verificacion de hostname esta realmente activa, y CAUCE_QUOTA_GATEWAY_SERVER_NAME la resuelve cuando el cert no trae SAN de IP')


def test_network_failure_never_leaks_credential_content():
    if not _openssl_available():
        print('⚠️  test_network_failure_never_leaks_credential_content salteado: openssl no disponible')
        return
    with tempfile.TemporaryDirectory() as tmp_dir:
        _generate_ca_and_client(tmp_dir)
        key_body = pathlib.Path(tmp_dir, 'client.key').read_text()
        # Un fragmento de la clave real (base64, imposible de aparecer por azar en un mensaje
        # de error humano) que jamas deberia viajar a stdout/stderr.
        marker = [line for line in key_body.splitlines() if line and 'BEGIN' not in line and 'END' not in line][0][:40]

        result = run_cli([
            '--input-file', str(FIXTURES / 'ai-usage-sample.json'), '--host', 'kratos',
            '--pki-dir', tmp_dir, '--gateway-url', 'https://127.0.0.1:1/v3/quotas/samples',
            '--host', 'kratos',
        ], env={'CAUCE_QUOTA_HTTP_RETRIES': '0'})
        assert result.returncode == 1
        assert marker not in result.stdout
        assert marker not in result.stderr
    print('✓ un fallo de red (conexion rechazada) nunca vuelca contenido de client.key en stdout/stderr')


TESTS = [
    test_script_exists_and_shebang,
    test_dry_run_normalizes_realistic_fixture,
    test_malformed_provider_and_windows_without_numbers_dont_crash,
    test_missing_providers_key_falls_back_to_configured_list,
    test_ai_usage_binary_missing_publishes_failure_report,
    test_invalid_host_exits_with_config_error,
    test_sanitizers_are_defensive,
    test_malformed_pki_fails_clean_not_with_traceback,
    test_mtls_round_trip_with_ip_san_succeeds,
    test_hostname_verification_is_enforced_and_override_works,
    test_network_failure_never_leaks_credential_content,
]


if __name__ == '__main__':
    for test in TESTS:
        test()
    print('\n✓ All tests passed')
