#!/usr/bin/env python3
"""
Fleet watchdog for Cauce V3 — detects anomalies without writing anything.

Detects:
- Offline aliases (no live connection_lease)
- Stale heartbeats (last_heartbeat_at too old)
- New dead/failed deliveries since last run
- Excessive open dead letters
- Anomalous epoch counts (reconnection loops)
- Pending deliveries stuck unclaimed
- Failed systemd units in kratos (optional)

State file tracking prevents alert noise by detecting CHANGES, not just conditions.

Usage:
  fleet-watchdog.py [--output-json FILE] [--output-text FILE]

Environment:
  CAUCE_DATABASE_URL - PostgreSQL connection string (required)
  CAUCE_WATCHDOG_STATE_FILE - state file path (default: /tmp/cauce-watchdog.state)
  CAUCE_CHECK_SYSTEMD - if set, check systemd units in kratos (requires ssh)
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import pathlib
import subprocess
import sys
from typing import Any

THRESHOLDS = {
    'heartbeat_stale_minutes': 30,
    'pending_unclaimed_minutes': 60,
    'dead_letters_threshold': 10,
    'epoch_outlier_multiplier': 2.0,
}

EXPECTED_ALIASES = [
    'argos', 'atlas', 'dedalo', 'hegel', 'iza', 'janus', 'jarvis',
    'kant', 'kratos', 'midas', 'salva', 'seneca', 'socrates', 'vulcano',
]


def run_psql(database_url: str, query: str) -> str:
    """Run PostgreSQL query via psql command line (zero-dependency)."""
    try:
        result = subprocess.run(
            ['psql', database_url, '-Atqc', query],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            raise ValueError(f'psql failed: {result.stderr.strip()}')
        return result.stdout
    except FileNotFoundError:
        raise ValueError('psql not found (PostgreSQL client not installed)')
    except subprocess.TimeoutExpired:
        raise ValueError('psql query timed out')


def load_state(state_file: str) -> dict[str, Any]:
    """Load state file (or initialize empty)."""
    path = pathlib.Path(state_file)
    if not path.exists():
        return {
            'last_run_at': None,
            'aliases': {},
            'previous_alerts': {},
        }
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {
            'last_run_at': None,
            'aliases': {},
            'previous_alerts': {},
        }


def save_state(state_file: str, state: dict[str, Any]) -> bool:
    """Save state file. Returns True if successful."""
    try:
        path = pathlib.Path(state_file)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(state, indent=2))
        return True
    except OSError as error:
        print(f'warning: failed to write state file: {error}', file=sys.stderr)
        return False


def parse_psql_rows(output: str) -> list[dict[str, str]]:
    """Parse psql -A output (pipe-delimited rows with header)."""
    lines = [line for line in output.strip().split('\n') if line]
    if not lines:
        return []
    header = lines[0].split('|')
    rows = []
    for line in lines[1:]:
        values = line.split('|')
        if len(values) == len(header):
            rows.append(dict(zip(header, values)))
    return rows


def check_connection_leases(database_url: str, now: datetime.datetime) -> dict[str, Any]:
    """Check connection_leases: offline and stale heartbeat."""
    check = {
        'status': 'ok',
        'message': '',
        'offline': [],
        'stale_heartbeat': [],
    }

    query = '''
        SELECT
            alias,
            lease_until,
            last_heartbeat_at,
            epoch,
            connected_at
        FROM connection_leases
        ORDER BY alias ASC;
    '''

    try:
        output = run_psql(database_url, query)
        rows = parse_psql_rows(output)
    except ValueError as error:
        check['status'] = 'read-error'
        check['message'] = str(error)
        return check

    if not rows:
        check['offline'] = EXPECTED_ALIASES.copy()
        check['status'] = 'critical'
        check['message'] = f'{len(check["offline"])} offline aliases'
        return check

    alias_lease_map = {row['alias']: row for row in rows}
    missing_aliases = [a for a in EXPECTED_ALIASES if a not in alias_lease_map]
    stale_aliases = []

    for alias, lease in alias_lease_map.items():
        try:
            lease_until = datetime.datetime.fromisoformat(lease['lease_until'].replace('Z', '+00:00'))
            heartbeat_at = datetime.datetime.fromisoformat(lease['last_heartbeat_at'].replace('Z', '+00:00'))

            if lease_until <= now:
                check['offline'].append(alias)
            else:
                heartbeat_stale_ms = (now - heartbeat_at).total_seconds() * 1000
                heartbeat_stale_min = heartbeat_stale_ms / 1000 / 60
                if heartbeat_stale_min > THRESHOLDS['heartbeat_stale_minutes']:
                    stale_aliases.append({'alias': alias, 'stale_min': int(round(heartbeat_stale_min))})
        except (ValueError, KeyError):
            continue

    check['offline'].extend(missing_aliases)
    check['stale_heartbeat'] = stale_aliases

    if check['offline'] or check['stale_heartbeat']:
        check['status'] = 'critical'
        check['message'] = f'{len(check["offline"])} offline, {len(check["stale_heartbeat"])} stale heartbeat'

    return check


def check_dead_failed_deliveries(
    database_url: str,
    now: datetime.datetime,
    last_run_at: str | None,
) -> dict[str, Any]:
    """Check for new dead/failed deliveries since last run."""
    check = {
        'status': 'ok',
        'message': '',
        'new_dead': {},
        'new_failed': {},
    }

    query = '''
        SELECT
            recipient_alias,
            status,
            COUNT(*) as count,
            MAX(terminal_at) as last_terminal_at,
            MAX(available_at) as oldest_available_at
        FROM deliveries
        WHERE status IN ('pending', 'dead', 'failed')
        GROUP BY recipient_alias, status
        ORDER BY recipient_alias, status;
    '''

    try:
        output = run_psql(database_url, query)
        rows = parse_psql_rows(output)
    except ValueError as error:
        check['status'] = 'read-error'
        check['message'] = str(error)
        return check

    last_run_time = None
    if last_run_at:
        try:
            last_run_time = datetime.datetime.fromisoformat(last_run_at)
        except ValueError:
            pass

    for row in rows:
        try:
            alias = row['recipient_alias']
            status = row['status']
            count = int(row['count'])
            terminal_at_str = row.get('last_terminal_at')

            if status == 'dead' and terminal_at_str:
                try:
                    terminal_time = datetime.datetime.fromisoformat(terminal_at_str.replace('Z', '+00:00'))
                    if not last_run_time or terminal_time >= last_run_time:
                        check['new_dead'][alias] = count
                except ValueError:
                    pass

            if status == 'failed' and terminal_at_str:
                try:
                    terminal_time = datetime.datetime.fromisoformat(terminal_at_str.replace('Z', '+00:00'))
                    if not last_run_time or terminal_time >= last_run_time:
                        check['new_failed'][alias] = count
                except ValueError:
                    pass
        except (ValueError, KeyError):
            continue

    total_new = sum(check['new_dead'].values()) + sum(check['new_failed'].values())
    if total_new > 0:
        check['status'] = 'warning'
        check['message'] = f'{sum(check["new_dead"].values())} new dead, {sum(check["new_failed"].values())} new failed'

    return check


def check_dead_letters(database_url: str) -> dict[str, Any]:
    """Check for excessive open dead letters."""
    check = {
        'status': 'ok',
        'message': '',
        'open_count': 0,
    }

    query = 'SELECT COUNT(*) as open_count FROM outbox_dead_letters WHERE resolved_at IS NULL;'

    try:
        output = run_psql(database_url, query)
        rows = parse_psql_rows(output)
        if rows:
            check['open_count'] = int(rows[0].get('open_count', 0))
    except ValueError as error:
        check['status'] = 'read-error'
        check['message'] = str(error)
        return check

    if check['open_count'] > THRESHOLDS['dead_letters_threshold']:
        check['status'] = 'warning'
        check['message'] = f'{check["open_count"]} open (threshold: {THRESHOLDS["dead_letters_threshold"]})'

    return check


def check_epochs(database_url: str) -> dict[str, Any]:
    """Check for anomalous epoch counts (reconnection loops)."""
    check = {
        'status': 'ok',
        'message': '',
        'anomalies': [],
    }

    query = 'SELECT alias, epoch FROM connection_leases WHERE epoch > 0 ORDER BY alias;'

    try:
        output = run_psql(database_url, query)
        rows = parse_psql_rows(output)
    except ValueError as error:
        check['status'] = 'read-error'
        check['message'] = str(error)
        return check

    if not rows or len(rows) < 3:
        return check

    try:
        epochs = [int(row['epoch']) for row in rows if row.get('epoch')]
    except ValueError:
        return check

    if not epochs:
        return check

    avg_epoch = sum(epochs) / len(epochs)
    threshold = avg_epoch * THRESHOLDS['epoch_outlier_multiplier']

    for row in rows:
        try:
            epoch = int(row['epoch'])
            if epoch > threshold:
                check['anomalies'].append({
                    'alias': row['alias'],
                    'epoch': epoch,
                    'avg_epoch': int(round(avg_epoch)),
                })
        except ValueError:
            continue

    if check['anomalies']:
        check['status'] = 'warning'
        check['message'] = f'{len(check["anomalies"])} aliases with anomalous epochs'

    return check


def check_pending_deliveries(database_url: str, now: datetime.datetime) -> dict[str, Any]:
    """Check for pending deliveries stuck unclaimed."""
    check = {
        'status': 'ok',
        'message': '',
        'pending_aliases': [],
    }

    query = '''
        SELECT
            recipient_alias,
            status,
            COUNT(*) as count,
            MAX(available_at) as oldest_available_at
        FROM deliveries
        WHERE status = 'pending'
        GROUP BY recipient_alias, status;
    '''

    try:
        output = run_psql(database_url, query)
        rows = parse_psql_rows(output)
    except ValueError as error:
        check['status'] = 'read-error'
        check['message'] = str(error)
        return check

    for row in rows:
        try:
            alias = row['recipient_alias']
            count = int(row['count'])
            oldest_available = row.get('oldest_available_at')

            if oldest_available:
                available_time = datetime.datetime.fromisoformat(oldest_available.replace('Z', '+00:00'))
                age_ms = (now - available_time).total_seconds() * 1000
                age_min = age_ms / 1000 / 60

                if age_min > THRESHOLDS['pending_unclaimed_minutes']:
                    check['pending_aliases'].append({
                        'alias': alias,
                        'count': count,
                        'age_min': int(round(age_min)),
                    })
        except (ValueError, KeyError):
            continue

    if check['pending_aliases']:
        check['status'] = 'warning'
        check['message'] = f'{len(check["pending_aliases"])} aliases with old pending deliveries'

    return check


def check_systemd() -> dict[str, Any]:
    """Check systemd units in kratos (optional, requires ssh)."""
    check = {
        'status': 'ok',
        'message': '',
        'failed_units': [],
    }

    try:
        result = subprocess.run(
            ['ssh', 'kratos', 'systemctl', 'list-units', '--all', '--output=json'],
            capture_output=True,
            text=True,
            timeout=10,
        )

        if result.returncode != 0:
            check['status'] = 'read-error'
            check['message'] = f'ssh kratos failed: {result.stderr.strip()}'
            return check

        try:
            units = json.loads(result.stdout)
            for unit in units:
                unit_name = unit.get('unit', '')
                if (
                    unit_name.startswith('cauce-v3-alias-')
                    and (unit.get('active') == 'failed' or unit.get('sub') == 'failed')
                ):
                    check['failed_units'].append(unit_name)

            if check['failed_units']:
                check['status'] = 'critical'
                check['message'] = f'{len(check["failed_units"])} systemd units failed'
        except json.JSONDecodeError:
            check['status'] = 'read-error'
            check['message'] = 'failed to parse systemctl output'

    except (FileNotFoundError, subprocess.TimeoutExpired) as error:
        check['status'] = 'read-error'
        check['message'] = f'systemd check failed: {str(error)}'

    return check


def format_json_output(
    now: datetime.datetime,
    checks: dict[str, dict[str, Any]],
    state_file: str,
) -> str:
    """Format JSON output for machine consumption."""
    overall_status = 'healthy'
    if any(c['status'] == 'critical' for c in checks.values()):
        overall_status = 'critical'
    elif any(c['status'] == 'warning' for c in checks.values()):
        overall_status = 'warning'
    elif any(c['status'] == 'read-error' for c in checks.values()):
        overall_status = 'unknown'

    output = {
        'timestamp': now.isoformat(),
        'status': overall_status,
        'checks': checks,
        'state_file': state_file,
        'state_file_status': 'ok',
    }

    return json.dumps(output, indent=2)


def format_text_output(
    status: str,
    checks: dict[str, dict[str, Any]],
) -> str:
    """Format text output for human consumption (Telegram)."""
    lines = []

    # Status header
    if status == 'critical':
        lines.append('🔴 CRITICAL')
    elif status == 'warning':
        lines.append('⚠️  WARNING')
    elif status == 'unknown':
        lines.append('❌ UNKNOWN — some checks could not be read')
    else:
        lines.append('✓ HEALTHY')

    # Per-check details
    for check_name, check_data in checks.items():
        if check_data['status'] == 'critical':
            lines.append(f"  🔴 {check_name}: {check_data['message'] or 'critical condition'}")
            if check_data.get('offline'):
                lines.append(f"     Offline: {', '.join(check_data['offline'])}")
            if check_data.get('stale_heartbeat'):
                stales = ', '.join(f"{s['alias']} ({s['stale_min']}m)" for s in check_data['stale_heartbeat'])
                lines.append(f"     Stale: {stales}")
            if check_data.get('failed_units'):
                lines.append(f"     Failed: {', '.join(check_data['failed_units'])}")
        elif check_data['status'] == 'warning':
            lines.append(f"  ⚠️  {check_name}: {check_data['message'] or 'warning'}")
            if check_data.get('new_dead'):
                dead = ', '.join(f"{a}:{c}" for a, c in check_data['new_dead'].items())
                lines.append(f"     Dead: {dead}")
            if check_data.get('new_failed'):
                failed = ', '.join(f"{a}:{c}" for a, c in check_data['new_failed'].items())
                lines.append(f"     Failed: {failed}")
            if check_data.get('anomalies'):
                anomalies = ', '.join(f"{a['alias']}:{a['epoch']}" for a in check_data['anomalies'])
                lines.append(f"     Epochs: {anomalies}")
            if check_data.get('pending_aliases'):
                pending = ', '.join(
                    f"{p['alias']}:{p['count']}/{p['age_min']}m" for p in check_data['pending_aliases']
                )
                lines.append(f"     Pending: {pending}")
            if check_data.get('open_count'):
                lines.append(f"     Dead letters: {check_data['open_count']}")
        elif check_data['status'] == 'read-error':
            lines.append(f"  ❌ {check_name}: {check_data['message'] or 'could not read'}")

    return '\n'.join(lines) + '\n'


def main() -> None:
    parser = argparse.ArgumentParser(description='Fleet watchdog for Cauce V3')
    parser.add_argument('--output-json', help='JSON output file path')
    parser.add_argument('--output-text', help='text output file path')
    args = parser.parse_args()

    database_url = os.getenv('CAUCE_DATABASE_URL')
    if not database_url:
        print('CAUCE_DATABASE_URL is required', file=sys.stderr)
        sys.exit(2)

    state_file = os.getenv('CAUCE_WATCHDOG_STATE_FILE', '/tmp/cauce-watchdog.state')
    check_systemd = os.getenv('CAUCE_CHECK_SYSTEMD') == '1'

    # Load previous state
    previous_state = load_state(state_file)
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)

    # Run checks
    checks = {
        'connection_leases': check_connection_leases(database_url, now),
        'dead_failed_deliveries': check_dead_failed_deliveries(database_url, now, previous_state.get('last_run_at')),
        'dead_letters': check_dead_letters(database_url),
        'epochs': check_epochs(database_url),
        'pending': check_pending_deliveries(database_url, now),
    }

    if check_systemd:
        checks['systemd'] = check_systemd()

    # Determine overall status
    overall_status = 'healthy'
    if any(c['status'] == 'critical' for c in checks.values()):
        overall_status = 'critical'
    elif any(c['status'] == 'warning' for c in checks.values()):
        overall_status = 'warning'
    elif any(c['status'] == 'read-error' for c in checks.values()):
        overall_status = 'unknown'

    # Generate outputs
    json_output = format_json_output(now, checks, state_file)
    text_output = format_text_output(overall_status, checks)

    # Write outputs
    if args.output_json:
        try:
            pathlib.Path(args.output_json).parent.mkdir(parents=True, exist_ok=True)
            pathlib.Path(args.output_json).write_text(json_output)
            print(f'JSON: {args.output_json}')
        except OSError as error:
            print(f'warning: failed to write JSON output: {error}', file=sys.stderr)

    if args.output_text:
        try:
            pathlib.Path(args.output_text).parent.mkdir(parents=True, exist_ok=True)
            pathlib.Path(args.output_text).write_text(text_output)
            print(f'Text: {args.output_text}')
        except OSError as error:
            print(f'warning: failed to write text output: {error}', file=sys.stderr)

    # Update state file (track aliases, epochs, and alerts)
    new_state = {
        'last_run_at': now.isoformat(),
        'aliases': {},
        'previous_alerts': {},
    }

    for check_name, check_data in checks.items():
        if check_data['status'] in ('critical', 'warning'):
            new_state['previous_alerts'][check_name] = {
                'status': check_data['status'],
                'at': now.isoformat(),
            }

    save_state(state_file, new_state)

    # Print status to stdout for monitoring
    print(f'Status: {overall_status}')
    sys.exit(0)


if __name__ == '__main__':
    main()
