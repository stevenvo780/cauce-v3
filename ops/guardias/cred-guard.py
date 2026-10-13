#!/usr/bin/env python3
"""Vigila las credenciales de la flota SIN tocarlas ni imprimirlas.

Por que existe: el trabajo manual de rotar no lo causa que los tokens venzan, lo causa COMPARTIR
un mismo archivo entre varios contenedores. El refresh token de OAuth es de un solo uso y rota:
el primero que refresca se lleva el nuevo y deja a los demas con uno gastado. El sintoma no es un
error, es un agente que enmudece. El 2026-08-03 janus y claw-iza llevaban dias con
refreshToken vacio y nadie lo vio.

Que detecta, en orden de gravedad:
  MUERTO     refreshToken ausente o vacio  -> no puede renovar, muere cuando venza el access
  URGENTE    vence en menos de 2 horas
  COMPARTIDA dos o mas contenedores con la MISMA huella -> nota informativa, no es un fallo
  OK

La huella es sha256(refreshToken)[:10]: identifica la cuenta sin exponer el secreto.
Salida: una linea por credencial + codigo de salida 1 si hay algo MUERTO o URGENTE.

Modos: sin argumentos agrega este host y el bloque remoto; con --sonda-remota mide los alias
de ESTE host y empuja solo huellas al agregador. Con CAUCE_CRED_GUARD_ESTADO=<dir> deja ademas
cred-guard.txt y una linea de resumen en cred-guard.log.
"""
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

# (container, path inside the container, label)
OBJETIVOS = [
    # Claude (all fleet containers that live in THIS host, the VPS).
    # ws-isa/salva lives on kratos and this host has no SSH to it: kratos measures it and
    # PUSHES it (see REMOTE block below). Don't remove its row: removing it was exactly
    # what left salva without monitoring and without anyone saying so.
    ("claw",                   "/home/claw/.claude/.credentials.json", "claude/jarvis"),
    ("claw-miguel",            "/home/claw/.claude/.credentials.json", "claude/janus"),
    ("claw-iza",               "/home/claw/.claude/.credentials.json", "claude/iza"),
    ("ws-zeus",                "/home/dev/.claude/.credentials.json",  "claude/zeus"),
    # claude/socrates RETIRED from the inventory (28-08-2026): socrates runs codex (DB, reconciliation
    # b93f087d) and its Claude credential on ws-prizma has been DEAD without refreshToken since before
    # 21-08; 334 runs in solid red blinded the SHARED alert. If socrates returns to claude,
    # re-add the row. The credential itself was NOT touched (owner's rule).
    ("ws-humanizar",           "/home/dev/.claude/.credentials.json",  "claude/kratos+atlas"),
    ("ctrl-infra",             "/home/dev/.claude/.credentials.json",  "claude/argos+kant"),
    # Codex
    ("claw",         "/home/claw/.codex/auth.json", "codex/jarvis"),
    ("ws-prizma",    "/home/dev/.codex/auth.json",  "codex/socrates"),
    ("ws-humanizar", "/home/dev/.codex/auth.json",  "codex/atlas"),
    ("ctrl-infra",   "/home/dev/.codex/auth.json",  "codex/kant"),
]

OBJETIVOS_REMOTOS = [
    ("ws-isa", "/home/dev/.claude/.credentials.json", "claude/salva"),
    ("ws-isa", "/home/dev/.codex/auth.json",          "codex/salva"),
]

DESTINO_REMOTO = "vps:/var/lib/cauce-v3/cred-guard-kratos.json"
LOCAL = os.path.expanduser("~/.local/state/cauce-v3/cred-guard-kratos.json")
HOST = os.environ.get("CAUCE_CRED_GUARD_HOST", "kratos")


def _sonda_remota() -> None:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", HOST):
        raise SystemExit("CAUCE_CRED_GUARD_HOST is invalid")
    ahora_r = datetime.datetime.now(datetime.UTC)
    filas_r, problemas_r = [], 0
    for contenedor, ruta, etiqueta in OBJETIVOS_REMOTOS:
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
    r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "vps",
                        "mkdir -p /var/lib/cauce-v3 && cat > /var/lib/cauce-v3/cred-guard-kratos.json.tmp "
                        "&& mv /var/lib/cauce-v3/cred-guard-kratos.json.tmp /var/lib/cauce-v3/cred-guard-kratos.json"],
                       stdin=open(LOCAL, "rb"), capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        print(f"EMPUJE AL VPS FALLO: {(r.stderr or '').strip()[:120]}", file=sys.stderr)
        sys.exit(1)
    print(f"empujado a {DESTINO_REMOTO}")
    sys.exit(0)


if "--sonda-remota" in sys.argv:
    _sonda_remota()

ahora = datetime.datetime.now(datetime.UTC)
_CAPTURA = io.StringIO() if os.environ.get("CAUCE_CRED_GUARD_ESTADO") else None
if _CAPTURA is not None:
    sys.stdout = _CAPTURA
filas, credential_locations, problemas = [], [], 0

for contenedor, ruta, etiqueta in OBJETIVOS:
    d = probe_container(contenedor, ruta)
    if d.get("falta"):
        filas.append(("-", etiqueta, contenedor, "NO EXISTE", ""))
        continue
    if d.get("error"):
        filas.append(("?", etiqueta, contenedor, "ILEGIBLE", d["error"]))
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
        elif f.get("problema"):
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
if _CAPTURA is not None:
    sys.stdout = sys.__stdout__
    _texto = _CAPTURA.getvalue()
    print(_texto, end="")
    _dir = os.environ["CAUCE_CRED_GUARD_ESTADO"]
    os.makedirs(_dir, exist_ok=True)
    _tmp = os.path.join(_dir, "cred-guard.txt.tmp")
    with open(_tmp, "w", encoding="utf-8") as fh:
        fh.write(_texto)
    os.replace(_tmp, os.path.join(_dir, "cred-guard.txt"))
    with open(os.path.join(_dir, "cred-guard.log"), "a", encoding="utf-8") as fh:
        fh.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} problemas={problemas}\n")
sys.exit(1 if problemas else 0)
