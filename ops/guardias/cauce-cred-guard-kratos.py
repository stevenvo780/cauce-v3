#!/usr/bin/env python3
"""Mide las credenciales de los alias que viven en KRATOS y empuja el resultado al VPS.

Por que existe: cauce-cred-guard.py corre en el VPS y solo ve los contenedores del VPS. salva vive
en kratos, asi que su fila se habia BORRADO del guard ("no se mide desde aca") y el resultado fue
que nadie vigilaba a salva. Un alias sin vigilancia no da error: enmudece y nadie se entera.

Direccion del empuje: kratos -> VPS, porque el VPS NO tiene acceso SSH a kratos y kratos si al VPS.
No imprime ni copia secretos: solo longitudes, vencimientos y sha256(refreshToken)[:10].
"""
import json, subprocess, hashlib, datetime, os, sys, tempfile

OBJETIVOS = [
    ("ws-isa", "/home/dev/.claude/.credentials.json", "claude/salva"),
    ("ws-isa", "/home/dev/.codex/auth.json",          "codex/salva"),
]

DESTINO_REMOTO = "vps:/var/lib/cauce-v3/cred-guard-kratos.json"
LOCAL = os.path.expanduser("~/.local/state/cauce-v3/cred-guard-kratos.json")

LECTOR = r'''
import json,io,os,sys,hashlib
p=sys.argv[1]
if not os.path.exists(p):
    print(json.dumps({"falta":True})); raise SystemExit
d=json.load(io.open(p,encoding="utf-8"))
o=d.get("claudeAiOauth") or d.get("tokens") or d
rt=o.get("refreshToken") or o.get("refresh_token") or ""
at=o.get("accessToken") or o.get("access_token") or ""
print(json.dumps({
  "huella": hashlib.sha256(rt.encode()).hexdigest()[:10] if rt else None,
  "expiresAt": o.get("expiresAt"), "last_refresh": d.get("last_refresh"),
  "at_len": len(at)}))
'''


def leer(contenedor, ruta):
    try:
        s = subprocess.run(["docker", "exec", contenedor, "python3", "-c", LECTOR, ruta],
                           capture_output=True, text=True, timeout=25)
        if s.returncode != 0:
            return {"error": (s.stderr or "").strip()[:60] or "rc=%d" % s.returncode}
        return json.loads(s.stdout.strip().splitlines()[-1])
    except Exception as e:
        return {"error": "%s: %s" % (type(e).__name__, str(e)[:50])}


ahora = datetime.datetime.now(datetime.timezone.utc)
filas, problemas = [], 0

for contenedor, ruta, etiqueta in OBJETIVOS:
    d = leer(contenedor, ruta)
    if d.get("falta"):
        filas.append({"huella": "-", "etiqueta": etiqueta, "contenedor": contenedor,
                      "estado": "NO EXISTE", "detalle": "", "problema": False})
        continue
    if d.get("error"):
        filas.append({"huella": "?", "etiqueta": etiqueta, "contenedor": contenedor,
                      "estado": "ILEGIBLE", "detalle": d["error"], "problema": True})
        problemas += 1
        continue
    huella, horas, exp = d.get("huella"), None, d.get("expiresAt")
    if isinstance(exp, (int, float)):
        ts = exp / 1000 if exp > 1e11 else exp
        horas = (datetime.datetime.fromtimestamp(ts, datetime.timezone.utc) - ahora).total_seconds() / 3600
    # Mismo criterio que el guard del VPS: lo unico que MATA es quedarse sin refreshToken.
    if huella is None:
        estado, detalle, problema = "MUERTO", "sin refreshToken: no puede renovar, muere al vencer el access", True
        problemas += 1
    else:
        estado, problema = "OK", False
        detalle = ("vence en %.1f h" % horas) if horas is not None else (d.get("last_refresh") or "")
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
    print("%-9s %-24s %-14s %-8s %s" % (f["huella"], f["etiqueta"], f["contenedor"], f["estado"], f["detalle"]))

# El empuje es parte del trabajo: si no llega al VPS, el guard de alla lo dara por STALE (a proposito).
r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "vps",
                    "mkdir -p /var/lib/cauce-v3 && cat > /var/lib/cauce-v3/cred-guard-kratos.json.tmp "
                    "&& mv /var/lib/cauce-v3/cred-guard-kratos.json.tmp /var/lib/cauce-v3/cred-guard-kratos.json"],
                   stdin=open(LOCAL, "rb"), capture_output=True, text=True, timeout=60)
if r.returncode != 0:
    print("EMPUJE AL VPS FALLO: %s" % (r.stderr or "").strip()[:120], file=sys.stderr)
    sys.exit(1)
print("empujado a %s" % DESTINO_REMOTO)
# Fallar aca significa exactamente una cosa: no se pudo medir o no se pudo empujar.
# De los "problemas" de credencial alarma el guard del VPS, que ve la flota entera.
sys.exit(0)
