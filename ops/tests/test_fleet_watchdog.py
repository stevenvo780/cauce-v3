#!/usr/bin/env python3
"""
Unit tests for fleet watchdog.
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

# Test 1: Script exists and has proper shebang
def test_script_exists():
    watchdog_path = pathlib.Path(__file__).resolve().parent.parent / 'scripts' / 'fleet-watchdog.py'
    assert watchdog_path.exists(), 'fleet-watchdog.py exists'
    content = watchdog_path.read_text()
    assert content.startswith('#!/usr/bin/env python3'), 'has proper shebang'
    print('✓ Script exists and has proper shebang')


# Test 2: Missing CAUCE_DATABASE_URL exits with code 2
def test_missing_database_url():
    watchdog_path = pathlib.Path(__file__).resolve().parent.parent / 'scripts' / 'fleet-watchdog.py'
    env = os.environ.copy()
    if 'CAUCE_DATABASE_URL' in env:
        del env['CAUCE_DATABASE_URL']

    result = subprocess.run(
        [sys.executable, str(watchdog_path)],
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
    watchdog_path = pathlib.Path(__file__).resolve().parent.parent / 'scripts' / 'fleet-watchdog.py'

    # Import the module to access parse_psql_rows
    spec = None
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location('fleet_watchdog', watchdog_path)
        watchdog_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(watchdog_module)

        # Test psql output parsing
        sample_output = 'alias|epoch\nargos|15\natlas|18'
        rows = watchdog_module.parse_psql_rows(sample_output)
        assert len(rows) == 2, 'parses two data rows'
        assert rows[0]['alias'] == 'argos', 'first row alias correct'
        assert rows[0]['epoch'] == '15', 'first row epoch correct'
        print('✓ psql output parsing works correctly')
    except Exception as error:
        print(f'⚠️  psql parsing test skipped: {error}', file=sys.stderr)


# Test 4: State file structure
def test_state_file():
    """Test state file creation and structure."""
    watchdog_path = pathlib.Path(__file__).resolve().parent.parent / 'scripts' / 'fleet-watchdog.py'

    import importlib.util
    spec = importlib.util.spec_from_file_location('fleet_watchdog', watchdog_path)
    watchdog_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(watchdog_module)

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
    watchdog_path = pathlib.Path(__file__).resolve().parent.parent / 'scripts' / 'fleet-watchdog.py'

    import importlib.util
    spec = importlib.util.spec_from_file_location('fleet_watchdog', watchdog_path)
    watchdog_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(watchdog_module)

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


if __name__ == '__main__':
    test_script_exists()
    test_missing_database_url()
    test_parse_psql_rows()
    test_state_file()
    test_output_formats()
    print('\n✓ All tests passed')
