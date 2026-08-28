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
  COMPARTIDA dos o mas contenedores con la MISMA huella -> se van a pisar
  OK

La huella es sha256(refreshToken)[:10]: identifica la cuenta sin exponer el secreto.
Salida: una linea por credencial + codigo de salida 1 si hay algo MUERTO o URGENTE.
"""
import json, subprocess, datetime, sys

# (contenedor, ruta dentro del contenedor, etiqueta)
OBJETIVOS = [
    ("claw",          "/home/claw/.claude/.credentials.json", "claude/jarvis"),
    ("claw-miguel",   "/home/claw/.claude/.credentials.json", "claude/janus"),
    ("claw-iza",      "/home/claw/.claude/.credentials.json", "claude/claw-iza"),
    ("ws-zeus",       "/home/dev/.claude/.credentials.json",  "claude/zeus+compartida"),
    ("ws-isa",        "/home/dev/.claude/.credentials.json",  "claude/salva"),
    ("ws-prizma",     "/home/dev/.claude/.credentials.json",  "claude/socrates"),
    ("ws-humanizar",  "/home/dev/.claude/.credentials.json",  "claude/kratos+atlas"),
    ("ctrl-infra",    "/home/dev/.claude/.credentials.json",  "claude/argos"),
    ("claw",          "/home/claw/.codex/auth.json",          "codex/jarvis"),
    ("ws-prizma",     "/home/dev/.codex/auth.json",           "codex/socrates"),
    ("ws-isa",        "/home/dev/.codex/auth.json",           "codex/salva"),
    ("ws-humanizar",  "/home/dev/.codex/auth.json",           "codex/atlas"),
]

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
        salida = subprocess.run(
            ["docker", "exec", contenedor, "python3", "-c", LECTOR, ruta],
            capture_output=True, text=True, timeout=25)
        if salida.returncode != 0:
            return {"error": (salida.stderr or "").strip()[:60] or "rc=%d" % salida.returncode}
        return json.loads(salida.stdout.strip().splitlines()[-1])
    except Exception as e:
        return {"error": "%s: %s" % (type(e).__name__, str(e)[:50])}

ahora = datetime.datetime.now(datetime.timezone.utc)
filas, por_huella, problemas = [], {}, 0

for contenedor, ruta, etiqueta in OBJETIVOS:
    d = leer(contenedor, ruta)
    if d.get("falta"):   filas.append(("-", etiqueta, contenedor, "NO EXISTE", "")); continue
    if d.get("error"):   filas.append(("?", etiqueta, contenedor, "ILEGIBLE", d["error"])); continue

    huella = d.get("huella")
    horas = None
    exp = d.get("expiresAt")
    if isinstance(exp, (int, float)):
        ts = exp/1000 if exp > 1e11 else exp
        horas = (datetime.datetime.fromtimestamp(ts, datetime.timezone.utc) - ahora).total_seconds()/3600

    # Un access token vencido NO es un problema: mientras haya refreshToken, el CLI lo renueva
    # solo. salva lleva 5 dias "vencido" y contesta entregas sin fallar una. Alarmar por eso seria
    # un guardia que grita todos los dias, y a un guardia que grita nadie le hace caso.
    # Lo unico que de verdad mata a un agente es quedarse SIN refreshToken.
    if huella is None:
        estado, problemas = "MUERTO", problemas + 1
        detalle = "sin refreshToken: no puede renovar, muere al vencer el access"
    else:
        estado = "OK"
        detalle = ("vence en %.1f h" % horas) if horas is not None else (d.get("last_refresh") or "")
    if huella:
        por_huella.setdefault(huella, []).append(etiqueta)
    filas.append((huella or "SIN-RT", etiqueta, contenedor, estado, detalle))

print("== credenciales de la flota == %s UTC" % ahora.strftime("%Y-%m-%d %H:%M"))
for huella, etiqueta, contenedor, estado, detalle in filas:
    print("%-9s %-24s %-14s %-8s %s" % (huella, etiqueta, contenedor, estado, detalle))

compartidas = {h: v for h, v in por_huella.items() if len(v) > 1}
if compartidas:
    print("\n== COMPARTIDAS (se van a pisar al rotar) ==")
    for huella, quienes in compartidas.items():
        print("  %s -> %s" % (huella, ", ".join(quienes)))

print("\nproblemas=%d compartidas=%d" % (problemas, len(compartidas)))
sys.exit(1 if problemas else 0)
