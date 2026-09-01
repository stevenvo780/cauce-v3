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


if __name__ == '__main__':
    test_script_exists()
    test_missing_database_url()
    test_parse_psql_rows()
    test_state_file()
    test_output_formats()
    test_claimed_not_started()
    print('\n✓ All tests passed')
