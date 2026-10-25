import json
import os
import pathlib
import shutil
import sys
import time

packet = json.loads(sys.argv[1])
repo = pathlib.Path(packet["repo"])
units = pathlib.Path("/home/node/.config/systemd/user")
for name in ("cauce-v3-host-backup", "cauce-v3-host-backup-monitor"):
    for suffix in ("service", "timer"):
        shutil.copy2(repo / "ops/systemd" / f"{name}.{suffix}", units / f"{name}.{suffix}")
    service = units / f"{name}.service"
    # The real lab daemon is outside this container and exposed through its own socket.
    service.write_text(service.read_text(encoding="utf-8").replace("Requires=docker.service\n", "")
                       .replace("After=docker.service network-online.target", "After=network-online.target"), encoding="utf-8")
    timer_dropin = units / f"{name}.timer.d"
    timer_dropin.mkdir(exist_ok=True)
    (timer_dropin / "lab.conf").write_text("[Timer]\nOnCalendar=\nOnActiveSec=100ms\nRandomizedDelaySec=0\nAccuracySec=10ms\n", encoding="ascii")
    service_dropin = units / f"{name}.service.d"
    service_dropin.mkdir(exist_ok=True)
    script = "host-backup.sh" if name.endswith("backup") else "host-backup-monitor.sh"
    variables = {"STATUS_DIR": "/lab/status", "STATUS_FILE": "/lab/status/status.json", "DB_BACKUP_DIR": "/lab/backups",
                 "BLOB_VOLUME": packet["volume"], "CAUCE_DB_CONTAINER": packet["database"], "CAUCE_DB_USER": "cauce_test",
                 "CAUCE_DB_NAME": "cauce_test", "UT_NEXUS_ENABLED": "0", "OFFSITE_KEY": "/lab/key-does-not-exist",
                 "OFFSITE_HOST": "127.0.0.1", "OFFSITE_USER": "canary", "DB_RETENTION_DAYS": "14", "REQUIRE_BLOB_VOLUME": "1"}
    environment = "".join(f'Environment="{key}={value}"\n' for key, value in variables.items())
    (service_dropin / "lab.conf").write_text(f"[Service]\nEnvironmentFile=\n{environment}ExecStart=\nExecStart={repo}/ops/scripts/{script}\n", encoding="utf-8")
shutil.copy2(repo / "ops/systemd/cauce-v3-backup-alert@.service", units / "cauce-v3-backup-alert@.service")
for directory in (pathlib.Path("/lab/backups"), pathlib.Path("/lab/status")):
    directory.mkdir(parents=True, exist_ok=True)
    directory.chmod(0o700)
    os.chown(directory, 1000, 1000)
old = pathlib.Path("/lab/backups/cauce-20000101T000000Z.dump")
old.write_text("owned retention sentinel\n", encoding="ascii")
old.chmod(0o600)
os.chown(old, 1000, 1000)
os.utime(old, (time.time() - 40 * 86400, time.time() - 40 * 86400))
for parent, dirs, files in os.walk(units):
    os.chown(parent, 1000, 1000)
    for name in (*dirs, *files):
        os.chown(pathlib.Path(parent) / name, 1000, 1000)
