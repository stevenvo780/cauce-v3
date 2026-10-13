#!/usr/bin/env python3
"""Inspect fleet credentials without modifying or exposing tokens.

Without arguments, aggregate local and remote observations. With --sonda-remota,
probe this host and push fingerprints to the aggregator. CAUCE_CRED_GUARD_ESTADO
persists stdout, stderr and a UTC summary with the actual exit code.
"""
import argparse
import contextlib
import datetime
import io
import json
import os
import re
import subprocess
import sys
import tempfile

from credential_health import (
    LONG_LIVED,
    classify_fleet_guard_record,
    probe_container,
    shared_fingerprints,
)


def _filas_objetivo(clave: str) -> list[tuple[str, str, str]]:
    ruta = os.environ.get("CAUCE_CRED_GUARD_TARGETS")
    if not ruta:
        raise SystemExit("falta CAUCE_CRED_GUARD_TARGETS")
    try:
        with open(ruta, encoding="utf-8") as handle:
            document = json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit("CAUCE_CRED_GUARD_TARGETS ilegible") from error
    if not isinstance(document, dict):
        raise SystemExit("CAUCE_CRED_GUARD_TARGETS no es un objeto")
    rows = document.get(clave)
    if not isinstance(rows, list) or not rows:
        raise SystemExit(f"CAUCE_CRED_GUARD_TARGETS sin {clave}")
    parsed: list[tuple[str, str, str]] = []
    for row in rows:
        if not isinstance(row, list) or len(row) != 3 or not all(isinstance(item, str) and item for item in row):
            raise SystemExit("CAUCE_CRED_GUARD_TARGETS fila invalida")
        parsed.append((row[0], row[1], row[2]))
    return parsed

DESTINO_REMOTO = "vps:/var/lib/cauce-v3/cred-guard-kratos.json"
LOCAL = os.path.expanduser("~/.local/state/cauce-v3/cred-guard-kratos.json")
HOST = os.environ.get("CAUCE_CRED_GUARD_HOST", "kratos")


def _sonda_remota() -> tuple[int, int, int]:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", HOST):
        raise SystemExit("CAUCE_CRED_GUARD_HOST is invalid")
    ahora_r = datetime.datetime.now(datetime.UTC)
    filas_r, problemas_r = [], 0
    for contenedor, ruta, etiqueta in _filas_objetivo("remote_targets"):
        d = probe_container(contenedor, ruta)
        if d.get("falta"):
            filas_r.append({"huella": "-", "etiqueta": etiqueta, "contenedor": contenedor,
                            "estado": "NO EXISTE", "detalle": "", "problema": False})
            continue
        if d.get("error"):
            filas_r.append({"huella": "?", "etiqueta": etiqueta, "contenedor": contenedor,
                            "estado": "ILEGIBLE", "detalle": d["error"], "problema": True})
            problemas_r += 1
            continue
        health = classify_fleet_guard_record(d, now_epoch=ahora_r.timestamp())
        huella = health.fingerprint
        horas = health.hours_until_expiry
        estado, problema = health.operational_state, health.problem
        if health.state == LONG_LIVED:
            detalle = f"token largo sin refreshToken (setup-token): vence en {(horas / 24):.0f} dias"
        elif health.problem:
            detalle = "sin refreshToken: no puede renovar, muere al vencer el access"
            problemas_r += 1
        else:
            detalle = (f"vence en {horas:.1f} h") if horas is not None else (d.get("last_refresh") or "")
        filas_r.append({"huella": huella or "SIN-RT", "etiqueta": etiqueta, "contenedor": contenedor,
                        "estado": estado, "detalle": detalle, "problema": problema})
    doc = {"host": HOST, "ts": ahora_r.isoformat(), "filas": filas_r, "problemas": problemas_r}
    os.makedirs(os.path.dirname(LOCAL), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(LOCAL))
    with os.fdopen(fd, "w") as fh:
        json.dump(doc, fh)
    os.replace(tmp, LOCAL)
    os.chmod(LOCAL, 0o644)
    for f in filas_r:
        print(f"{f['huella']:<9} {f['etiqueta']:<24} {f['contenedor']:<14} {f['estado']:<8} {f['detalle']}")
    shared = shared_fingerprints(
        (row["huella"], row["etiqueta"], row["contenedor"])
        for row in filas_r if row["huella"] not in ("-", "?", "SIN-RT")
    )
    try:
        with open(LOCAL, "rb") as payload:
            r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "vps",
                                "mkdir -p /var/lib/cauce-v3 && cat > /var/lib/cauce-v3/cred-guard-kratos.json.tmp "
                                "&& mv /var/lib/cauce-v3/cred-guard-kratos.json.tmp /var/lib/cauce-v3/cred-guard-kratos.json"],
                               stdin=payload, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired as error:
        diagnostic = error.stderr or ""
        if isinstance(diagnostic, bytes):
            diagnostic = diagnostic.decode("utf-8", errors="replace")
        print(f"EMPUJE AL VPS FALLO: timeout; {diagnostic.strip()[:120]}", file=sys.stderr)
        return 1, problemas_r, len(shared)
    except OSError as error:
        print(f"EMPUJE AL VPS FALLO: {type(error).__name__}", file=sys.stderr)
        return 1, problemas_r, len(shared)
    if r.returncode != 0:
        print(f"EMPUJE AL VPS FALLO: {(r.stderr or '').strip()[:120]}", file=sys.stderr)
        return 1, problemas_r, len(shared)
    print(f"empujado a {DESTINO_REMOTO}")
    return 0, problemas_r, len(shared)


def _aggregate() -> tuple[int, int, int]:
    ahora = datetime.datetime.now(datetime.UTC)
    filas, credential_locations, problemas = [], [], 0

    for contenedor, ruta, etiqueta in _filas_objetivo("targets"):
        d = probe_container(contenedor, ruta)
        if d.get("falta"):
            filas.append(("-", etiqueta, contenedor, "NO EXISTE", ""))
            continue
        if d.get("error"):
            filas.append(("?", etiqueta, contenedor, "ILEGIBLE", d["error"]))
            problemas += 1
            continue

        health = classify_fleet_guard_record(d, now_epoch=ahora.timestamp())
        huella = health.fingerprint
        horas = health.hours_until_expiry
        estado = health.operational_state

        # An EXPIRED access token is NOT a problem: as long as there's a refreshToken, the CLI renews
        # it on its own. salva has been "expired" for 5 days and answers deliveries without failing
        # once. Alarming over that would be a guard that screams every day, and nobody listens to a
        # guard that screams. The only thing that really kills an agent is running OUT of refreshToken.
        # Not everything without a refreshToken is dead. The `claude setup-token` emits a LONG token
        # (1 year) that intentionally doesn't include refreshToken: there's nothing to renew. Marking
        # it DEAD is an expensive false positive, because it pushes a human to redo a login that
        # wasn't needed. What really kills is having no refreshToken AND an expired or about-to-expire access.
        if health.state == LONG_LIVED:
            detalle = f"token largo sin refreshToken (setup-token): vence en {(horas / 24):.0f} dias"
        elif health.problem:
            problemas += 1
            detalle = "sin refreshToken y access %s: no puede renovar" % (
                f"VENCIDO hace {-horas:.0f} h" if horas is not None and horas < 0
                else (f"vence en {horas:.1f} h" if horas is not None else "sin fecha"))
        else:
            detalle = (f"vence en {horas:.1f} h") if horas is not None else (d.get("last_refresh") or "")
        if huella:
            credential_locations.append((huella, etiqueta, contenedor))
        filas.append((huella or "SIN-RT", etiqueta, contenedor, estado, detalle))

    # ---- aliases that do NOT live in this host -------------------------------------------------
    # salva runs on kratos. The VPS has no SSH to kratos, but kratos DOES have SSH to the VPS, so
    # kratos measures and pushes its result here. If the push stops, the row shows STALE and counts
    # as a problem: an alias that stops being measured can't quietly slip back into "everything's fine".
    REMOTO = "/var/lib/cauce-v3/cred-guard-kratos.json"
    MAX_EDAD_MIN = 60
    try:
        with open(REMOTO, encoding="utf-8") as fh:
            doc = json.load(fh)
        remote_host = doc.get("host", "kratos")
        edad = (ahora - datetime.datetime.fromisoformat(doc["ts"])).total_seconds() / 60
        for f in doc.get("filas", []):
            estado, detalle = f.get("estado", "?"), f.get("detalle", "")
            if edad > MAX_EDAD_MIN:
                estado = "STALE"
                detalle = f"medicion de {doc.get('host', '?')} con {edad:.0f} min de atraso: dejo de empujar"
                problemas += 1
            elif f.get("problema") or estado == "ILEGIBLE":
                problemas += 1
            h = f.get("huella")
            if h and h not in ("-", "?", "SIN-RT"):
                credential_locations.append((h, f["etiqueta"], f["contenedor"] + "@" + remote_host))
            filas.append((h or "SIN-RT", f["etiqueta"], f["contenedor"] + "@" + remote_host, estado, detalle))
    except FileNotFoundError:
        problemas += 1
        filas.append(("?", "claude/salva", "ws-isa@remoto", "SIN DATOS",
                      f"el host remoto no publico {REMOTO}: salva esta SIN VIGILANCIA"))
    except Exception as e:
        problemas += 1
        filas.append(("?", "claude/salva", "ws-isa@remoto", "ILEGIBLE",
                      f"{type(e).__name__}: {str(e)[:60]}"))

    print(f"== credenciales de la flota == {ahora.strftime('%Y-%m-%d %H:%M')} UTC")
    for huella, etiqueta, contenedor, estado, detalle in filas:
        print(f"{huella:<9} {etiqueta:<24} {contenedor:<14} {estado:<8} {detalle}")

    compartidas = shared_fingerprints(credential_locations)
    if compartidas:
        print("\n== NOTA: cuentas compartidas (valido; si comparten el mismo refresh token, rotar uno puede invalidar al otro) ==")
        for huella, quienes in compartidas.items():
            print(f"  {huella} -> {', '.join(quienes)}")

    print(f"\nproblemas={problemas} compartidas={len(compartidas)}")
    return (1 if problemas else 0), problemas, len(compartidas)


def _write_state(directory: str, output: str, errors: str, *, exit_code: int, problems: int, shared: int) -> None:
    os.makedirs(directory, exist_ok=True)
    temporary = os.path.join(directory, "cred-guard.txt.tmp")
    with open(temporary, "w", encoding="utf-8") as report:
        report.write(output + errors)
    os.replace(temporary, os.path.join(directory, "cred-guard.txt"))
    timestamp = datetime.datetime.now(datetime.UTC).isoformat()
    with open(os.path.join(directory, "cred-guard.log"), "a", encoding="utf-8") as log:
        log.write(f"{timestamp} rc={exit_code} problemas={problems} compartidas={shared}\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--sonda-remota", action="store_true", help="probe this host and push observations")
    directory = os.environ.get("CAUCE_CRED_GUARD_ESTADO")
    output, errors = io.StringIO(), io.StringIO()
    stdout, stderr = sys.stdout, sys.stderr
    exit_code, problems, shared = 1, 0, 0
    try:
        with contextlib.ExitStack() as capture:
            if directory:
                capture.enter_context(contextlib.redirect_stdout(output))
                capture.enter_context(contextlib.redirect_stderr(errors))
            try:
                arguments = parser.parse_args()
                exit_code, problems, shared = _sonda_remota() if arguments.sonda_remota else _aggregate()
            except SystemExit as error:
                exit_code = error.code if isinstance(error.code, int) else 1
                if error.code and not isinstance(error.code, int):
                    print(error.code, file=sys.stderr)
            except Exception as error:
                print(f"cred-guard failed: {type(error).__name__}", file=sys.stderr)
    finally:
        if directory:
            stdout.write(output.getvalue())
            stderr.write(errors.getvalue())
            _write_state(directory, output.getvalue(), errors.getvalue(),
                         exit_code=exit_code, problems=problems, shared=shared)
    return exit_code


sys.exit(main())
