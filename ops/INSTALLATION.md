# Gate Collector and Watchdog/Reconciler Installation Procedure

This document describes the complete installation procedure for the gate collector and related systemd services (watchdog and reconciler timers) on kratos. **Do not execute** these commands; instead, use them as the basis for your installation automation.

## Prerequisites

- Kratos host with systemd (user or system scope)
- PostgreSQL connection string (CAUCE_DATABASE_URL)
- Node.js 18+ available in PATH
- Read-only PostgreSQL access (no writes required)

## Installation Steps

### 1. Create Required Directories

Create the directories for gate artifacts and configurations:

```bash
# On kratos, as the cauce-v3 user (or with appropriate privileges)
mkdir -p /etc/cauce-v3/guards
mkdir -p /var/lib/cauce-v3/gates
mkdir -p /var/run/cauce-v3
chmod 0700 /etc/cauce-v3/guards
chmod 0755 /var/lib/cauce-v3/gates
```

### 2. Install the Gate Collector

Copy the collector script to a system-accessible location:

```bash
# Copy from repo (assuming repo is at /workspace/cauce-v3)
install -m 0755 /workspace/cauce-v3/ops/scripts/gate-collector.mjs /usr/local/bin/cauce-gate-collector

# Verify installation
file /usr/local/bin/cauce-gate-collector
# Should show: Node.js script
```

### 3. Create Gate Collector Environment File

Create `/etc/cauce-v3/guards/gate-collector.env` with database configuration:

```bash
cat > /etc/cauce-v3/guards/gate-collector.env << 'EOF'
# Gate collector environment variables
CAUCE_DATABASE_URL="postgresql://user:password@localhost:5432/cauce_v3"
CAUCE_GATE_CAPTURE_PATH="/usr/local/bin/cauce-gate-collector"
CAUCE_GATE_MAX_AGE_SECONDS="120"
CAUCE_MAX_WAKE_PENDING="1000"
CAUCE_MAX_OUTBOX_PENDING="500"
CAUCE_MAX_RELAY_PENDING="300"
EOF
chmod 0600 /etc/cauce-v3/guards/gate-collector.env
```

**Important**: Protect the env file since it contains database credentials.

### 4. Create Watchdog Timer and Service

Create `/etc/systemd/user/cauce-v3-watchdog.service`:

```ini
[Unit]
Description=Cauce V3 Migration Gate Watchdog
PartOf=cauce-v3-watchdog.timer
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/cauce-v3/guards/gate-collector.env
ExecStart=/bin/sh -c 'for alias in kant montaigne aristotle leibniz spinoza hume reid kant-mirror montaigne-mirror leibniz-mirror spinoza-mirror hegel; do \
  /usr/local/bin/cauce-gate-collector "$alias" "/var/lib/cauce-v3/gates/${alias}-watchdog.json" watchdog && \
  /usr/bin/node /workspace/cauce-v3/ops/scripts/migration-gate.mjs watchdog "/var/lib/cauce-v3/gates/${alias}-watchdog.json" "$alias" || true; \
done'
StandardOutput=journal
StandardError=journal
SyslogIdentifier=cauce-watchdog
```

Create `/etc/systemd/user/cauce-v3-watchdog.timer`:

```ini
[Unit]
Description=Cauce V3 Migration Gate Watchdog Timer
Requires=cauce-v3-watchdog.service

[Timer]
OnBootSec=30s
OnUnitActiveSec=300s
Persistent=true
RandomizedDelaySec=10s

[Install]
WantedBy=timers.target
```

### 5. Create Reconciler Timer and Service

Create `/etc/systemd/user/cauce-v3-reconciler.service`:

```ini
[Unit]
Description=Cauce V3 Migration Gate Reconciler
PartOf=cauce-v3-reconciler.timer
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/cauce-v3/guards/gate-collector.env
ExecStart=/bin/sh -c 'for alias in kant montaigne aristotle leibniz spinoza hume reid kant-mirror montaigne-mirror leibniz-mirror spinoza-mirror hegel; do \
  /usr/local/bin/cauce-gate-collector "$alias" "/var/lib/cauce-v3/gates/${alias}-reconciler.json" reconciler && \
  /usr/bin/node /workspace/cauce-v3/ops/scripts/migration-gate.mjs reconciler "/var/lib/cauce-v3/gates/${alias}-reconciler.json" "$alias" || true; \
done'
StandardOutput=journal
StandardError=journal
SyslogIdentifier=cauce-reconciler
```

Create `/etc/systemd/user/cauce-v3-reconciler.timer`:

```ini
[Unit]
Description=Cauce V3 Migration Gate Reconciler Timer
Requires=cauce-v3-reconciler.service

[Timer]
OnBootSec=45s
OnUnitActiveSec=600s
Persistent=true
RandomizedDelaySec=15s

[Install]
WantedBy=timers.target
```

### 6. Update Cutover Scripts

Modify the cutover and rollback scripts to use the real collector:

**In `/workspace/cauce-v3/ops/scripts/cutover.sh` (line 15):**

Change:
```bash
: "${CAUCE_GATE_CAPTURE_PATH:?set an absolute executable gate snapshot collector}"
```

To reference the installed collector:
```bash
export CAUCE_GATE_CAPTURE_PATH="${CAUCE_GATE_CAPTURE_PATH:-/usr/local/bin/cauce-gate-collector}"
: "${CAUCE_GATE_CAPTURE_PATH:?set an absolute executable gate snapshot collector}"
```

Do the same in `/workspace/cauce-v3/ops/scripts/cutover-rollback.sh`.

### 7. Enable Timers (User Scope)

For user-scoped services (systemctl --user), run as the cauce-v3 user:

```bash
# As the cauce-v3 user
systemctl --user daemon-reload
systemctl --user enable cauce-v3-watchdog.timer
systemctl --user enable cauce-v3-reconciler.timer
systemctl --user start cauce-v3-watchdog.timer
systemctl --user start cauce-v3-reconciler.timer

# Verify
systemctl --user list-timers cauce-v3-*
systemctl --user status cauce-v3-watchdog.timer
systemctl --user status cauce-v3-reconciler.timer
```

For system-scoped services, use `systemctl` without `--user` and place files in `/etc/systemd/system/`.

### 8. Verify Installation

Test the collector manually:

```bash
# Ensure the env file is sourced
export CAUCE_DATABASE_URL="<your_actual_db_url>"

# Test with an existing alias
/usr/local/bin/cauce-gate-collector kant /tmp/test-drain.json drain

# Check the output
cat /tmp/test-drain.json | jq .

# Verify against migration gate
/usr/bin/node /workspace/cauce-v3/ops/scripts/migration-gate.mjs drain /tmp/test-drain.json kant
```

Expected output on success: `gate drain passed for kant`

### 9. Monitor Watchdog and Reconciler Execution

Once timers are active, monitor logs:

```bash
# For user scope
journalctl --user-unit=cauce-v3-watchdog.service -f
journalctl --user-unit=cauce-v3-reconciler.service -f

# For system scope
journalctl --unit=cauce-v3-watchdog.service -f
journalctl --unit=cauce-v3-reconciler.service -f
```

### 10. Integration with Existing Cutover Workflow

Once installed, the existing cutover.sh and cutover-rollback.sh scripts will:

1. Invoke the gate collector at `/usr/local/bin/cauce-gate-collector`
2. Collect real system state from PostgreSQL
3. Validate against migration-gate.mjs for each phase (drain, post-cutover, rollback-drain, rollback-ready)
4. Proceed or abort based on gate validation

### Troubleshooting

**Collector fails with "CAUCE_DATABASE_URL is required"**

Ensure the environment file is sourced:
```bash
source /etc/cauce-v3/guards/gate-collector.env
```

**Gate validation fails despite collector output**

Check the collected snapshot JSON:
```bash
cat /var/lib/cauce-v3/gates/ALIAS-*.json | jq .
```

Verify it matches the schema in `/workspace/cauce-v3/ops/schemas/gate-snapshot.schema.json`.

**Timer never fires**

Verify the timer is enabled and active:
```bash
systemctl --user list-timers
systemctl --user status cauce-v3-watchdog.timer
```

Check for timer errors:
```bash
journalctl --user-unit=cauce-v3-watchdog.timer -n 50
```

### Rollback

To disable the watchdog and reconciler:

```bash
systemctl --user stop cauce-v3-watchdog.timer cauce-v3-reconciler.timer
systemctl --user disable cauce-v3-watchdog.timer cauce-v3-reconciler.timer
rm /etc/systemd/user/cauce-v3-watchdog.* /etc/systemd/user/cauce-v3-reconciler.*
systemctl --user daemon-reload
```

To uninstall the collector:

```bash
rm /usr/local/bin/cauce-gate-collector
rm /etc/cauce-v3/guards/gate-collector.env
```

## Notes

- The collector performs **read-only** queries; no database modifications occur.
- The 12 aliases must be enumerated in the timer service ExecStart line (currently hardcoded; consider using a configuration file for future enhancements).
- Database credentials in `/etc/cauce-v3/guards/gate-collector.env` should be restricted to the cauce-v3 user (mode 0600).
- Watchdog runs every 5 minutes; reconciler every 10 minutes. Adjust `OnUnitActiveSec` as needed.
