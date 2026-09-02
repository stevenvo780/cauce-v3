#!/usr/bin/env python3
"""Mide las credenciales de los alias que viven en KRATOS y empuja el resultado al VPS.

Por que existe: cauce-cred-guard.py corre en el VPS y solo ve los contenedores del VPS. salva vive
en kratos, asi que su fila se habia BORRADO del guard ("no se mide desde aca") y el resultado fue
que nadie vigilaba a salva. Un alias sin vigilancia no da error: enmudece y nadie se entera.

Direccion del empuje: kratos -> VPS, porque el VPS NO tiene acceso SSH a kratos y kratos si al VPS.
No imprime ni copia secretos: solo longitudes, vencimientos y sha256(refreshToken)[:10].
"""
import datetime
import json
import os
import subprocess
import sys
import tempfile

from credential_health import LONG_LIVED, classify_fleet_guard_record, probe_container

OBJETIVOS = [
    ("ws-isa", "/home/dev/.claude/.credentials.json", "claude/salva"),
    ("ws-isa", "/home/dev/.codex/auth.json",          "codex/salva"),
]

DESTINO_REMOTO = "vps:/var/lib/cauce-v3/cred-guard-kratos.json"
LOCAL = os.path.expanduser("~/.local/state/cauce-v3/cred-guard-kratos.json")

ahora = datetime.datetime.now(datetime.timezone.utc)
filas, problemas = [], 0

for contenedor, ruta, etiqueta in OBJETIVOS:
    d = probe_container(contenedor, ruta)
    if d.get("falta"):
        filas.append({"huella": "-", "etiqueta": etiqueta, "contenedor": contenedor,
                      "estado": "NO EXISTE", "detalle": "", "problema": False})
        continue
    if d.get("error"):
        filas.append({"huella": "?", "etiqueta": etiqueta, "contenedor": contenedor,
                      "estado": "ILEGIBLE", "detalle": d["error"], "problema": True})
        problemas += 1
        continue
    health = classify_fleet_guard_record(d, now_epoch=ahora.timestamp())
    huella = health.fingerprint
    horas = health.hours_until_expiry
    estado, problema = health.operational_state, health.problem
    # Same criterion as the VPS guard: the only thing that KILLS is running out of refreshToken.
    if health.state == LONG_LIVED:
        detalle = f"token largo sin refreshToken (setup-token): vence en {(horas / 24):.0f} dias"
    elif health.problem:
        detalle = "sin refreshToken: no puede renovar, muere al vencer el access"
        problemas += 1
    else:
        detalle = (f"vence en {horas:.1f} h") if horas is not None else (d.get("last_refresh") or "")
    filas.append({"huella": huella or "SIN-RT", "etiqueta": etiqueta, "contenedor": contenedor,
                  "estado": estado, "detalle": detalle, "problema": problema})

doc = {"host": "kratos", "ts": ahora.isoformat(), "filas": filas, "problemas": problemas}

os.makedirs(os.path.dirname(LOCAL), exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(LOCAL))
with os.fdopen(fd, "w") as fh:
    json.dump(doc, fh)
os.replace(tmp, LOCAL)
os.chmod(LOCAL, 0o644)

for f in filas:
    print(f"{f['huella']:<9} {f['etiqueta']:<24} {f['contenedor']:<14} {f['estado']:<8} {f['detalle']}")

# The push is part of the job: if it does not reach the VPS, the guard over there will mark it STALE (on purpose).
r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "vps",
                    "mkdir -p /var/lib/cauce-v3 && cat > /var/lib/cauce-v3/cred-guard-kratos.json.tmp "
                    "&& mv /var/lib/cauce-v3/cred-guard-kratos.json.tmp /var/lib/cauce-v3/cred-guard-kratos.json"],
                   stdin=open(LOCAL, "rb"), capture_output=True, text=True, timeout=60)
if r.returncode != 0:
    print(f"EMPUJE AL VPS FALLO: {(r.stderr or '').strip()[:120]}", file=sys.stderr)
    sys.exit(1)
print(f"empujado a {DESTINO_REMOTO}")
# Failing here means exactly one thing: it could not be measured or pushed.
# The VPS guard, which sees the whole fleet, raises the alarm on credential "problems".
sys.exit(0)
