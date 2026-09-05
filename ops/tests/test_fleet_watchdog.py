#!/usr/bin/env python3
"""
Unit tests for fleet watchdog.
"""

from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

OPS_ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPTS_DIR = OPS_ROOT / 'scripts'
WATCHDOG_PATH = SCRIPTS_DIR / 'fleet-watchdog.py'
CONTAINER_ALIAS_LIB_PATH = SCRIPTS_DIR / 'container_alias_lib.py'


def load_watchdog_module():
    """Load the production module with its sibling dependencies resolved from ops/scripts."""
    spec = importlib.util.spec_from_file_location('fleet_watchdog_under_test', WATCHDOG_PATH)
    assert spec is not None and spec.loader is not None, 'watchdog module has an import loader'

    original_path = sys.path.copy()
    previous_dependency = sys.modules.pop('container_alias_lib', None)
    try:
        sys.path.insert(0, str(SCRIPTS_DIR))
        watchdog_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(watchdog_module)
        dependency = sys.modules.get('container_alias_lib')
        assert dependency is not None, 'watchdog imports container_alias_lib'
        assert pathlib.Path(dependency.__file__).resolve() == CONTAINER_ALIAS_LIB_PATH, (
            'container_alias_lib comes from ops/scripts'
        )
        return watchdog_module
    finally:
        sys.path[:] = original_path
        sys.modules.pop('container_alias_lib', None)
        if previous_dependency is not None:
            sys.modules['container_alias_lib'] = previous_dependency


# Test 1: Script exists and has proper shebang
def test_script_exists():
    assert WATCHDOG_PATH.exists(), 'fleet-watchdog.py exists'
    content = WATCHDOG_PATH.read_text()
    assert content.startswith('#!/usr/bin/env python3'), 'has proper shebang'
    print('✓ Script exists and has proper shebang')


# Test 2: Missing CAUCE_DATABASE_URL exits with code 2
def test_missing_database_url():
    env = os.environ.copy()
    env.pop('CAUCE_DATABASE_URL', None)
    env.pop('PYTHONPATH', None)

    result = subprocess.run(
        [sys.executable, str(WATCHDOG_PATH)],
        capture_output=True,
        text=True,
        env=env,
    )
    assert result.returncode == 2, f'exits with 2 (got {result.returncode})'
    assert 'CAUCE_DATABASE_URL' in result.stderr, 'error mentions CAUCE_DATABASE_URL'
    print('✓ Missing CAUCE_DATABASE_URL exits with code 2')


# Test 3: Parse psql output correctly
def test_parse_psql_rows():
    """Test the parse_psql_rows function indirectly through state file."""
    watchdog_module = load_watchdog_module()

    sample_output = 'alias|epoch\nargos|15\natlas|18'
    rows = watchdog_module.parse_psql_rows(sample_output)
    assert len(rows) == 2, 'parses two data rows'
    assert rows[0]['alias'] == 'argos', 'first row alias correct'
    assert rows[0]['epoch'] == '15', 'first row epoch correct'
    print('✓ psql output parsing works correctly')


def test_psql_preserves_headers_and_rejects_sql_errors():
    module = load_watchdog_module()

    def fake_run(args, **kwargs):
        assert '-X' in args and '-Aq' in args
        assert '-Atqc' not in args and '-t' not in args
        assert args[args.index('-P') + 1] == 'footer=off'
        assert args[args.index('-v') + 1] == 'ON_ERROR_STOP=1'
        assert kwargs['timeout'] == 30
        return SimpleNamespace(returncode=0, stdout='alias|epoch\natlas|18\n')

    with patch.object(module.subprocess, 'run', fake_run):
        assert module.parse_psql_rows(module.run_psql('postgres://test', 'SELECT 1')) == [
            {'alias': 'atlas', 'epoch': '18'},
        ]
    with patch.dict(os.environ, {'CAUCE_PSQL_COMMAND': 'docker exec -i test-postgres psql'}), patch.object(
        module.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='value\n1\n'),
    ) as runner:
        module.run_psql('postgres://test', 'SELECT 1')
        assert runner.call_args.args[0][:6] == ['docker', 'exec', '-i', 'test-postgres', 'psql', '-X']
    with patch.dict(os.environ, {'CAUCE_PSQL_COMMAND': ' '}), patch.object(module.subprocess, 'run') as runner:
        try:
            module.run_psql('postgres://test', 'SELECT 1')
        except ValueError:
            pass
        else:
            raise AssertionError('an empty invocation prefix must be rejected')
        runner.assert_not_called()
    with patch.object(module.subprocess, 'run', return_value=SimpleNamespace(
        returncode=3, stderr='query failed', stdout='',
    )):
        try:
            module.run_psql('postgres://test', 'invalid')
        except ValueError:
            pass
        else:
            raise AssertionError('SQL failures cannot look like an empty result')


def test_timezone_aware_checks_and_legacy_state():
    module = load_watchdog_module()
    now = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)

    def healthy_lease_query(_database_url, query):
        if 'FROM agents' in query:
            return 'alias\n'
        return (
            'alias|lease_until|last_heartbeat_at|epoch|connected_at\n'
            'atlas|2026-01-01 12:01:00+00|2026-01-01 06:59:59-05|1|2026-01-01 11:00:00+00\n'
        )

    with patch.object(module, 'EXPECTED_ALIASES', ['atlas']), patch.object(
        module, 'run_psql', side_effect=healthy_lease_query,
    ):
        assert module.check_connection_leases('postgres://test', now)['status'] == 'ok'
    with patch.object(module, 'run_psql', return_value=(
        'recipient_alias|status|count|last_terminal_at|oldest_available_at\n'
        'atlas|dead|1|2026-01-01 11:59:00+00|2026-01-01 11:00:00+00\n'
    )):
        result = module.check_dead_failed_deliveries('postgres://test', now, '2026-01-01T11:58:00')
        assert result['new_dead'] == {'atlas': 1}
    assert module.utc_timestamp('2026-01-01T12:00:00') == now
    assert module.utc_timestamp('2026-01-01T07:00:00-05:00') == now


def test_enabled_registry_extends_expected_lease_coverage_fail_closed():
    module = load_watchdog_module()
    now = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)
    assert 'SELECT DISTINCT alias' in module.ENABLED_ALIASES_QUERY
    assert 'FROM agents' in module.ENABLED_ALIASES_QUERY
    assert 'WHERE enabled' in module.ENABLED_ALIASES_QUERY
    lease_header = 'alias|lease_until|last_heartbeat_at|epoch|connected_at\n'
    live_lease = '|2026-01-01 12:01:00+00|2026-01-01 12:00:00+00|1|2026-01-01 11:00:00+00\n'
    expired_lease = '|2026-01-01 11:59:00+00|2026-01-01 11:58:00+00|1|2026-01-01 11:00:00+00\n'

    def missing_enabled_query(_database_url, query):
        if 'FROM agents' in query:
            return 'alias\nastra\ngaia\n'
        return lease_header + 'atlas' + live_lease

    with patch.object(module, 'EXPECTED_ALIASES', ['atlas']), patch.object(
        module, 'run_psql', side_effect=missing_enabled_query,
    ):
        result = module.check_connection_leases('postgres://test', now)
        assert result['status'] == 'critical'
        assert result['offline'] == ['astra', 'gaia']

    def present_enabled_query(_database_url, query):
        if 'FROM agents' in query:
            return 'alias\nastra\n'
        return lease_header + 'atlas' + live_lease + 'astra' + live_lease

    with patch.object(module, 'EXPECTED_ALIASES', ['atlas']), patch.object(
        module, 'run_psql', side_effect=present_enabled_query,
    ):
        result = module.check_connection_leases('postgres://test', now)
        assert result['status'] == 'ok', 'a present enabled lease is not reported offline'

    def existing_non_enabled_query(_database_url, query):
        if 'FROM agents' in query:
            return 'alias\nastra\n'
        return lease_header + 'atlas' + live_lease + 'astra' + live_lease + 'retired' + expired_lease

    with patch.object(module, 'EXPECTED_ALIASES', ['atlas']), patch.object(
        module, 'run_psql', side_effect=existing_non_enabled_query,
    ):
        result = module.check_connection_leases('postgres://test', now)
        assert result['offline'] == ['retired'], 'existing leases retain legacy monitoring when disabled'

    with patch.object(module, 'EXPECTED_ALIASES', ['atlas', 'legacy']), patch.object(
        module, 'run_psql', side_effect=present_enabled_query,
    ):
        result = module.check_connection_leases('postgres://test', now)
        assert result['offline'] == ['legacy'], 'the static expected source remains enforced'

    for unreadable in ('', 'astra\n', 'alias|enabled\nastra|t\n', 'alias\nINVALID\n'):
        with patch.object(module, 'EXPECTED_ALIASES', ['atlas']), patch.object(
            module, 'run_psql', side_effect=[unreadable, lease_header + 'atlas' + live_lease],
        ):
            result = module.check_connection_leases('postgres://test', now)
            assert result['status'] == 'read-error', unreadable


def test_oldest_pending_is_not_hidden_by_recent_work():
    module = load_watchdog_module()

    def pending_query(_database_url, query):
        assert 'MIN(available_at) as oldest_available_at' in query
        return 'recipient_alias|status|count|oldest_available_at\natlas|pending|2|2026-01-01 08:00:00+00\n'

    with patch.object(module, 'run_psql', pending_query):
        result = module.check_pending_deliveries(
            'postgres://test', datetime(2026, 1, 1, 12, tzinfo=timezone.utc),
        )
        assert result['pending_aliases'] == [{'alias': 'atlas', 'count': 2, 'age_min': 240}]


# Test 4: State file structure
def test_state_file():
    """Test state file creation and structure."""
    watchdog_module = load_watchdog_module()

    with tempfile.TemporaryDirectory() as tmpdir:
        state_file = pathlib.Path(tmpdir) / 'watchdog.state'

        # Test load_state with missing file
        state = watchdog_module.load_state(str(state_file))
        assert state['last_run_at'] is None, 'new state has no last_run_at'
        assert 'aliases' in state, 'state has aliases key'
        assert 'previous_alerts' in state, 'state has previous_alerts key'

        # Test save_state
        state['last_run_at'] = datetime.now(timezone.utc).isoformat()
        state['aliases']['argos'] = {'last_epoch': 15}
        state['previous_alerts']['connection_leases'] = {'status': 'critical'}

        success = watchdog_module.save_state(str(state_file), state)
        assert success, 'save_state returns True'
        assert state_file.exists(), 'state file created'

        # Test load_state with existing file
        loaded = watchdog_module.load_state(str(state_file))
        assert loaded['last_run_at'] is not None, 'loaded state has last_run_at'
        assert loaded['aliases']['argos']['last_epoch'] == 15, 'alias epoch persisted'
        assert loaded['previous_alerts']['connection_leases']['status'] == 'critical', 'alert persisted'

        print('✓ State file structure works correctly')


# Test 5: Output format validation
def test_output_formats():
    """Test JSON and text output formats."""
    watchdog_module = load_watchdog_module()

    now = datetime.now(timezone.utc)
    checks = {
        'connection_leases': {
            'status': 'critical',
            'message': '2 offline',
            'offline': ['dedalo', 'vulcano'],
        },
        'dead_letters': {
            'status': 'ok',
            'message': '',
            'open_count': 0,
        },
    }

    # Test JSON format
    json_str = watchdog_module.format_json_output(now, checks, '/tmp/watchdog.state')
    json_data = json.loads(json_str)
    assert 'timestamp' in json_data, 'JSON has timestamp'
    assert json_data['status'] == 'critical', 'JSON status is correct'
    assert 'checks' in json_data, 'JSON has checks'
    print('✓ JSON output format correct')

    # Test text format
    text_str = watchdog_module.format_text_output('critical', checks)
    assert '🔴 CRITICAL' in text_str, 'text has critical emoji'
    assert 'connection_leases' in text_str, 'text mentions check name'
    assert 'dedalo' in text_str, 'text includes offline alias'
    print('✓ Text output format correct')

def test_claimed_not_started():
    """The gap that reported a healthy fleet through an 8h52m outage: an adapter dying right
    after claiming leaves rows in 'leased', which the pending check never looks at."""
    watchdog_module = load_watchdog_module()
    original = watchdog_module.run_psql
    try:
        watchdog_module.run_psql = lambda *_args, **_kwargs: (
            'recipient_alias|count|age_min\n'
            'zeus|4|532\n'
        )
        check = watchdog_module.check_claimed_not_started('postgres://x', datetime.now(timezone.utc))
        assert check['status'] == 'critical', f"deaf alias must be critical (got {check['status']})"
        assert 'zeus' in check['message'], 'the message names the alias'
        assert check['stuck_aliases'] == [{'alias': 'zeus', 'count': 4, 'age_min': 532}]

        # NEGATIVE CONTROL: else a check that always said critical would pass above.
        watchdog_module.run_psql = lambda *_args, **_kwargs: 'recipient_alias|count|age_min\n'
        healthy = watchdog_module.check_claimed_not_started('postgres://x', datetime.now(timezone.utc))
        assert healthy['status'] == 'ok', 'a fleet with nothing stuck stays ok'
        assert healthy['stuck_aliases'] == []
    finally:
        watchdog_module.run_psql = original

    # Those ran against a FAKED psql: they prove the verdict, not the SQL. These pin it.
    query = watchdog_module.CLAIMED_NOT_STARTED_QUERY
    assert "status IN ('leased', 'accepted')" in query, 'looks at claimed, not pending, rows'
    assert 'execution_started_at IS NULL' in query, 'only rows that never began executing'
    assert 'claimed_at < now() - interval' in query, 'age is what turns unstarted into a fault'
    print('✓ Claimed-but-never-started aliases are reported as critical')


def test_dead_letters_both_tables():
    """`dead_letters` (retries exhausted) and `outbox_dead_letters` (never left the sender's
    outbox) are two different tables; counting only one hides the other's backlog, and a
    missing table must fail closed rather than report a silent partial total."""
    watchdog_module = load_watchdog_module()
    original = watchdog_module.run_psql
    try:
        watchdog_module.run_psql = lambda *_args, **_kwargs: (
            'table_name|open_count\n'
            'dead_letters|7\n'
            'outbox_dead_letters|5\n'
        )
        check = watchdog_module.check_dead_letters('postgres://x')
        assert check['status'] == 'warning', f'12 open beats the threshold (got {check["status"]})'
        assert check['open_count'] == 12, check['open_count']
        assert check['by_table'] == {'dead_letters': 7, 'outbox_dead_letters': 5}, check['by_table']

        watchdog_module.run_psql = lambda *_args, **_kwargs: 'table_name|open_count\ndead_letters|7\n'
        partial = watchdog_module.check_dead_letters('postgres://x')
        assert partial['status'] == 'read-error', f'a missing table must fail closed (got {partial})'
    finally:
        watchdog_module.run_psql = original
    print('✓ Dead letters are counted across both tables and fail closed when one is missing')


def test_check_systemd_covers_user_scope():
    """Container and pty adapters run as user units (`cauce-v3-container-*`, `cauce-v3-pty@*`);
    a check that only asks systemctl at system scope never sees them fail."""
    watchdog_module = load_watchdog_module()

    class FakeCompletedProcess:
        def __init__(self, stdout, returncode=0, stderr=''):
            self.stdout = stdout
            self.returncode = returncode
            self.stderr = stderr

    calls = []

    def fake_run(args, **_kwargs):
        calls.append(args)
        if '--user' in args:
            return FakeCompletedProcess(json.dumps([
                {'unit': 'cauce-v3-container-argos.service', 'active': 'failed', 'sub': 'failed'},
            ]))
        return FakeCompletedProcess('[]')

    original = watchdog_module.subprocess.run
    try:
        watchdog_module.subprocess.run = fake_run
        check = watchdog_module.check_systemd()
        assert check['status'] == 'critical', check
        assert any('--user' in call for call in calls), 'must ask systemctl --user, not only system scope'
        assert 'user:cauce-v3-container-argos.service' in check['failed_units'], check['failed_units']
    finally:
        watchdog_module.subprocess.run = original
    print('✓ check_systemd checks both system and user scope')


def test_check_systemd_env_var_does_not_shadow_function():
    """CAUCE_CHECK_SYSTEMD=1 used to be stashed in a local variable named `check_systemd`
    inside main(), shadowing the module-level function of the same name: `checks['systemd']
    = check_systemd()` then tried to call a bool and crashed with TypeError."""
    watchdog_module = load_watchdog_module()

    class FakeCompletedProcess:
        def __init__(self, stdout='[]', returncode=0, stderr=''):
            self.stdout = stdout
            self.returncode = returncode
            self.stderr = stderr

    original_run_psql = watchdog_module.run_psql
    original_subprocess_run = watchdog_module.subprocess.run
    original_argv = sys.argv[:]
    original_environ = os.environ.copy()

    try:
        watchdog_module.run_psql = lambda *_args, **_kwargs: ''
        watchdog_module.subprocess.run = lambda *_args, **_kwargs: FakeCompletedProcess()
        with tempfile.TemporaryDirectory() as tmpdir:
            os.environ['CAUCE_DATABASE_URL'] = 'postgres://fake'
            os.environ['CAUCE_CHECK_SYSTEMD'] = '1'
            os.environ['CAUCE_WATCHDOG_STATE_FILE'] = str(pathlib.Path(tmpdir) / 'state.json')
            sys.argv = ['fleet-watchdog.py']
            try:
                watchdog_module.main()
            except SystemExit as exit_error:
                assert exit_error.code in (0, None), f'main() must exit 0 (got {exit_error.code})'
            else:
                raise AssertionError('main() must call sys.exit')
    finally:
        watchdog_module.run_psql = original_run_psql
        watchdog_module.subprocess.run = original_subprocess_run
        sys.argv[:] = original_argv
        os.environ.clear()
        os.environ.update(original_environ)
    print('✓ CAUCE_CHECK_SYSTEMD=1 no longer shadows check_systemd()')


if __name__ == '__main__':
    test_script_exists()
    test_missing_database_url()
    test_parse_psql_rows()
    test_psql_preserves_headers_and_rejects_sql_errors()
    test_timezone_aware_checks_and_legacy_state()
    test_enabled_registry_extends_expected_lease_coverage_fail_closed()
    test_oldest_pending_is_not_hidden_by_recent_work()
    test_state_file()
    test_output_formats()
    test_claimed_not_started()
    test_dead_letters_both_tables()
    test_check_systemd_covers_user_scope()
    test_check_systemd_env_var_does_not_shadow_function()
    print('\n✓ All tests passed')
