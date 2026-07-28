#!/usr/bin/env python3
"""
Recolector de cuotas de IA para Cauce V3.

Por que existe: el consumo de las suscripciones (claude/codex/antigravity/opencode) lo sabe
el CLI local 'ai-usage' (mismo dato que expone la tool MCP get_ai_quotas), que vive en kratos y
en los contenedores de agente, NUNCA en agora-storage donde corren el gateway y la consola. Sin
un recolector que lo muestree y lo empuje por HTTP, el panel de cuotas no tiene de donde leer, y
el incidente que motivo este trabajo (un agente con 71 entregas en vuelo que agoto una suscripcion
paga sin que nadie lo viera) se repite en silencio.

Que hace, en orden:
  1. Invoca 'ai-usage --json' (o el comando que indique CAUCE_QUOTA_AI_USAGE_CMD) y parsea su
     salida, que trae la forma providers.<nombre>.windows[] descrita en el runbook.
  2. Normaliza cada ventana a (host, provider, group_key, window_key), la unidad minima que le
     importa al panel: group_key = window.limitId (o el equivalente) o 'default', window_key =
     window.key. Aplastar esto a un numero por proveedor es EXACTAMENTE el error que hace ver
     saldo en una cuenta que no lo tiene (hoy: codex al 100% y codex_bengalfox al 0%).
  3. Resuelve, por un archivo de intencion local (CAUCE_QUOTA_ACCOUNT_BINDINGS_FILE), que
     account_id de Cauce corresponde a cada (provider, group_key). El gateway NUNCA adivina esto
     solo: el recolector es el unico componente que ve a la vez la sesion real del CLI y la
     intencion del operador.
  4. Publica POST /v3/quotas/samples via mTLS (identidad dedicada, rol operator + permiso
     control). La ruta vive fuera de /v3/console/ a proposito: ese prefijo exige un header
     Origin same-origin que un demonio jamas manda.

Principio de robustez, pedido explicitamente: si UN proveedor no responde (o el CLI entero no
corre), se publican los que si respondieron y se reporta el que fallo como ok=false, en vez de
no publicar nada. La unica razon para no publicar del todo es un error de CONFIGURACION local
(host invalido, PKI ausente): eso es un bug del despliegue, no del dato, y merece frenar en vez
de mandar basura.

Nunca se loguea contenido de credenciales: el script solo pasa PATHs de certificados a la libreria
ssl, jamas los lee ni los imprime. Los unicos textos libres que via stderr son mensajes de error
de subprocess/HTTP, que en el peor caso traen un fragmento acotado de stderr del CLI (nunca su
stdout completo, por si algun proveedor llegara a volcar un token ahi).

Uso:
  quota-collector.py [--dry-run] [--input-file PATH] [--gateway-url URL] [--pki-dir DIR]
                      [--host HOST] [--account-bindings-file PATH]

Variables de entorno (ver ops/config/quota-collector.env.example):
  CAUCE_QUOTA_GATEWAY_URL              default https://100.64.0.6:8443/v3/quotas/samples
  CAUCE_QUOTA_GATEWAY_SERVER_NAME      opcional: nombre a verificar en el cert del gateway si
                                        NO trae la IP de CAUCE_QUOTA_GATEWAY_URL como SAN (mismo
                                        escape hatch que RELAY_SERVER_NAME en ops/pty-agent).
                                        Sin esto, se verifica contra la IP/host de la URL, con
                                        check_hostname SIEMPRE prendido.
  CAUCE_QUOTA_PKI_DIR                  default ~/.config/cauce-v3/container-pki/quota-collector
  CAUCE_QUOTA_HOST                     default hostname() de la maquina
  CAUCE_QUOTA_AI_USAGE_CMD             default "ai-usage --json"
  CAUCE_QUOTA_AI_USAGE_TIMEOUT_SECONDS default 45
  CAUCE_QUOTA_PROVIDERS                default "claude,codex,antigravity,opencode" (fallback
                                        cuando el CLI entero no responde: se publica un reporte
                                        ok=false por cada uno en vez de quedarse sin publicar)
  CAUCE_QUOTA_ACCOUNT_BINDINGS_FILE    default ~/.config/cauce-v3/quota-collector/account-bindings.json
  CAUCE_QUOTA_HTTP_TIMEOUT_SECONDS     default 20
  CAUCE_QUOTA_HTTP_RETRIES             default 2 (reintentos extra ante fallos de red; NO ante 4xx)
  CAUCE_QUOTA_HTTP_RETRY_DELAY_SECONDS default 3
  CAUCE_QUOTA_INPUT_FILE               solo debug/tests: lee el JSON crudo de un archivo en vez
                                        de invocar ai-usage
  CAUCE_QUOTA_DRY_RUN=1                arma el payload y lo imprime por stdout; no publica

Salida (exit code):
  0  publicado con exito (incluye el caso "se publico un reporte de falla total": el POST en si
     funciono, lo que fallo fue la fuente de datos, y eso YA es informacion util para el panel)
  1  fallo de red/HTTP contra el gateway tras agotar reintentos
  2  error de configuracion local (host invalido, PKI ausente, --input-file ilegible): nada se
     intento publicar
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import pathlib
import re
import shlex
import shutil
import socket
import ssl
import subprocess
import sys
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

# Version del SHAPE de get_ai_quotas contra el que esta escrito el mapeo de abajo (hoy: 2, ver
# CONTEXTO del pedido). Si la herramienta no informa su propia schemaVersion, se declara esta,
# porque es la unica que el script sabe interpretar; si la informa y difiere, se publica igual
# y es el GATEWAY el que tiene que rechazar un major desconocido con 422 (no este script: no
# tiene visibilidad de que cambio exactamente).
COLLECTOR_SCHEMA_VERSION = 2

DEFAULT_GATEWAY_URL = 'https://100.64.0.6:8443/v3/quotas/samples'
DEFAULT_AI_USAGE_CMD = 'ai-usage --json'
DEFAULT_PROVIDERS = ['claude', 'codex', 'antigravity', 'opencode']

HOST_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$')
PROVIDER_RE = re.compile(r'^[a-z][a-z0-9_.-]{0,63}$')
KEY_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')
STATUS_RE = re.compile(r'^[a-z][a-z0-9_-]{0,31}$')


class QuotaCollectionError(RuntimeError):
    """Error de configuracion o de datos que amerita frenar ANTES de intentar publicar nada.
    Se distingue a proposito de un fallo de red (ver post_samples): esto es un bug de despliegue
    local, no una falla transitoria del gateway, asi que reintentar no ayuda."""


def log(message: str) -> None:
    print(f'[quota-collector] {message}', file=sys.stderr)


def env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    return value if value not in (None, '') else default


def iso_now() -> str:
    dt = datetime.now(timezone.utc)
    return dt.strftime('%Y-%m-%dT%H:%M:%S.') + f'{dt.microsecond // 1000:03d}Z'


def trim(value: Any, max_len: int) -> str | None:
    """Recorta a max_len y descarta cadenas vacias: varias columnas de la 013 exigen longitud
    BETWEEN 1 y N, y un '' pasaria el chequeo de Python pero rompería el CHECK de Postgres."""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if len(text) > max_len:
        text = text[: max_len - 1].rstrip() + '…'
    return text


def to_number(value: Any) -> float | None:
    """Para columnas numeric(5,2) acotadas a [0,100]. Un desborde CHICO (100.004 por redondeo
    interno del proveedor) se clampea: no tiene sentido tirar la fila entera por eso. Un
    desborde GRANDE (-50, 9999) NO se clampea a 0/100 -- se trata como dato ausente. Clampear
    ahi invertiria el diagnostico: un -50 leido como '0% usado' parece sano, y es exactamente lo
    que este panel existe para no dejar pasar."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float('inf'), float('-inf')):  # NaN / inf
        return None
    if number < -1.0 or number > 101.0:
        return None
    return round(max(0.0, min(100.0, number)), 2)


def to_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def to_units(value: Any, min_value: int) -> int | None:
    number = to_int(value)
    if number is None or number < min_value:
        return None
    return number


def to_str_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        text = trim(item, 128)
        if text:
            out.append(text)
    return out[:64]


def sanitize_status(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip().lower()
    return text if STATUS_RE.match(text) else None


def sanitize_key(value: Any, fallback: str) -> str:
    """group_key/window_key deben matchear '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' (CHECK de la
    013). Un valor crudo que no matchea NO se descarta -- se sanea, porque perder una ventana
    completa por un caracter raro es peor que guardarla con una clave levemente distinta."""
    text = '' if value is None else str(value).strip()
    if not text:
        text = fallback
    if KEY_RE.match(text):
        return text
    cleaned = re.sub(r'[^A-Za-z0-9_.:-]', '_', text)
    if not cleaned or not re.match(r'^[A-Za-z0-9]', cleaned):
        cleaned = 'x' + cleaned
    cleaned = cleaned[:128]
    return cleaned if KEY_RE.match(cleaned) else fallback


def sanitize_provider(value: Any) -> str:
    text = str(value).strip().lower()
    if PROVIDER_RE.match(text):
        return text
    cleaned = re.sub(r'[^a-z0-9_.-]', '_', text)
    if not cleaned or not cleaned[0].isalpha():
        cleaned = 'p_' + cleaned
    cleaned = cleaned[:64]
    return cleaned if PROVIDER_RE.match(cleaned) else 'unknown_provider'


def sanitize_host(value: str) -> str:
    text = (value or '').strip()
    if not HOST_RE.match(text):
        # No se inventa un host valido: mejor frenar aca que mandar una muestra que el CHECK de
        # quota_collections va a rechazar igual, pero recien despues de invocar los CLIs.
        raise QuotaCollectionError(f"host invalido para quota_collections.host: '{text}'")
    return text


def pick(d: dict, *keys: str, default: Any = None) -> Any:
    """Los CLIs de origen mezclan camelCase (ai-usage) y potencialmente snake_case si alguien
    normaliza antes; se prueban ambas grafias en vez de asumir una."""
    for key in keys:
        if key in d and d[key] is not None:
            return d[key]
    return default


# ------------------------------------------------------------------------------------------
# Bindings: (provider, group_key) -> account_id de provider_accounts.
# ------------------------------------------------------------------------------------------

class AccountBindings:
    """El archivo de intencion que mantiene el operador. Sin el (o sin una entrada para un
    grupo dado) la ventana igual se publica, con account_id=NULL y una binding_note: perder el
    dato porque no esta atado a una cuenta todavia es exactamente el error que costo el
    incidente original (el grupo nuevo que nadie vio)."""

    def __init__(self, path: str | None):
        self.path = path
        self.map: dict[tuple[str, str], str] = {}
        self.load_error: str | None = None
        if not path:
            self.load_error = 'CAUCE_QUOTA_ACCOUNT_BINDINGS_FILE no esta configurado'
            return
        try:
            raw = json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
        except FileNotFoundError:
            self.load_error = f'no existe el archivo de bindings ({path})'
            return
        except (OSError, json.JSONDecodeError) as exc:
            self.load_error = f'archivo de bindings ilegible ({path}): {exc}'
            return
        entries = raw.get('bindings') if isinstance(raw, dict) else None
        if not isinstance(entries, list):
            self.load_error = f"'{path}' no tiene una lista 'bindings'"
            return
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            provider = entry.get('provider')
            group_key = entry.get('group_key') or 'default'
            account_id = entry.get('account_id')
            if provider and account_id:
                self.map[(sanitize_provider(provider), sanitize_key(group_key, 'default'))] = str(account_id)

    def resolve(self, provider: str, group_key: str) -> tuple[str | None, str | None]:
        account_id = self.map.get((provider, group_key))
        if account_id:
            return account_id, None
        if self.load_error:
            return None, trim(self.load_error, 128)
        return None, trim(f'sin binding para {provider}/{group_key} en el archivo de intencion', 128)


# ------------------------------------------------------------------------------------------
# Invocacion del CLI ai-usage.
# ------------------------------------------------------------------------------------------

def resolve_binary(cmd: list[str]) -> list[str]:
    """ai-usage vive en ~/.local/bin en los contenedores de agente; en kratos podria no estar
    en PATH de una unit systemd (que arranca con un PATH minimo). Se prueba PATH primero y
    despues ~/.local/bin antes de rendirse -- subprocess ya da un error claro si ni asi aparece."""
    exe = cmd[0]
    if os.path.sep in exe or shutil.which(exe):
        return cmd
    fallback = os.path.join(os.path.expanduser('~'), '.local', 'bin', exe)
    if os.path.isfile(fallback):
        return [fallback, *cmd[1:]]
    return cmd


def run_ai_usage(cmd: list[str], timeout: int) -> dict[str, Any]:
    resolved = resolve_binary(cmd)
    try:
        result = subprocess.run(resolved, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError as exc:
        raise QuotaCollectionError(f'binario no encontrado: {resolved[0]}') from exc
    except subprocess.TimeoutExpired as exc:
        raise QuotaCollectionError(f'timeout tras {timeout}s ejecutando {resolved[0]}') from exc
    if result.returncode != 0:
        # Solo un fragmento acotado de stderr, y NUNCA stdout completo: si algun proveedor
        # vuelca un token de sesion en un mensaje de error, no queremos ese texto en nuestro log.
        raise QuotaCollectionError(f'{resolved[0]} salio con status {result.returncode}: {trim(result.stderr, 300)}')
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise QuotaCollectionError(f'salida de {resolved[0]} no es JSON valido: {exc}') from exc


def collect_raw(cmd: list[str], timeout: int, fallback_providers: list[str]) -> dict[str, Any]:
    """Punto de entrada tolerante a fallas: si el CLI entero no corre, se arma un JSON crudo
    sintetico con cada proveedor conocido marcado ok=false, para que el resto del pipeline lo
    trate exactamente igual que 'un proveedor no respondio' y SE PUBLIQUE -- la alternativa,
    no publicar nada, es indistinguible de 'el recolector no corrio' y esconde el problema."""
    try:
        return run_ai_usage(cmd, timeout)
    except QuotaCollectionError as exc:
        log(f'ai-usage no respondio ({exc}); se publica un reporte de falla total para '
            f'{len(fallback_providers)} proveedor(es) conocido(s) en vez de no publicar nada')
        note = trim(f'ai-usage no respondio: {exc}', 512)
        return {
            'providers': {
                name: {'ok': False, 'available': False, 'note': note}
                for name in fallback_providers
            }
        }


# ------------------------------------------------------------------------------------------
# Normalizacion: JSON crudo de ai-usage -> payload de POST /v3/quotas/samples.
# ------------------------------------------------------------------------------------------

def normalize_window(raw_window: dict) -> dict:
    window_key = sanitize_key(pick(raw_window, 'key', 'window_key'), 'window')
    used_percent = to_number(pick(raw_window, 'usedPercent', 'used_percent'))
    remaining_percent = to_number(pick(raw_window, 'remainingPercent', 'remaining_percent'))
    used_units = to_units(pick(raw_window, 'usedUnits', 'used_units'), 0)
    if used_percent is None and remaining_percent is None and used_units is None:
        # Espeja el CHECK quota_window_samples_has_a_number: una fila sin ningun numero de
        # consumo no informa nada y solo infla la serie. Se descarta ACA, con motivo, en vez de
        # dejar que el INSERT del gateway falle a ciegas.
        raise ValueError(f"ventana '{window_key}' sin usedPercent/remainingPercent/usedUnits")
    return {
        'window_key': window_key,
        'label': trim(pick(raw_window, 'label'), 64),
        'used_percent': used_percent,
        'remaining_percent': remaining_percent,
        'used_units': used_units,
        'limit_units': to_units(pick(raw_window, 'limitUnits', 'limit_units'), 1),
        'window_minutes': to_units(pick(raw_window, 'windowMinutes', 'window_minutes'), 1),
        'reset_at': pick(raw_window, 'resetAt', 'reset_at'),
        'status': sanitize_status(pick(raw_window, 'status')),
        'family': trim(pick(raw_window, 'family'), 64),
        'model': trim(pick(raw_window, 'model'), 128),
    }


def normalize_provider(name: str, raw: dict, bindings: AccountBindings, captured_at: str) -> dict:
    windows_raw = raw.get('windows')
    if not isinstance(windows_raw, list):
        windows_raw = []

    groups: dict[str, list[dict]] = {}
    dropped: list[str] = []
    for index, raw_window in enumerate(windows_raw):
        if not isinstance(raw_window, dict):
            dropped.append(f'ventana #{index} no es un objeto')
            continue
        try:
            window = normalize_window(raw_window)
        except ValueError as exc:
            dropped.append(str(exc))
            continue
        # Normalizacion obligatoria (decidida en el contrato): group_key = limitId o 'default'.
        # Es lo unico que separa 'codex' (agotado) de 'codex_bengalfox' (libre) dentro del mismo
        # proveedor -- aplastarlo haria ver saldo en la cuenta que justo no lo tiene.
        group_key = sanitize_key(pick(raw_window, 'limitId', 'limit_id', default='default'), 'default')
        groups.setdefault(group_key, []).append(window)

    group_list = []
    for group_key, windows in groups.items():
        account_id, binding_note = bindings.resolve(name, group_key)
        group_list.append({
            'group_key': group_key,
            'limit_id': None if group_key == 'default' else group_key,
            'account_id': account_id,
            'binding_note': binding_note,
            'windows': windows,
        })

    note = trim(pick(raw, 'note'), 512)
    if dropped:
        extra = f'{len(dropped)} ventana(s) descartada(s): {"; ".join(dropped[:3])}'
        note = f'{note} | {extra}' if note else trim(extra, 512)

    return {
        'provider': name,
        'ok': bool(pick(raw, 'ok', default=False)),
        'available': bool(pick(raw, 'available', default=False)),
        'kind': trim(pick(raw, 'kind'), 64),
        'source': trim(pick(raw, 'source'), 64),
        'plan': trim(pick(raw, 'plan'), 64),
        'note': note,
        'effective_remaining_percent': to_number(pick(raw, 'effectiveRemainingPercent', 'effective_remaining_percent')),
        'observed_at': pick(raw, 'observedAt', 'observed_at', default=captured_at),
        'available_groups': to_str_list(pick(raw, 'availableGroups', 'available_groups', default=[])),
        'limiting_groups': to_str_list(pick(raw, 'limitingGroups', 'limiting_groups', default=[])),
        'groups': group_list,
    }


def failed_provider_entry(name: str, reason: str, captured_at: str) -> dict:
    return {
        'provider': name, 'ok': False, 'available': False,
        'kind': None, 'source': None, 'plan': None,
        'note': trim(reason, 512),
        'effective_remaining_percent': None, 'observed_at': captured_at,
        'available_groups': [], 'limiting_groups': [], 'groups': [],
    }


def resolve_schema_version(raw: dict) -> int:
    reported = to_int(pick(raw, 'schemaVersion', 'schema_version'))
    if reported is None or not (1 <= reported <= 999):
        if reported is not None:
            log(f'schemaVersion reportado ({reported}) fuera de rango; se ignora')
        return COLLECTOR_SCHEMA_VERSION
    if reported != COLLECTOR_SCHEMA_VERSION:
        # No es un error del recolector: el gateway es quien tiene que decidir si es un major
        # desconocido (422) o una revision menor compatible. Este script solo avisa.
        log(f'schemaVersion reportado ({reported}) distinto del esperado ({COLLECTOR_SCHEMA_VERSION}); se publica igual')
    return reported


def build_payload(
    raw: Any, host: str, captured_at: str, bindings: AccountBindings, fallback_providers: list[str],
) -> dict:
    providers_raw = raw.get('providers') if isinstance(raw, dict) else None
    if not isinstance(providers_raw, dict):
        # El CLI corrio (exit 0, JSON valido) pero con una forma que este script no reconoce.
        # Igual que con un CLI que no responde: se publica un reporte de falla por cada
        # proveedor conocido (el mismo CAUCE_QUOTA_PROVIDERS que usa collect_raw, no la
        # constante fija) en vez de abortar sin decir nada.
        log("la salida no tiene 'providers' (objeto); se trata como falla total")
        providers_raw = {
            name: {'ok': False, 'available': False, 'note': "ai-usage no devolvio 'providers'"}
            for name in fallback_providers
        }

    providers = []
    for raw_name, raw_provider in providers_raw.items():
        name = sanitize_provider(raw_name)
        if not isinstance(raw_provider, dict):
            providers.append(failed_provider_entry(
                name, f'entrada de proveedor invalida (no es un objeto): {type(raw_provider).__name__}', captured_at))
            continue
        try:
            providers.append(normalize_provider(name, raw_provider, bindings, captured_at))
        except Exception as exc:  # nunca dejamos que UN proveedor tumbe la publicacion del resto
            log(f"proveedor '{name}' no se pudo normalizar, se reporta como fallido: {exc}")
            providers.append(failed_provider_entry(name, f'error normalizando: {exc}', captured_at))

    schema_version = resolve_schema_version(raw if isinstance(raw, dict) else {})
    app_version = trim(pick(raw if isinstance(raw, dict) else {}, 'appVersion', 'app_version', 'version'), 64)

    return {
        'host': host,
        'captured_at': captured_at,
        'schema_version': schema_version,
        'app_version': app_version,
        'providers': providers,
    }


# ------------------------------------------------------------------------------------------
# Publicacion mTLS.
# ------------------------------------------------------------------------------------------

def build_ssl_context(pki_dir: str) -> ssl.SSLContext:
    cert = os.path.join(pki_dir, 'client.crt')
    key = os.path.join(pki_dir, 'client.key')
    ca = os.path.join(pki_dir, 'ca.crt')
    for label, path in (('client.crt', cert), ('client.key', key), ('ca.crt', ca)):
        if not os.path.isfile(path):
            # Se informa la AUSENCIA del archivo (no es secreta); jamas su contenido.
            raise QuotaCollectionError(f'falta {label} en {pki_dir}')
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    try:
        ctx.load_verify_locations(cafile=ca)
        ctx.load_cert_chain(certfile=cert, keyfile=key)
    except ssl.SSLError as exc:
        # Un PEM corrupto/truncado es un error de CONFIGURACION (exit 2), no de red: no tiene
        # sentido reintentar. El mensaje de OpenSSL nunca incluye el contenido del archivo, solo
        # una razon de parseo ('PEM lib', 'no start line', etc), asi que es seguro loguearlo.
        raise QuotaCollectionError(f'PKI invalida en {pki_dir}: {exc}') from exc
    ctx.verify_mode = ssl.CERT_REQUIRED
    # La verificacion de nombre queda SIEMPRE prendida (nunca se apaga check_hostname): se
    # conecta por IP de tailnet (100.64.0.6), y Python valida IP literales contra SANs de tipo
    # IP igual que contra nombres DNS. Mismo patron que ya usa ops/pty-agent/cauce_pty_agent.py
    # (_tls_context/_connect): si algun dia el cert del gateway no trajera esa IP como SAN, el
    # escape hatch es CAUCE_QUOTA_GATEWAY_SERVER_NAME (ver PinnedHTTPSConnection), no apagar la
    # verificacion.
    ctx.check_hostname = True
    # Detalle real que ya costo tiempo: la CA interna de Cauce no trae Extended Key Usage: sin
    # este parche, un Python con VERIFY_X509_STRICT (nuevo, algunas builds de 3.13) rechaza un
    # certificado de cadena valida aunque la cadena en si sea correcta. hasattr por si corre en
    # una version que ni siquiera define la flag.
    if hasattr(ssl, 'VERIFY_X509_STRICT'):
        ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
    return ctx


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """http.client conecta y verifica el certificado contra el MISMO string por default; este
    recolector conecta por IP (100.64.0.6, tailnet) y quiere poder verificar contra un
    server_hostname distinto si algun dia hace falta (cert del gateway sin SAN de IP). Es el
    mismo desacople que ya resuelve ops/pty-agent con RELAY_SERVER_NAME, aca aplicado a una
    conexion HTTP en vez de al socket crudo del relay PTY."""

    def __init__(self, host: str, port: int, context: ssl.SSLContext, server_hostname: str, timeout: float):
        super().__init__(host, port, timeout=timeout, context=context)
        self._pinned_server_hostname = server_hostname

    def connect(self) -> None:
        sock = socket.create_connection((self.host, self.port), self.timeout, self.source_address)
        self.sock = self._context.wrap_socket(sock, server_hostname=self._pinned_server_hostname)


def summarize_response(raw_body: str) -> None:
    """Todo lo que devuelve la ruta es informacion de servidor pensada para logs (collection_id,
    contadores, flags de pausa) -- no hay nada secreto aca, a diferencia de lo que el script lee
    de disco (certificados) o del CLI (stdout crudo, potencialmente ruidoso)."""
    try:
        data = json.loads(raw_body)
    except json.JSONDecodeError:
        log(f'respuesta no-JSON: {trim(raw_body, 300)}')
        return
    if not isinstance(data, dict):
        return
    parts = [
        f"collection_id={data.get('collection_id')}",
        f"duplicate={data.get('duplicate')}",
        f"accepted_providers={data.get('accepted_providers')}",
        f"accepted_windows={data.get('accepted_windows')}",
    ]
    for key in ('unbound_groups', 'paused_accounts', 'resumed_accounts'):
        value = data.get(key)
        if isinstance(value, list) and value:
            parts.append(f'{key}={len(value)}')
    log(' '.join(parts))


def post_samples(
    url: str, payload: dict, pki_dir: str, server_hostname_override: str | None,
    timeout: int, retries: int, retry_delay: int,
) -> int:
    parts = urlsplit(url)
    if parts.scheme != 'https' or not parts.hostname:
        # mTLS no tiene sentido sobre http, y sin un host que resolver no hay a donde conectar:
        # esto es un error de configuracion, no de red (no vale la pena reintentar).
        raise QuotaCollectionError(f"CAUCE_QUOTA_GATEWAY_URL invalida (se esperaba https://host:puerto/...): '{url}'")
    host = parts.hostname
    port = parts.port or 443
    path = parts.path or '/'
    if parts.query:
        path = f'{path}?{parts.query}'
    server_hostname = server_hostname_override or host

    ctx = build_ssl_context(pki_dir)
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    headers = {'Content-Type': 'application/json', 'Content-Length': str(len(body))}
    attempts = max(1, retries + 1)
    last_error: str | None = None

    for attempt in range(1, attempts + 1):
        conn = PinnedHTTPSConnection(host, port, ctx, server_hostname, timeout)
        try:
            conn.request('POST', path, body=body, headers=headers)
            response = conn.getresponse()
            status = response.status
            resp_body = response.read().decode('utf-8', errors='replace')
            log(f'POST {url} -> {status}')
            if 200 <= status < 300:
                summarize_response(resp_body)
                return 0
            log(f'respuesta {status}: {trim(resp_body, 500)}')
            if status in (400, 401, 403, 404, 409, 422):
                # Error del CLIENTE (config, permisos, esquema): reintentar no cambia nada.
                return 1
            last_error = f'HTTP {status}'
        except (OSError, ssl.SSLError, http.client.HTTPException) as exc:
            last_error = str(exc)
            log(f'intento {attempt}/{attempts} fallo de red/TLS: {last_error}')
        finally:
            conn.close()
        if attempt < attempts:
            time.sleep(retry_delay)

    log(f'no se pudo publicar tras {attempts} intento(s): {last_error}')
    return 1


# ------------------------------------------------------------------------------------------
# CLI.
# ------------------------------------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Recolector de cuotas de IA: muestrea ai-usage y publica en POST /v3/quotas/samples.')
    parser.add_argument('--dry-run', action='store_true', help='arma el payload y lo imprime por stdout; no publica')
    parser.add_argument('--input-file', help='lee el JSON crudo de un archivo en vez de invocar ai-usage (debug/tests)')
    parser.add_argument('--gateway-url', help='override de CAUCE_QUOTA_GATEWAY_URL')
    parser.add_argument('--gateway-server-name', help='override de CAUCE_QUOTA_GATEWAY_SERVER_NAME')
    parser.add_argument('--pki-dir', help='override de CAUCE_QUOTA_PKI_DIR')
    parser.add_argument('--host', help='override de CAUCE_QUOTA_HOST')
    parser.add_argument('--account-bindings-file', help='override de CAUCE_QUOTA_ACCOUNT_BINDINGS_FILE')
    return parser.parse_args(argv)


def load_config(args: argparse.Namespace) -> dict[str, Any]:
    home = os.path.expanduser('~')
    providers_csv = env('CAUCE_QUOTA_PROVIDERS', ','.join(DEFAULT_PROVIDERS)) or ''
    return {
        'gateway_url': args.gateway_url or env('CAUCE_QUOTA_GATEWAY_URL', DEFAULT_GATEWAY_URL),
        'gateway_server_name': args.gateway_server_name or env('CAUCE_QUOTA_GATEWAY_SERVER_NAME'),
        'pki_dir': args.pki_dir or env('CAUCE_QUOTA_PKI_DIR', os.path.join(home, '.config', 'cauce-v3', 'container-pki', 'quota-collector')),
        'host': sanitize_host(args.host or env('CAUCE_QUOTA_HOST', socket.gethostname())),
        'ai_usage_cmd': shlex.split(env('CAUCE_QUOTA_AI_USAGE_CMD', DEFAULT_AI_USAGE_CMD) or DEFAULT_AI_USAGE_CMD),
        'ai_usage_timeout': int(env('CAUCE_QUOTA_AI_USAGE_TIMEOUT_SECONDS', '45')),
        'fallback_providers': [p.strip() for p in providers_csv.split(',') if p.strip()] or DEFAULT_PROVIDERS,
        'account_bindings_file': args.account_bindings_file or env(
            'CAUCE_QUOTA_ACCOUNT_BINDINGS_FILE', os.path.join(home, '.config', 'cauce-v3', 'quota-collector', 'account-bindings.json')),
        'http_timeout': int(env('CAUCE_QUOTA_HTTP_TIMEOUT_SECONDS', '20')),
        'http_retries': int(env('CAUCE_QUOTA_HTTP_RETRIES', '2')),
        'http_retry_delay': int(env('CAUCE_QUOTA_HTTP_RETRY_DELAY_SECONDS', '3')),
        'input_file': args.input_file or env('CAUCE_QUOTA_INPUT_FILE'),
        'dry_run': bool(args.dry_run or env('CAUCE_QUOTA_DRY_RUN') == '1'),
    }


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    cfg = load_config(args)
    captured_at = iso_now()
    bindings = AccountBindings(cfg['account_bindings_file'])

    if cfg['input_file']:
        try:
            raw = json.loads(pathlib.Path(cfg['input_file']).read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError) as exc:
            log(f"no se pudo leer --input-file '{cfg['input_file']}': {exc}")
            return 2
    else:
        raw = collect_raw(cfg['ai_usage_cmd'], cfg['ai_usage_timeout'], cfg['fallback_providers'])

    payload = build_payload(raw, cfg['host'], captured_at, bindings, cfg['fallback_providers'])

    if not payload['providers']:
        # Caso degenerado (ai-usage corrio pero no informo ningun proveedor). Se publica igual:
        # collectors[] mide frescura contra received_at, y "corrio pero no vio nada" es distinto
        # de "no corrio", asi que igual conviene que quede una fila.
        log('advertencia: la corrida no produjo ningun proveedor; se publica de todos modos')

    if cfg['dry_run']:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0

    return post_samples(
        cfg['gateway_url'], payload, cfg['pki_dir'], cfg['gateway_server_name'],
        cfg['http_timeout'], cfg['http_retries'], cfg['http_retry_delay'],
    )


if __name__ == '__main__':
    try:
        sys.exit(main())
    except QuotaCollectionError as exc:
        log(f'error de configuracion: {exc}')
        sys.exit(2)
    except KeyboardInterrupt:
        sys.exit(130)
