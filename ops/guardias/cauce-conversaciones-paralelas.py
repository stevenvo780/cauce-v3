#!/usr/bin/env python3
"""Guardia «una sola conversación por alias»: avisa al médico (zeus) por el bus, sin modelo.

Un alias atiende a sus personas en UNA conversación: la que muestra la consola (la TUI de
claude/codex o la sesión canónica de OpenClaw). Si en 24 h los turnos HUMANOS de un alias salieron
de más de una conversación nativa (`harness_consumption_v1.native_session_id`), alguien habla con
una copia que no ve. Humano = el mensaje lleva `human_initiator` (raíz o continuación de su cadena)
o es un `telegram.message` del puente (las continuaciones entre agentes van por el carril de agente).

DONDE corre: en el host de la base (vpstn), timer de sistema cada hora. Sólo lee la base y publica
UNA entrega a zeus con el certificado de cliente de la consola, como `cauce-alertas-al-bus`.
Un mismo alias con el mismo juego de conversaciones no se repite antes de `SILENCIO_H`; el aviso
se apunta DESPUÉS de que el bus lo aceptó, nunca antes.
"""
from __future__ import annotations

import datetime
import hashlib
import http.client
import json
import os
import re
import ssl
import subprocess
import sys

GUARDIA = "cauce-conversaciones-paralelas"
MARCA = f"[GUARDIA AUTOMATICO - {GUARDIA} - NO es kant]"
ESTADO = os.environ.get("CAUCE_PARALELAS_ESTADO", "/var/lib/cauce-conversaciones-paralelas.json")
SILENCIO_H = 6
PG = ["docker", "exec", "-i", "cauce-v3-prod-postgres-1", "psql", "-U", "cauce", "-d", "cauce", "-X", "-At", "-F", "\t"]
PKI = "/etc/cauce-v3/pki"
GATEWAY = ("100.64.0.6", 8443)
SALA = "grp.steven"
DESTINATARIOS = [{"tenant_id": "Steven", "alias": "zeus"}]

CONSULTA = """
with t as (
  select recipient.company_id, d.recipient_tenant tenant, d.recipient_alias alias,
         a.payload->'result'->'harness_consumption_v1'->>'native_session_id' sesion,
         coalesce(m.auth_channel, '?') canal, h.initiating_human_id humano,
         d.terminal_at
    from deliveries d
    join messages m on m.id = d.message_id
    join tenants recipient on recipient.id = d.recipient_tenant
    join tenants source on source.id = m.tenant_id
    join delivery_acks a on a.delivery_id = d.id and a.applied and a.status = 'done'
    left join human_message_initiators h on h.message_id = m.id
   where d.terminal_at > now() - interval '24 hours'
     and recipient.company_id = :'guard_company_id' and source.company_id = :'guard_company_id'
     and (h.message_id is not null or (m.auth_channel = 'telegram' and m.body->>'type' = 'telegram.message'))),
s as (
  select company_id, tenant, alias, sesion, count(*) turnos, string_agg(distinct canal, ',') canales,
         count(distinct humano) humanos, max(terminal_at) ultimo
    from t where sesion is not null group by 1, 2, 3, 4),
v as (select company_id, tenant, alias from s group by 1, 2, 3 having count(*) > 1)
select s.company_id, s.tenant, s.alias, left(s.sesion, 8), s.turnos, s.canales, s.humanos,
       to_char(s.ultimo at time zone 'UTC', 'MM-DD HH24:MI')
  from s join v using (company_id, tenant, alias) order by s.tenant, s.alias, s.turnos desc;
"""


def company_id() -> str:
    company = os.environ.get("CAUCE_GUARD_COMPANY_ID", "humanizar")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", company):
        raise ValueError("CAUCE_GUARD_COMPANY_ID inválido")
    return company


def sql(consulta: str) -> list[list[str]]:
    command = [*PG, "-v", "ON_ERROR_STOP=1", "-v", f"guard_company_id={company_id()}"]
    hecho = subprocess.run(command, input=consulta, capture_output=True, text=True, timeout=60, check=False)
    if hecho.returncode != 0:
        raise RuntimeError(f"psql rc={hecho.returncode}")
    return [linea.split("\t") for linea in hecho.stdout.splitlines() if linea.strip()]


def paralelas(filas: list[list[str]]) -> dict[tuple[str, str, str], list[tuple[str, ...]]]:
    alias: dict[tuple[str, str, str], list[tuple[str, ...]]] = {}
    company = company_id()
    for owner, tenant, nombre, sesion, turnos, canales, humanos, ultimo in filas:
        if owner == company:
            alias.setdefault((owner, tenant, nombre), []).append((sesion, turnos, canales, humanos, ultimo))
    return alias


def clave(nombre: tuple[str, str, str], sesiones: list[tuple[str, ...]]) -> str:
    """Mismo alias con el mismo juego de conversaciones = el mismo problema."""
    return "/".join(nombre) + ":" + ",".join(sorted(s[0] for s in sesiones))


def texto(nuevos: dict[tuple[str, str, str], list[tuple[str, ...]]]) -> str:
    lineas = [MARCA, "Alias que atendieron a personas desde más de una conversación en 24 h:"]
    company = company_id()
    for (owner, tenant, nombre), sesiones in sorted(nuevos.items()):
        if owner != company:
            continue
        detalle = "; ".join(f"{s} x{t} [{c}] humanos={h} último {u} UTC" for s, t, c, h, u in sesiones)
        lineas.append(f"- {tenant}/{nombre}: {detalle}")
    lineas.append("Sólo una es la que muestra la consola. Si la otra es de alguien que debería verla, falta "
                  "en OWNER_HUMAN_ID/SHARED_HUMANS del alias; si es de su dueño, la regla no lo enruta.")
    return "\n".join(lineas)


def payload_de(cuerpo: str, claves: list[str]) -> dict:
    check_destination()
    huella = hashlib.sha256("|".join(sorted(claves)).encode()).hexdigest()[:24]
    return {"room_id": SALA, "recipients": list(DESTINATARIOS), "lane": "interactive",
            "body": {"text": cuerpo, "guardia": GUARDIA, "es_automatico": True},
            "idempotency_key": f"{GUARDIA}-{huella}"}


def publicar(payload: dict) -> int:
    check_destination()
    contexto = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    contexto.load_verify_locations(f"{PKI}/ca.crt")
    contexto.load_cert_chain(f"{PKI}/console-client.crt", f"{PKI}/console-client.key")
    conexion = http.client.HTTPSConnection(*GATEWAY, context=contexto, timeout=25)
    conexion.request("POST", "/v3/messages", body=json.dumps(payload).encode(),
                     headers={"content-type": "application/json", "accept": "application/json"})
    estado = conexion.getresponse().status
    conexion.close()
    return estado


def check_destination() -> None:
    if company_id() != "humanizar":
        raise RuntimeError("el destino de la guardia pertenece a humanizar")


def vigentes(memoria: dict[str, str], ahora: datetime.datetime) -> dict[str, str]:
    prefix = company_id() + "/"
    return {k: v for k, v in memoria.items()
            if k.startswith(prefix) and
            (ahora - datetime.datetime.fromisoformat(v)).total_seconds() < SILENCIO_H * 3600}


def corrida(filas: list[list[str]], memoria: dict[str, str], ahora: datetime.datetime,
            enviar=publicar) -> tuple[dict[str, str], str | None]:
    """Devuelve la memoria nueva y el texto avisado (None si no hubo aviso)."""
    memoria = vigentes(memoria, ahora)
    nuevos = {nombre: sesiones for nombre, sesiones in paralelas(filas).items()
              if clave(nombre, sesiones) not in memoria}
    if not nuevos:
        return memoria, None
    claves = [clave(nombre, sesiones) for nombre, sesiones in nuevos.items()]
    cuerpo = texto(nuevos)
    estado = enviar(payload_de(cuerpo, claves))
    if estado != 202:
        raise RuntimeError(f"el bus devolvió {estado}; el aviso queda pendiente para la próxima corrida")
    return {**memoria, **{k: ahora.isoformat() for k in claves}}, cuerpo


def main() -> int:
    ahora = datetime.datetime.now(datetime.UTC)
    try:
        with open(ESTADO, encoding="utf-8") as fichero:
            memoria = json.load(fichero).get("avisados", {})
    except (OSError, ValueError):
        memoria = {}
    filas = sql(CONSULTA)
    if "--sin-aviso" in sys.argv:
        print(texto(paralelas(filas)) if filas else "sin conversaciones paralelas")
        return 0
    memoria, avisado = corrida(filas, memoria, ahora)
    temporal = ESTADO + ".tmp"
    with open(temporal, "w", encoding="utf-8") as fichero:
        json.dump({"ts": ahora.isoformat(), "avisados": memoria}, fichero)
    os.replace(temporal, ESTADO)
    print(avisado or f"{len(paralelas(filas))} alias con conversaciones paralelas, ya avisados o ninguno")
    return 0


if __name__ == "__main__":
    sys.exit(main())
