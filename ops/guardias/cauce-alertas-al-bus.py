#!/usr/bin/env python3
"""Lleva al bus las alertas que Prometheus ya sabe y que hoy no lee ningún humano.

`ops/observability/alerts.yaml` define ~40 reglas (20 críticas) y
`ops/observability/prometheus.yaml` no tiene bloque `alerting:`: desde que se retiró
Alertmanager las alertas se evalúan, se ven en la web de Prometheus y ahí mueren. Este
guardia es la vía que eligió el dueño en `docs/roadmap.md`: un timer que consulta
`/api/v1/alerts` y publica una entrega Cauce a `zeus` y a `kant`.

COMO SE LEE PROMETHEUS: `deploy/compose.yaml` le da `networks: [backend]` y NO le publica
puerto alguno (`docs/arquitectura.md`: puerto publicado «—», interno 9090), además de
dejarlo tras `profiles: [observability]`. Es decir: `127.0.0.1:9090` no responde ni en
kratos ni en agora-storage. La única vía es entrar a la red del compose, así que la lectura
por defecto es `docker exec <contenedor> wget -qO- .../api/v1/alerts` EN agora-storage por
ssh — el mismo salto que usa el médico. `--http-directo` sólo sirve desde dentro de esa red.

DONDE corre: `kratos`, timer de usuario cada 5 min (`systemd/cauce-alertas-al-bus.timer`).
El despacho también se ejecuta EN `agora-storage`: el certificado de cliente mTLS vive ahí
y no sale de ahí.

QUE PUBLICA, como máximo, en una corrida:
  - UNA entrega de digesto con todas las alertas `firing` (críticas primero, las primeras
    `TOPE_DETALLADO` en detalle y el resto por nombre). Una entrega por alerta despertaría
    a zeus y a kant N veces justo cuando la flota está degradada;
  - una entrega de alertas que dejaron de estar `firing` desde la corrida anterior;
  - una entrega de «poller detenido» si no se completa una LECTURA desde hace más de tres
    periodos, y otra distinta de «despacho fallando» si lo que falla es publicar;
  - una entrega de «lectura fallida» cuando no se puede leer Prometheus: quedarse callado
    ahí sería repetir, una capa más arriba, el fallo que este guardia viene a tapar.

SIN SECRETOS: sólo referencia rutas de certificados; no los copia ni los imprime.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.request

GUARDIA = "cauce-alertas-al-bus"
MARCA = f"[GUARDIA AUTOMATICO - {GUARDIA} - NO es kant]"
# Explicit destination, like the médico: a bare `agora` would need a `Host` stanza on
# whatever host installs the timer, and an ssh that never runs is never tested.
AGORA = "root@100.64.0.6"
CONTENEDOR_POR_DEFECTO = "cauce-v3-prod-prometheus-1"
PROMETHEUS_POR_DEFECTO = "http://127.0.0.1:9090"
SALA = "grp.steven"
DESTINATARIOS = [
    {"tenant_id": "Steven", "alias": "zeus"},
    {"tenant_id": "Steven", "alias": "kant"},
]
TOPE_DETALLADO = 10
PERIODO_TIMER_SEG = 300
PERIODOS_ANTES_DE_AVISAR = 3
ORDEN_SEVERIDAD = {"critical": 0, "warning": 1}
ESTADO_POR_DEFECTO = "~/.local/state/cauce-alertas-al-bus.json"
# Same key with a DIFFERENT body is a 409 and the delivery is lost mute, so the key mixes in
# the shape of the body it describes: change any `cuerpo_de_*` and bump this.
FORMATO_CUERPO = "v1"


class AlertReadError(RuntimeError):
    def __init__(self, code):
        super().__init__("alert read failed")
        self.code = code

# The dispatch runs ON the storage host: the client cert never leaves it. `/v3/messages` is
# machine-to-machine surface and a daemon with a client cert never sends `Origin`, so this
# does not send that header either.
DESPACHO = r'''
import json, ssl, sys, http.client
payload = json.loads(sys.stdin.read())
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
ctx.load_verify_locations("/etc/cauce-v3/pki/ca.crt")
ctx.load_cert_chain("/etc/cauce-v3/pki/console-client.crt",
                    "/etc/cauce-v3/pki/console-client.key")
c = http.client.HTTPSConnection("100.64.0.6", 8443, context=ctx, timeout=25)
c.request("POST", "/v3/messages", body=json.dumps(payload).encode(),
          headers={"content-type": "application/json", "accept": "application/json"})
r = c.getresponse()
status = r.status
r.close()
c.close()
print(status)
'''


def sh(comando, entrada=None, timeout=90):
    """Ejecuta `comando` en agora-storage por ssh. Devuelve (rc, out, err)."""
    cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", AGORA, comando]
    try:
        if entrada is None:
            r = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True,
                               text=True, timeout=timeout)
        else:
            r = subprocess.run(cmd, input=entrada, capture_output=True, text=True,
                               timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout tras {timeout}s"
    except Exception as e:  # noqa: BLE001
        return 1, "", f"{type(e).__name__}: {e}"


def obtener_alertas(url, contenedor=CONTENEDOR_POR_DEFECTO, http_directo=False,
                    desde_fichero=None):
    """Devuelve la lista cruda de alertas de `/api/v1/alerts`."""
    if desde_fichero:
        try:
            crudo = pathlib.Path(desde_fichero).read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            raise AlertReadError("file_read_failed") from None
    elif http_directo:
        try:
            with urllib.request.urlopen(f"{url}/api/v1/alerts", timeout=20) as r:
                crudo = r.read().decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            raise AlertReadError("http_read_failed") from None
    else:
        # `wget` es el cliente que la propia imagen usa en su healthcheck; `curl` no está.
        rc, out, _ = sh(f"docker exec {contenedor} wget -q -O - {url}/api/v1/alerts",
                        timeout=60)
        if rc != 0:
            raise AlertReadError("remote_read_failed")
        crudo = out
    try:
        documento = json.loads(crudo)
    except (TypeError, ValueError):
        raise AlertReadError("invalid_json") from None
    if not isinstance(documento, dict):
        raise AlertReadError("invalid_response_shape")
    datos = documento.get("data", {})
    if not isinstance(datos, dict):
        raise AlertReadError("invalid_response_shape")
    alertas = datos.get("alerts", documento.get("alerts", []))
    if not isinstance(alertas, list):
        raise AlertReadError("invalid_alerts_shape")
    return alertas


def identidad(alerta):
    """(alertname, huella, inicio): los tres campos ESTABLES de una alerta.

    `/api/v1/alerts` de Prometheus trae `activeAt` y NO trae `fingerprint`; `startsAt` y la
    huella son la forma de Alertmanager. Sin huella se deriva de las etiquetas ordenadas,
    que también son estables mientras la alerta siga siendo la misma.
    """
    etiquetas = alerta.get("labels", {}) or {}
    nombre = etiquetas.get("alertname", "sin-nombre")
    inicio = alerta.get("startsAt") or alerta.get("activeAt") or ""
    huella = alerta.get("fingerprint") or hashlib.sha256(
        json.dumps(etiquetas, sort_keys=True).encode("utf-8")).hexdigest()[:16]
    return nombre, huella, inicio


def identidad_texto(alerta):
    return "|".join(identidad(alerta))


def _sanear(texto):
    return re.sub(r"[^a-zA-Z0-9_.-]", "_", texto)[:32]


def _clave(tipo, partes):
    """Toda idempotency_key del guardia: función PURA de `partes` y del formato del cuerpo.

    Ni la clave ni el cuerpo pueden llevar relojes, contadores ni textos del tipo «hace N
    min»: misma clave con cuerpo distinto es un 409 y la entrega se pierde en silencio.
    """
    material = "\n".join([FORMATO_CUERPO, tipo, *partes])
    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()
    return f"alertas-{_sanear(tipo)}-{digest[:16]}"


def severidad_de(alerta):
    return ((alerta.get("labels", {}) or {}).get("severity", "") or "").lower()


def alertas_firing(alertas):
    """Sólo `firing`, críticas primero. `pending` y `resolved` se descartan."""
    vivas = [a for a in alertas if (a.get("state") or "").lower() == "firing"]
    def orden(alerta):
        nombre, huella, _ = identidad(alerta)
        return (ORDEN_SEVERIDAD.get(severidad_de(alerta), 99), nombre, huella)
    return sorted(vivas, key=orden)


def bloque_de_alerta(alerta):
    etiquetas = alerta.get("labels", {}) or {}
    anotaciones = alerta.get("annotations", {}) or {}
    nombre, huella, inicio = identidad(alerta)
    severidad = (severidad_de(alerta) or "sin-severidad").upper()
    return "\n".join([
        f"- {severidad} {nombre}: {anotaciones.get('summary', '(la regla no trae summary)')}",
        f"  job={etiquetas.get('job', '?')} instance={etiquetas.get('instance', '?')}"
        f" desde {inicio or '?'} (huella {huella})",
    ])


def cuerpo_de_digesto(vivas):
    criticas = [a for a in vivas if severidad_de(a) == "critical"]
    lineas = [f"ALERTAS FIRING: {len(vivas)} ({len(criticas)} críticas)"]
    lineas += [bloque_de_alerta(a) for a in vivas[:TOPE_DETALLADO]]
    resto = vivas[TOPE_DETALLADO:]
    if resto:
        nombres = sorted({identidad(a)[0] for a in resto})
        lineas.append(f"Y {len(resto)} más sin detalle: " + ", ".join(nombres))
        lineas.append("Lista completa en la web de Prometheus, /alerts.")
    lineas.append("Reglas en ops/observability/alerts.yaml. El guardia sólo lee")
    lineas.append("/api/v1/alerts: no silencia, no resuelve y no reintenta nada.")
    return "\n".join(lineas)


def clave_de_digesto(vivas):
    return _clave("digesto", sorted(identidad_texto(a) for a in vivas))


def dejaron_de_firing(conocidas, vivas):
    """Identidades que estaban firing en la corrida anterior y ya no están."""
    ahora_vivas = {identidad_texto(a) for a in vivas}
    return sorted(i for i in (conocidas or [])
                  if isinstance(i, str) and i and i not in ahora_vivas)


def cuerpo_de_resueltas(identidades):
    nombres = sorted({i.split("|", 1)[0] for i in identidades})
    lineas = [f"YA NO ESTAN FIRING: {len(identidades)} alertas se apagaron desde la corrida"
              " anterior de este guardia."]
    lineas.append("Cerradas: " + ", ".join(nombres[:TOPE_DETALLADO]))
    if len(nombres) > TOPE_DETALLADO:
        lineas.append(f"(y {len(nombres) - TOPE_DETALLADO} nombres más)")
    lineas.append("Prometheus dejó de evaluarlas como firing; nadie las silenció a mano.")
    return "\n".join(lineas)


def clave_de_resueltas(identidades):
    return _clave("resueltas", sorted(identidades))


def cuerpo_de_poller_detenido(marca_anterior):
    return "\n".join([
        "POLLER DETENIDO: este guardia no completó una LECTURA de Prometheus desde "
        + marca_anterior,
        f"y el timer debería correr cada {PERIODO_TIMER_SEG // 60} min.",
        "Mientras estuvo ciego, ninguna alerta de Prometheus se pudo mirar siquiera.",
        "Revisar en kratos: systemctl --user status cauce-alertas-al-bus.timer",
    ])


def clave_de_poller_detenido(marca_anterior):
    return _clave("poller_detenido", [marca_anterior])


def cuerpo_de_despacho_fallando(marca_anterior):
    return "\n".join([
        "DESPACHO FALLANDO: ninguna publicación de este guardia salió con 202 desde "
        + marca_anterior + ".",
        "El timer corre y Prometheus se lee: lo que falla es el POST a /v3/messages",
        "por ssh a agora-storage, así que hubo alertas que no llegaron al bus.",
        "Revisar en kratos: journalctl --user -u cauce-alertas-al-bus.service -n 50",
    ])


def clave_de_despacho_fallando(marca_anterior):
    return _clave("despacho_fallando", [marca_anterior])


def ventana_de(ahora):
    """La hora UTC en curso: acota a un aviso por hora los fallos de lectura repetidos."""
    return ahora.strftime("%Y-%m-%dT%H")


def cuerpo_de_lectura_fallida(motivo, ventana):
    return "\n".join([
        f"SIN LECTURA DE PROMETHEUS (ventana {ventana} UTC): {motivo}",
        "El guardia no sabe qué alertas hay; NO asumas que no hay ninguna.",
        "Prometheus no publica puerto: se lee con docker exec en agora-storage y está",
        "tras el perfil `observability`, así que puede estar simplemente apagado.",
        f"Comprobar: ssh {AGORA} \"docker ps --filter name=prometheus\"",
    ])


def clave_de_lectura_fallida(motivo, ventana):
    return _clave("lectura_fallida", [ventana, motivo])


def payload_de(cuerpo, clave, lane="interactive"):
    return {
        "room_id": SALA,
        "recipients": list(DESTINATARIOS),
        "body": {"text": MARCA + "\n" + cuerpo, "guardia": GUARDIA, "es_automatico": True},
        "idempotency_key": clave,
        "lane": lane,
    }


def ruta_de_estado():
    return pathlib.Path(os.environ.get("CAUCE_ALERTAS_ESTADO",
                                       os.path.expanduser(ESTADO_POR_DEFECTO)))


def leer_estado():
    """Estado de la corrida anterior, o `{}` si no hay o está corrupto."""
    try:
        documento = json.loads(ruta_de_estado().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return documento if isinstance(documento, dict) else {}


def guardar_estado(estado):
    ruta = ruta_de_estado()
    ruta.parent.mkdir(parents=True, exist_ok=True)
    ruta.write_text(json.dumps({**estado, "guardia": GUARDIA}) + "\n", encoding="utf-8")


def detenido(marca_anterior, ahora, periodos=PERIODOS_ANTES_DE_AVISAR):
    """Sin marca no se avisa: una instalación nueva no es un guardia caído."""
    if not isinstance(marca_anterior, str) or not marca_anterior:
        return False
    try:
        anterior = datetime.datetime.fromisoformat(marca_anterior.replace("Z", "+00:00"))
        transcurrido = (ahora - anterior).total_seconds()
    except (ValueError, TypeError):
        # Una marca escrita a mano sin zona horaria parsea bien y revienta al restar
        # (TypeError): un estado corrupto no puede tumbar la corrida.
        return False
    return transcurrido > PERIODO_TIMER_SEG * periodos


def planificar(alertas, estado=None, ahora=None):
    """Los payloads de UNA corrida. Función pura: es lo que miden los tests."""
    estado = estado or {}
    ahora = ahora or datetime.datetime.now(datetime.timezone.utc)
    vivas = alertas_firing(alertas)
    payloads = []
    if vivas:
        hay_criticas = any(severidad_de(a) == "critical" for a in vivas)
        payloads.append(payload_de(cuerpo_de_digesto(vivas), clave_de_digesto(vivas),
                                   "interactive" if hay_criticas else "batch"))
    cerradas = dejaron_de_firing(estado.get("firing_conocidas"), vivas)
    if cerradas:
        payloads.append(payload_de(cuerpo_de_resueltas(cerradas),
                                   clave_de_resueltas(cerradas), "batch"))
    corrida = estado.get("ultima_corrida_ok")
    if detenido(corrida, ahora):
        payloads.append(payload_de(cuerpo_de_poller_detenido(corrida),
                                   clave_de_poller_detenido(corrida)))
    despacho = estado.get("ultimo_despacho_ok")
    if detenido(despacho, ahora):
        payloads.append(payload_de(cuerpo_de_despacho_fallando(despacho),
                                   clave_de_despacho_fallando(despacho)))
    return payloads


def estado_siguiente(estado, vivas, ahora, lectura_ok, fallos):
    """La lectura y el despacho llevan marcas SEPARADAS: son dos fallos distintos.

    Un 409 o un ssh caído en una publicación no puede congelar la marca de lectura, porque
    entonces el aviso de «poller detenido» acusaría al timer de estar parado estándolo.
    """
    nuevo = {k: v for k, v in estado.items() if k != "guardia"}
    marca = ahora.isoformat()
    if lectura_ok:
        nuevo["ultima_corrida_ok"] = marca
    if not fallos:
        nuevo["ultimo_despacho_ok"] = marca
        if lectura_ok:
            nuevo["firing_conocidas"] = [identidad_texto(a) for a in vivas]
    return nuevo


def publicar(payload):
    """Publica UNA entrega Cauce. 202 es éxito, como en el médico."""
    prog = DESPACHO.replace("json.loads(sys.stdin.read())", f"json.loads({json.dumps(payload)!r})")
    rc, out, _ = sh("python3 -", entrada=prog, timeout=90)
    estado = out.strip()
    if rc != 0 or re.fullmatch(r"[0-9]{3}", estado) is None:
        return False, None
    codigo = int(estado)
    return codigo == 202, codigo


def construir_parser():
    p = argparse.ArgumentParser(description="Publica al bus las alertas firing de Prometheus")
    p.add_argument("--prometheus-url", default=PROMETHEUS_POR_DEFECTO,
                   help="URL DENTRO de la red del compose (no hay puerto publicado)")
    p.add_argument("--contenedor", default=CONTENEDOR_POR_DEFECTO,
                   help="contenedor de Prometheus en agora-storage")
    p.add_argument("--http-directo", action="store_true",
                   help="consulta por HTTP desde este host: sólo desde la red `backend`")
    p.add_argument("--desde-fichero", help="lee el JSON de /api/v1/alerts de un fichero")
    p.add_argument("--dry-run", action="store_true",
                   help="muestra conteos y no publica (tampoco escribe estado)")
    return p


def main(argv=None):
    args = construir_parser().parse_args(argv)
    ahora = datetime.datetime.now(datetime.timezone.utc)
    estado = leer_estado()
    try:
        alertas = obtener_alertas(args.prometheus_url, args.contenedor,
                                  args.http_directo, args.desde_fichero)
    except Exception as error:  # noqa: BLE001
        motivo = error.code if isinstance(error, AlertReadError) else "unexpected_read_failure"
        ventana = ventana_de(ahora)
        print(f"{GUARDIA}: no se pudieron leer las alertas: {motivo}")
        # Callarse aquí reproduce el fallo que el guardia existe para tapar, así que el
        # fallo de lectura se publica igual: es lo único que el bus puede saber.
        payloads, alertas, lectura_ok = [payload_de(
            cuerpo_de_lectura_fallida(motivo, ventana),
            clave_de_lectura_fallida(motivo, ventana))], [], False
    else:
        lectura_ok = True
        payloads = planificar(alertas, estado, ahora)
        print(f"{GUARDIA}: {len(alertas)} alertas leídas, {len(payloads)} entregas a publicar")
    if args.dry_run:
        print(f"{GUARDIA}: dry-run completo; {len(payloads)} entregas no publicadas")
        return 0 if lectura_ok else 1
    fallos = 0
    for indice, payload in enumerate(payloads, start=1):
        ok, codigo = publicar(payload)
        resultado = f"HTTP {codigo}" if isinstance(codigo, int) and 100 <= codigo <= 599 \
            else "SIN CODIGO HTTP"
        print(f"despacho {indice}/{len(payloads)} -> {'OK' if ok else 'FALLO'} ({resultado})")
        fallos += 0 if ok else 1
    guardar_estado(estado_siguiente(estado, alertas_firing(alertas), ahora,
                                    lectura_ok, fallos))
    return 1 if (fallos or not lectura_ok) else 0


if __name__ == "__main__":
    sys.exit(main())
