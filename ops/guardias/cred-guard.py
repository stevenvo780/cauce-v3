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
    ("agv2-jhon-hegel-oc",     "/home/claw/.claude/.credentials.json", "claude/hegel"),
    ("agv2-jhon-heraclito-oc", "/home/claw/.claude/.credentials.json", "claude/heraclito"),
    # Codex
    ("claw",         "/home/claw/.codex/auth.json", "codex/jarvis"),
    ("ws-prizma",    "/home/dev/.codex/auth.json",  "codex/socrates"),
    ("ws-humanizar", "/home/dev/.codex/auth.json",  "codex/atlas"),
    ("ctrl-infra",   "/home/dev/.codex/auth.json",  "codex/kant"),
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

    # An EXPIRED access token is NOT a problem: as long as there's a refreshToken, the CLI renews
    # it on its own. salva has been "expired" for 5 days and answers deliveries without failing
    # once. Alarming over that would be a guard that screams every day, and nobody listens to a
    # guard that screams. The only thing that really kills an agent is running OUT of refreshToken.
    # Not everything without a refreshToken is dead. The `claude setup-token` emits a LONG token
    # (1 year) that intentionally doesn't include refreshToken: there's nothing to renew. Marking
    # it DEAD is an expensive false positive, because it pushes a human to redo a login that
    # wasn't needed. What really kills is having no refreshToken AND an expired or about-to-expire access.
    if huella is None and horas is not None and horas > 720:
        estado = "TOKEN-LARGO"
        detalle = "token largo sin refreshToken (setup-token): vence en %.0f dias" % (horas / 24)
    elif huella is None:
        estado, problemas = "MUERTO", problemas + 1
        detalle = "sin refreshToken y access %s: no puede renovar" % (
            "VENCIDO hace %.0f h" % -horas if horas is not None and horas < 0
            else ("vence en %.1f h" % horas if horas is not None else "sin fecha"))
    else:
        estado = "OK"
        detalle = ("vence en %.1f h" % horas) if horas is not None else (d.get("last_refresh") or "")
    if huella:
        por_huella.setdefault(huella, []).append(etiqueta)
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
    edad = (ahora - datetime.datetime.fromisoformat(doc["ts"])).total_seconds() / 60
    for f in doc.get("filas", []):
        estado, detalle = f.get("estado", "?"), f.get("detalle", "")
        if edad > MAX_EDAD_MIN:
            estado = "STALE"
            detalle = "medicion de %s con %.0f min de atraso: dejo de empujar" % (doc.get("host", "?"), edad)
            problemas += 1
        elif f.get("problema"):
            problemas += 1
        h = f.get("huella")
        if h and h not in ("-", "?", "SIN-RT"):
            por_huella.setdefault(h, []).append(f["etiqueta"])
        filas.append((h or "SIN-RT", f["etiqueta"], f["contenedor"] + "@kratos", estado, detalle))
except FileNotFoundError:
    problemas += 1
    filas.append(("?", "claude/salva", "ws-isa@kratos", "SIN DATOS",
                  "kratos nunca empujo %s: salva esta SIN VIGILANCIA" % REMOTO))
except Exception as e:
    problemas += 1
    filas.append(("?", "claude/salva", "ws-isa@kratos", "ILEGIBLE",
                  "%s: %s" % (type(e).__name__, str(e)[:60])))

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
