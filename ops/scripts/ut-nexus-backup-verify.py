#!/usr/bin/env python3
"""
Verificación y gestión de respaldos de Ultimate Terminal.

Uso:
  python3 ut-verify.py verify <archivo.sqlite>     # verificar un respaldo
  python3 ut-verify.py list                         # listar respaldos existentes
  python3 ut-verify.py monitor                      # alertar si respaldo es demasiado viejo
"""

import argparse
import datetime as dt
import os
import sqlite3
import sys

ARCHIVE_ROOT = "/opt/_archive/ultimate-terminal"


def ro_connect(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=60)


def verify_backup(backup_file):
    """Verifica un archivo .sqlite"""
    if not os.path.exists(backup_file):
        print(f"ERROR: {backup_file} no existe")
        return False

    try:
        con = ro_connect(backup_file)
        integrity = con.execute("PRAGMA integrity_check").fetchone()[0]
        tables = con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchall()
        fk = con.execute("PRAGMA foreign_key_check").fetchall()
        con.close()

        if integrity != "ok":
            print(f"ERROR: integrity_check = {integrity}")
            return False

        if fk:
            print(f"WARNING: {len(fk)} violaciones de FK")

        print(f"OK: {backup_file}")
        print(f"  Integrity: {integrity}")
        print(f"  Size: {os.path.getsize(backup_file)} bytes")
        print(f"  Tables: {len(tables)}")

        con = ro_connect(backup_file)
        for (tname,) in tables:
            count = con.execute(f"SELECT COUNT(*) FROM {tname}").fetchone()[0]
            print(f"    {tname}: {count} rows")
        con.close()

        return True
    except Exception as e:
        print(f"ERROR: {e}")
        return False


def list_backups():
    """Lista todos los respaldos"""
    if not os.path.isdir(ARCHIVE_ROOT):
        print(f"ERROR: {ARCHIVE_ROOT} no existe")
        return

    backups = []
    for date_dir in sorted(os.listdir(ARCHIVE_ROOT)):
        d = os.path.join(ARCHIVE_ROOT, date_dir)
        if not os.path.isdir(d) or not date_dir[:4].isdigit():
            continue

        for fname in sorted(os.listdir(d)):
            if fname.endswith(".sqlite"):
                fpath = os.path.join(d, fname)
                size = os.path.getsize(fpath)
                mtime = os.path.getmtime(fpath)
                backups.append((fname, date_dir, fpath, size, mtime))

    if not backups:
        print("No backups found")
        return

    print(f"{'Backup file':<50} {'Date':<12} {'Size':>10}")
    print("-" * 75)
    for fname, date_dir, _fpath, size, _mtime in backups:
        print(f"{fname:<50} {date_dir:<12} {size:>10}")


def monitor(max_age_hours=48):
    """Verifica si el respaldo más reciente es demasiado viejo"""
    if not os.path.isdir(ARCHIVE_ROOT):
        print(f"ERROR: {ARCHIVE_ROOT} no existe")
        return 1

    backups = []
    for date_dir in sorted(os.listdir(ARCHIVE_ROOT)):
        d = os.path.join(ARCHIVE_ROOT, date_dir)
        if not os.path.isdir(d) or not date_dir[:4].isdigit():
            continue

        for fname in sorted(os.listdir(d)):
            if fname.endswith(".sqlite"):
                fpath = os.path.join(d, fname)
                mtime = os.path.getmtime(fpath)
                backups.append((fname, mtime))

    if not backups:
        print("ALERT: No backups found")
        return 2

    latest_fname, latest_mtime = backups[-1]
    age_hours = (dt.datetime.now().timestamp() - latest_mtime) / 3600
    max_age = max_age_hours

    print(f"Latest backup: {latest_fname}")
    print(f"Age: {age_hours:.1f} hours")

    if age_hours > max_age:
        print(f"ALERT: Backup is {age_hours:.1f} hours old (threshold: {max_age}h)")
        return 1
    else:
        print(f"OK: Backup is recent ({age_hours:.1f}h < {max_age}h threshold)")
        return 0


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="command")

    sp_verify = sp.add_parser("verify", help="Verify a backup file")
    sp_verify.add_argument("file", help="Path to .sqlite file")

    sp.add_parser("list", help="List all backups")

    sp_monitor = sp.add_parser("monitor", help="Check if backup is too old")
    sp_monitor.add_argument("--max-age", type=int, default=48, help="Max age in hours (default 48)")

    args = ap.parse_args()

    if args.command == "verify":
        return 0 if verify_backup(args.file) else 1
    elif args.command == "list":
        list_backups()
        return 0
    elif args.command == "monitor":
        return monitor(args.max_age)
    else:
        ap.print_help()
        return 1


if __name__ == "__main__":
    sys.exit(main())
