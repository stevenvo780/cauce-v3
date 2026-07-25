#!/usr/bin/env python3
"""
Respaldo consistente de la SQLite de Ultimate Terminal (ut-nexus).

POR QUE ESTE SCRIPT Y NO `cp`:
  La base corre en modo WAL. El archivo nexus.db por si solo esta ATRASADO: las
  paginas mas recientes viven en nexus.db-wal (verificado 2026-07-25: 27 de 30
  filas de `workers` diferian entre el WAL y el archivo principal). Un `cp` del
  .db solo -> copia vieja; un `cp` de los 3 archivos mientras el servicio
  escribe -> copia potencialmente TORN/corrupta.
  Aca usamos la API oficial de backup online de SQLite (sqlite3_backup, expuesta
  en Python como Connection.backup), que toma un snapshot transaccionalmente
  consistente db+WAL SIN bloquear al servicio y SIN escribir en el origen.

SEGURIDAD:
  - El origen se abre con URI ?mode=ro (solo lectura). No se hace checkpoint,
    ni VACUUM, ni se toca el WAL.
  - Solo escribe dentro de OUT_ROOT/<fecha>/.
  - No requiere parar el container.

USO:
  python3 backup-ut-nexus.py                 # respaldo + verificacion
  python3 backup-ut-nexus.py --out-root DIR  # otro destino
  python3 backup-ut-nexus.py --src FILE      # otra SQLite (p.ej. restaurar y validar)
  python3 backup-ut-nexus.py --keep 30       # borra respaldos con mas de 30 dias

SALIDA (en OUT_ROOT/<UTC-YYYY-MM-DD>/):
  nexus-<UTC-timestamp>.sqlite   copia consistente
  SHA256SUMS                     hash de la copia (verificable con sha256sum -c)
  manifest.json                  conteos, esquema, integrity_check, metadatos
  backup.log                     traza de la corrida

Codigo de salida: 0 = respaldo verificado OK. !=0 = FALLO (no confiar en la copia).
"""

import argparse
import datetime as dt
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time

DEFAULT_SRC = "/var/lib/docker/volumes/ut-nexus-data/_data/nexus.db"
DEFAULT_OUT_ROOT = "/opt/_archive/ultimate-terminal"
CONTAINER = "ut-nexus"
VOLUME = "ut-nexus-data"

_log_lines = []


def log(msg):
    line = f"{dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')} {msg}"
    print(line, flush=True)
    _log_lines.append(line)


def ro_connect(path):
    """Abre SOLO LECTURA. Con mode=ro SQLite lee db+WAL pero no escribe el origen."""
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=60)


def snapshot(con):
    """Lee esquema, conteos e integridad dentro de UNA transaccion (vista estable)."""
    cur = con.cursor()
    cur.execute("BEGIN")
    objs = cur.execute(
        "SELECT type,name,COALESCE(sql,'') FROM sqlite_master "
        "WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
    ).fetchall()
    tables = [n for t, n, _ in objs if t == "table"]
    counts = {n: cur.execute(f'SELECT count(*) FROM "{n}"').fetchone()[0] for n in tables}
    integrity = cur.execute("PRAGMA integrity_check").fetchone()[0]
    fk = cur.execute("PRAGMA foreign_key_check").fetchall()
    con.rollback()
    return {
        "tables": tables,
        "counts": counts,
        "schema": {n: s for _, n, s in objs},
        "integrity_check": integrity,
        "foreign_key_violations": len(fk),
    }


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def docker_meta():
    meta = {}
    for key, cmd in (
        ("image", ["docker", "inspect", CONTAINER, "--format", "{{.Config.Image}}"]),
        ("started_at", ["docker", "inspect", CONTAINER, "--format", "{{.State.StartedAt}}"]),
        ("volume_mountpoint", ["docker", "volume", "inspect", VOLUME, "--format", "{{.Mountpoint}}"]),
    ):
        try:
            meta[key] = subprocess.run(cmd, capture_output=True, text=True, timeout=20).stdout.strip()
        except Exception as e:
            meta[key] = f"unavailable: {e}"
    return meta


def prune(out_root, keep_days):
    cutoff = time.time() - keep_days * 86400
    for name in sorted(os.listdir(out_root)):
        d = os.path.join(out_root, name)
        if not os.path.isdir(d) or not name[:4].isdigit():
            continue
        if os.path.getmtime(d) < cutoff:
            log(f"PRUNE  borrando respaldo antiguo {d}")
            shutil.rmtree(d)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=DEFAULT_SRC)
    ap.add_argument("--out-root", default=DEFAULT_OUT_ROOT)
    ap.add_argument("--keep", type=int, default=0, help="dias de retencion (0 = no borrar nada)")
    args = ap.parse_args()

    if not os.path.exists(args.src):
        log(f"FATAL  no existe el origen {args.src}")
        return 2

    now = dt.datetime.now(dt.timezone.utc)
    out_dir = os.path.join(args.out_root, now.strftime("%Y-%m-%d"))
    os.makedirs(out_dir, exist_ok=True)
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    dest = os.path.join(out_dir, f"nexus-{stamp}.sqlite")

    sizes = {
        os.path.basename(p): (os.path.getsize(p) if os.path.exists(p) else 0)
        for p in (args.src, args.src + "-wal", args.src + "-shm")
    }
    log(f"ORIGEN {args.src} tamanos={sizes}")
    if sizes.get("nexus.db-wal", 0) > 0:
        log("NOTA   hay WAL con datos: un `cp` del .db solo daria una copia ATRASADA")

    # --- lectura del origen (solo lectura) ---
    src_con = ro_connect(args.src)
    src_info = snapshot(src_con)
    log(f"ORIGEN tablas={src_info['tables']}")
    log(f"ORIGEN conteos={src_info['counts']} integrity={src_info['integrity_check']}")
    if src_info["integrity_check"] != "ok":
        src_con.close()
        log("FATAL  el ORIGEN esta corrupto; abortando")
        return 3

    # --- backup online consistente ---
    t0 = time.time()
    dst_con = sqlite3.connect(dest)
    src_con.backup(dst_con)  # sqlite3_backup: snapshot consistente db+WAL
    dst_con.close()
    src_con.close()
    log(f"COPIA  {dest} ({os.path.getsize(dest)} bytes) en {time.time()-t0:.2f}s")

    # --- verificacion de la copia ---
    v_con = ro_connect(dest)
    dst_info = snapshot(v_con)
    v_con.close()

    # Abrir la copia crea -wal/-shm vacios al lado. Todo el dato ya esta en el
    # archivo principal (la conexion se cerro limpia): los quitamos para que el
    # directorio de archivo quede con un unico archivo autocontenido.
    for suffix in ("-wal", "-shm"):
        aux = dest + suffix
        if not os.path.exists(aux):
            continue
        # Nunca borrar un -wal con frames: eso SI perderia datos.
        if suffix == "-wal" and os.path.getsize(aux) > 0:
            log(f"AVISO  {os.path.basename(aux)} no esta vacio; se conserva")
            continue
        os.remove(aux)
        log(f"LIMPIO {os.path.basename(aux)} (auxiliar vacio de la verificacion)")

    problems = []
    if dst_info["integrity_check"] != "ok":
        problems.append(f"integrity_check de la copia = {dst_info['integrity_check']}")
    if dst_info["tables"] != src_info["tables"]:
        problems.append(f"tablas distintas: origen={src_info['tables']} copia={dst_info['tables']}")
    if dst_info["counts"] != src_info["counts"]:
        problems.append(f"conteos distintos: origen={src_info['counts']} copia={dst_info['counts']}")
    if dst_info["schema"] != src_info["schema"]:
        problems.append("el DDL del esquema no coincide")
    if dst_info["foreign_key_violations"]:
        problems.append(f"{dst_info['foreign_key_violations']} violaciones de FK en la copia")

    digest = sha256(dest)
    with open(os.path.join(out_dir, "SHA256SUMS"), "a") as fh:
        fh.write(f"{digest}  {os.path.basename(dest)}\n")
    log(f"SHA256 {digest}")

    manifest = {
        "created_utc": now.isoformat(),
        "source": args.src,
        "source_file_sizes": sizes,
        "backup_file": os.path.basename(dest),
        "backup_bytes": os.path.getsize(dest),
        "sha256": digest,
        "method": "sqlite3 online backup API (Connection.backup), origen abierto mode=ro",
        "tables": dst_info["tables"],
        "counts": dst_info["counts"],
        "integrity_check": dst_info["integrity_check"],
        "foreign_key_violations": dst_info["foreign_key_violations"],
        "verified": not problems,
        "problems": problems,
        "docker": docker_meta(),
        "python_sqlite_version": sqlite3.sqlite_version,
        "host": os.uname().nodename,
    }
    with open(os.path.join(out_dir, f"manifest-{stamp}.json"), "w") as fh:
        json.dump(manifest, fh, indent=2, ensure_ascii=False)

    if problems:
        for p in problems:
            log(f"FALLO  {p}")
        rc = 4
    else:
        log(f"OK     copia verificada: mismas {len(dst_info['tables'])} tablas, "
            f"mismos conteos ({sum(dst_info['counts'].values())} filas), integrity=ok")
        rc = 0

    with open(os.path.join(out_dir, "backup.log"), "a") as fh:
        fh.write("\n".join(_log_lines) + "\n")

    if args.keep > 0:
        prune(args.out_root, args.keep)
    return rc


if __name__ == "__main__":
    sys.exit(main())
