# Fleet Watchdog — Cauce V3 Health Monitoring

## Overview

The fleet watchdog is a read-only periodic health check for the Cauce V3 system. It detects anomalies without writing anything, following the principle: **"if data can't be read, say so; never assume zero = healthy"**.

**Location:** `ops/scripts/fleet-watchdog.py`

## What It Detects

### 1. Connection Leases (Critical)
- **Offline aliases:** No `connection_leases` entry OR `lease_until <= now()`
- **Stale heartbeat:** `last_heartbeat_at` older than 30 minutes

**Expected aliases (14):** argos, atlas, dedalo, hegel, iza, janus, jarvis, kant, kratos, midas, salva, seneca, socrates, vulcano

### 2. Dead/Failed Deliveries (Warning)
- **New dead:** `status='dead' AND terminal_at >= last_run_at`
- **New failed:** `status='failed' AND terminal_at >= last_run_at`
- Tracks changes since last run (avoids repetitive alerts)

### 3. Dead Letters (Warning)
- **Excessive:** `COUNT(outbox_dead_letters WHERE resolved_at IS NULL) > 10`
- Global queue depth; no per-alias tracking

### 4. Epoch Anomalies (Warning)
- **Reconnection loops:** `connection_leases.epoch >> average`
- Detection: any epoch > 2x average is flagged
- Example: janus at 7597 vs peers at 19-32

### 5. Pending Unclaimed (Warning)
- **Stuck:** `status='pending' AND available_at < now() - 60 min`
- Per-alias tracking; age included in output

### 6. Systemd Units (Critical, Optional)
- **Failed units:** `ssh kratos systemctl list-units | grep cauce-v3-alias.*failed`
- Requires `CAUCE_CHECK_SYSTEMD=1`
- Requires SSH access to kratos

## Thresholds

| Check | Threshold | Unit |
|-------|-----------|------|
| Heartbeat stale | 30 | minutes |
| Pending unclaimed | 60 | minutes |
| Dead letters | 10 | count |
| Epoch outlier | 2.0× | average |

## Usage

### Basic Run (Read-Only Check)

```bash
export CAUCE_DATABASE_URL="postgresql://user:pass@host/cauce"
python3 ops/scripts/fleet-watchdog.py \
  --output-json /tmp/watchdog-report.json \
  --output-text /tmp/watchdog-report.txt
```

### With Systemd Check (Requires SSH)

```bash
export CAUCE_DATABASE_URL="postgresql://user:pass@host/cauce"
export CAUCE_CHECK_SYSTEMD=1
python3 ops/scripts/fleet-watchdog.py \
  --output-json /tmp/watchdog-report.json \
  --output-text /tmp/watchdog-report.txt
```

### Periodic Run (e.g., every 5 minutes)

```bash
# In cron or systemd timer:
0 * * * * /workspace/cauce-v3/ops/scripts/fleet-watchdog.py \
  --output-json /var/lib/cauce/watchdog-latest.json \
  --output-text /var/lib/cauce/watchdog-latest.txt
```

## Output Formats

### JSON Output (`--output-json FILE`)

Machine-readable report with full check details:

```json
{
  "timestamp": "2026-07-25T13:47:57.266759",
  "status": "healthy | warning | critical | unknown",
  "checks": {
    "connection_leases": {
      "status": "ok | warning | critical | read-error",
      "message": "...",
      "offline": ["dedalo", "vulcano"],
      "stale_heartbeat": [
        { "alias": "atlas", "stale_min": 41 }
      ]
    },
    "dead_failed_deliveries": {
      "status": "ok | warning | read-error",
      "message": "...",
      "new_dead": { "atlas": 5 },
      "new_failed": { "kratos": 2 }
    },
    "dead_letters": {
      "status": "ok | warning | read-error",
      "message": "...",
      "open_count": 12
    },
    "epochs": {
      "status": "ok | warning | read-error",
      "message": "...",
      "anomalies": [
        { "alias": "janus", "epoch": 7597, "avg_epoch": 25 }
      ]
    },
    "pending": {
      "status": "ok | warning | read-error",
      "message": "...",
      "pending_aliases": [
        { "alias": "atlas", "count": 12, "age_min": 65 }
      ]
    }
  },
  "state_file": "/tmp/cauce-watchdog.state",
  "state_file_status": "ok | uninitialized | read-error | write-error"
}
```

### Text Output (`--output-text FILE`)

Human-readable summary (suitable for Telegram):

```
🔴 CRITICAL
  🔴 connection_leases: 2 offline, 1 stale heartbeat
     Offline: dedalo, vulcano
     Stale: atlas (41m)

  ⚠️  dead_letters: 12 open (threshold: 10)
     Dead letters: 12

  ⚠️  epochs: 1 aliases with anomalous epochs
     Epochs: janus:7597

  ⚠️  pending: 1 aliases with old pending deliveries
     Pending: atlas:12/65m
```

## State File

The watchdog maintains persistent state to track changes and avoid alert noise:

**Location:** `/tmp/cauce-watchdog.state` (configurable via `CAUCE_WATCHDOG_STATE_FILE`)

**Structure:**

```json
{
  "last_run_at": "2026-07-25T13:47:57.266759",
  "aliases": {
    "argos": { "last_epoch": 15 },
    "atlas": { "last_epoch": 18 }
  },
  "previous_alerts": {
    "connection_leases": { "status": "critical", "at": "2026-07-25T13:47:57.266759" }
  }
}
```

This enables:
- Detecting NEW dead/failed deliveries (vs repeating the same alert)
- Tracking alias epoch history for comparison
- Recording when alerts last fired

## Integration Points

### Telegram Egress (Proactive Outbound)

The text output can be integrated with the Telegram bridge via the egress module:

```
POST /v3/messages
{
  "room_id": "grp.steven",
  "recipients": [{"tenant_id": "Steven", "alias": "steven"}],
  "body": { "text": "🔴 CRITICAL — 2 offline aliases..." }
}
```

### Monitoring / Alerting Systems

The JSON output can be:
- Consumed by Prometheus exporters
- Pushed to Sentry or other APM
- Polled by external dashboards
- Analyzed for trends

### Return Codes

- **0:** Check completed (status: healthy, warning, or critical)
- **2:** Fatal error (database unreachable, permission denied, env var missing)

## Design Principles

### 1. No State That Lies

If a query fails, the check reports `read-error`, not `ok`. The overall status becomes `unknown`, not `healthy`. This is critical: a watchdog that reports green when it can't read is worse than no watchdog.

### 2. No Noise

State file tracks:
- What was already alerted (prevents duplicate reports)
- Per-alias trends (epoch progression, pending age)
- Timestamp of last alert for each check

Only **changes** trigger new alerts, not static conditions.

### 3. Read-Only, Idempotent

- `BEGIN READ ONLY` before every query
- Multiple runs produce identical results
- Safe to run frequently (e.g., every 5 min)
- No write effects except state file

### 4. Zero Dependencies

- Uses `psql` command-line tool (already required for ops)
- No Python packages (standard library only)
- No Node.js modules
- Shell-friendly (env vars, exit codes)

## Testing

### Unit Tests

```bash
python3 ops/tests/test_fleet_watchdog.py
```

Tests:
- Script shebang and structure
- Missing database URL handling
- State file load/save
- JSON/text output format validation
- psql output parsing

### Integration Test (With Real Database)

```bash
export CAUCE_DATABASE_URL="postgresql://..."
export TEST_WITH_REAL_DB=1
python3 ops/tests/test_fleet_watchdog.py
```

## Example: Detecting the Exact Incident Scenario

**Problem (2026-07-23):**
- `dedalo`, `vulcano` offline for 7+ hours
- `janus` reconnected 7577 times (epoch 7597 vs 19-32)
- 9 dead letters accumulated
- No alerts fired

**Watchdog Output:**

```json
{
  "status": "critical",
  "checks": {
    "connection_leases": {
      "status": "critical",
      "message": "2 offline, 0 stale heartbeat",
      "offline": ["dedalo", "vulcano"],
      "stale_heartbeat": []
    },
    "epochs": {
      "status": "warning",
      "message": "1 aliases with anomalous epochs",
      "anomalies": [
        { "alias": "janus", "epoch": 7597, "avg_epoch": 25 }
      ]
    },
    "dead_letters": {
      "status": "warning",
      "message": "9 open (threshold: 10)",
      "open_count": 9
    }
  }
}
```

**Text for Telegram:**

```
🔴 CRITICAL
  🔴 connection_leases: 2 offline, 0 stale heartbeat
     Offline: dedalo, vulcano

  ⚠️  epochs: 1 aliases with anomalous epochs
     Epochs: janus:7597

  ⚠️  dead_letters: 9 open (threshold: 10)
     Dead letters: 9
```

This would have alerted immediately.

## Troubleshooting

### "psql not found"

PostgreSQL client tools are required:

```bash
# Linux
sudo apt-get install postgresql-client

# macOS
brew install libpq
```

### "cannot connect to database"

Verify `CAUCE_DATABASE_URL`:

```bash
psql "$CAUCE_DATABASE_URL" -c "SELECT 1"
```

### "permission denied"

The user in `CAUCE_DATABASE_URL` needs:
- `CONNECT` privilege on the database
- `SELECT` on relevant tables (all checks are read-only)

```sql
GRANT CONNECT ON DATABASE cauce TO your_user;
GRANT SELECT ON connection_leases, deliveries, outbox_dead_letters TO your_user;
```

### "state file permission denied"

Ensure `CAUCE_WATCHDOG_STATE_FILE` directory is writable:

```bash
mkdir -p /var/lib/cauce
chmod 0755 /var/lib/cauce
```

## Future Enhancements

- [ ] Custom threshold config file
- [ ] Per-alias thresholds (different tolerance for different agents)
- [ ] Webhook integration (POST alerts to external systems)
- [ ] History retention (track trends over time)
- [ ] Dead letter detail (which adapter, which tenant)
- [ ] Systemd integration (auto-restart failed units)
