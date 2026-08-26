#!/usr/bin/env python3
"""Inyector diario del check-in de ventas de hegel (tenant Jhon).

Publica UN mensaje al alias `hegel` por el endpoint de publicación del gateway de
Cauce V3 (`POST /v3/messages`). El gateway, al recibir el publish, crea una fila en
`deliveries` para `hegel`, que hace que hegel corra un turno con el texto del mensaje.

QUE HACE hegel con ese turno: leer sus notas de ventas y mandarle a Jhon por Telegram
un repaso proactivo del pipeline, y volcar la respuesta al CRM. El texto va literal
en `body.text` (ver MENSAJE abajo) — es el prompt que hegel ejecuta.

DONDE corre: en `agora-storage`, como unidad systemd de sistema disparada por
`hegel-ventas-checkin.timer` a las 13:00 UTC (= 08:00 America/Bogota). Se elige ese
host porque (a) el gateway escucha ahí mismo en 100.64.0.6:8443, así que la llamada es
local; (b) los certificados de cliente mTLS viven ahí, en /etc/cauce-v3/pki, y no hay
que copiarlos a ningún lado; (c) tiene systemd de sistema con supervisor confiable.

AUTENTICACION: mTLS. Se presenta el certificado de cliente del PROPIO hegel
(agent-hegel.crt/.key). El gateway deriva tenant+alias del certificado, nunca del
cuerpo: por eso el actor es `Jhon:hegel` y el mensaje se queda dentro del tenant de
hegel (destinatario hegel/Jhon, room grp.jhon) — radio de daño acotado a hegel, sin
cruzar tenants. hegel tiene el permiso `route` (message.publish), verificado en vivo.

IDEMPOTENCIA: la idempotency_key lleva la fecha UTC del día. Correrlo dos veces el
mismo día NO duplica la entrega (el gateway deduplica por (tenant, idempotency_key));
cada día nuevo produce una entrega nueva.

SIN SECRETOS: este archivo referencia los certificados por ruta; nunca los copia ni
imprime su contenido. Sólo imprime status HTTP y el message_id devuelto.

Env opcionales (con defaults de agora-storage):
  CAUCE_GATEWAY_HOST  (default 100.64.0.6)
  CAUCE_GATEWAY_PORT  (default 8443)
  CAUCE_PKI_DIR       (default /etc/cauce-v3/pki)
"""
import datetime
import http.client
import json
import os
import ssl
import sys

GATEWAY_HOST = os.environ.get("CAUCE_GATEWAY_HOST", "100.64.0.6")
GATEWAY_PORT = int(os.environ.get("CAUCE_GATEWAY_PORT", "8443"))
PKI_DIR = os.environ.get("CAUCE_PKI_DIR", "/etc/cauce-v3/pki")

CA_FILE = os.path.join(PKI_DIR, "ca.crt")
CERT_FILE = os.path.join(PKI_DIR, "agent-hegel.crt")
KEY_FILE = os.path.join(PKI_DIR, "agent-hegel.key")

# EXACTO — es el prompt que hegel ejecuta. No editar sin intención.
MENSAJE = "Check-in de ventas con Jhon: leer ventas/CRM.md y ventas/JHON.md y enviar a Jhon por su canal directo ya autorizado un repaso corto y proactivo (saludo, en qué anda hoy, acciones urgentes del pipeline, 2-3 preguntas para llenar el CRM) y volcar la respuesta al CRM."


def main() -> int:
    today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    payload = {
        "room_id": "grp.jhon",
        "recipients": [{"tenant_id": "Jhon", "alias": "hegel"}],
        "body": {"text": MENSAJE},
        "idempotency_key": f"hegel-ventas-checkin-{today}",
    }
    body = json.dumps(payload).encode("utf-8")

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.load_verify_locations(CA_FILE)
    ctx.load_cert_chain(CERT_FILE, KEY_FILE)
    # El cert del gateway trae SAN IP 100.64.0.6, así que conectando por IP la
    # verificación de host pasa. check_hostname queda en su default (True).

    conn = http.client.HTTPSConnection(GATEWAY_HOST, GATEWAY_PORT, context=ctx, timeout=20)
    try:
        conn.request(
            "POST",
            "/v3/messages",
            body=body,
            headers={"content-type": "application/json", "accept": "application/json"},
        )
        resp = conn.getresponse()
        text = resp.read().decode("utf-8", "replace")
    finally:
        conn.close()

    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    print(f"[{stamp}] key=hegel-ventas-checkin-{today} POST /v3/messages -> HTTP {resp.status}")
    print(text)
    # 202 = aceptado (nueva entrega o dedup del mismo día); ambos son éxito.
    return 0 if resp.status == 202 else 1


if __name__ == "__main__":
    sys.exit(main())
