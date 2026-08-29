#!/usr/bin/env python3
"""
AI quota collector for Cauce V3.

Why it exists: the local CLI 'ai-usage' is the only one that knows the consumption of the
subscriptions (claude/codex/antigravity/opencode) (same data the get_ai_quotas MCP tool exposes),
and it lives in kratos and the agent containers, NEVER in agora-storage where the gateway and
the console run. Without a collector that samples it and pushes it over HTTP, the quotas panel
has nothing to read from, and the incident that motivated this work (an agent with 71 in-flight
deliveries that exhausted a paid subscription without anyone noticing) repeats silently.

What it does, in order:
  1. Invokes 'ai-usage --json' (or the command CAUCE_QUOTA_AI_USAGE_CMD points to) and parses
     its output, which carries the shape providers.<name>.windows[] described in the runbook.
  2. Normalizes every window to (host, provider, group_key, window_key): group_key =
     window.limitId (or the equivalent) or 'default', window_key = window.key. Flattening
     this into one number per provider is the very mistake that makes a panel show balance
     in an account that has none (today: codex at 100% and codex_bengalfox at 0%).
  3. Resolves, via a local intent file (CAUCE_QUOTA_ACCOUNT_BINDINGS_FILE), which Cauce
     account_id corresponds to each (provider, group_key). The gateway NEVER guesses this on
     its own: the collector is the only component that sees both the CLI's real session and
     the operator's intent.
  4. Publishes POST /v3/quotas/samples over mTLS (dedicated identity, operator role + control
     permission). The route lives outside /v3/console/ on purpose: that prefix demands a
     same-origin Origin header a daemon never sends.

Robustness principle, requested explicitly: if ONE provider does not respond (or the whole CLI
does not run), publish what did respond and report the failing one as ok=false, instead of
publishing nothing. The only reason not to publish at all is a local CONFIGURATION error
(invalid host, missing PKI): that is a deployment bug, not a data bug, and deserves to stop
rather than send garbage.

Credential contents are never logged: the script only passes certificate PATHs to the ssl
library, never reads or prints them. The only free-form texts it sends to stderr are
subprocess/HTTP error messages, which in the worst case carry a bounded fragment of the CLI's
stderr (never its full stdout, in case some provider dumps a token there).

Usage:
  quota-collector.py [--dry-run] [--input-file PATH] [--gateway-url URL] [--pki-dir DIR]
                      [--host HOST] [--account-bindings-file PATH]

Environment variables (see ops/config/quota-collector.env.example):
  CAUCE_QUOTA_GATEWAY_URL              default https://100.64.0.6:8443/v3/quotas/samples
  CAUCE_QUOTA_GATEWAY_SERVER_NAME      optional: name to verify against the gateway's cert if
                                        it does NOT carry the IP from CAUCE_QUOTA_GATEWAY_URL
                                        as a SAN (same escape hatch as RELAY_SERVER_NAME in
                                        ops/pty-agent). Without this, it is verified against
                                        the URL's IP/host, with check_hostname ALWAYS on.
  CAUCE_QUOTA_PKI_DIR                  default ~/.config/cauce-v3/container-pki/quota-collector
  CAUCE_QUOTA_HOST                     default hostname() of the machine
  CAUCE_QUOTA_AI_USAGE_CMD             default "ai-usage --json"
  CAUCE_QUOTA_AI_USAGE_TIMEOUT_SECONDS default 45
  CAUCE_QUOTA_PROVIDERS                default "claude,codex,antigravity,opencode" (fallback
                                        when the whole CLI does not respond: an ok=false report
                                        is published per provider instead of staying silent)
  CAUCE_QUOTA_ACCOUNT_BINDINGS_FILE    default ~/.config/cauce-v3/quota-collector/account-bindings.json
  CAUCE_QUOTA_HTTP_TIMEOUT_SECONDS     default 20
  CAUCE_QUOTA_HTTP_RETRIES             default 2 (extra retries on network failures; NOT on 4xx)
  CAUCE_QUOTA_HTTP_RETRY_DELAY_SECONDS default 3
  CAUCE_QUOTA_INPUT_FILE               debug/tests only: read the raw JSON from a file instead
                                        of invoking ai-usage
  CAUCE_QUOTA_DRY_RUN=1                build the payload and print it to stdout; do not publish

Output (exit code):
  0  published successfully (includes the "a total-failure report was published" case: the POST
     itself worked, what failed was the data source, and that IS useful information for the panel)
  1  network/HTTP failure against the gateway after exhausting retries
  2  local configuration error (invalid host, missing PKI, unreadable --input-file): nothing
     was attempted for publishing
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

# Version of the get_ai_quotas SHAPE the mapping below is written against (today: 2, see the
# CONTEXTO of the request). If the tool does not report its own schemaVersion, this one is
# declared, because it is the only one the script knows how to interpret; if it reports one
# and it differs, it is published anyway and the GATEWAY is the one that has to reject an
# unknown major with 422 (not this script: it has no visibility into what exactly changed).
COLLECTOR_SCHEMA_VERSION = 2

DEFAULT_GATEWAY_URL = 'https://100.64.0.6:8443/v3/quotas/samples'
DEFAULT_AI_USAGE_CMD = 'ai-usage --json'
DEFAULT_PROVIDERS = ['claude', 'codex', 'antigravity', 'opencode']

HOST_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$')
PROVIDER_RE = re.compile(r'^[a-z][a-z0-9_.-]{0,63}$')
KEY_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')
STATUS_RE = re.compile(r'^[a-z][a-z0-9_-]{0,31}$')


class QuotaCollectionError(RuntimeError):
    """Configuration or data error that warrants stopping BEFORE attempting to publish anything.
    Intentionally distinguished from a network failure (see post_samples): this is a local
    deployment bug, not a transient gateway failure, so retrying does not help."""


def log(message: str) -> None:
    print(f'[quota-collector] {message}', file=sys.stderr)


def env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    return value if value not in (None, '') else default


def iso_now() -> str:
    dt = datetime.now(timezone.utc)
    return dt.strftime('%Y-%m-%dT%H:%M:%S.') + f'{dt.microsecond // 1000:03d}Z'


def trim(value: Any, max_len: int) -> str | None:
    """Trims to max_len and drops empty strings: several columns from 013 require a length
    BETWEEN 1 and N, and an empty '' would pass the Python check but break the Postgres CHECK."""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if len(text) > max_len:
        text = text[: max_len - 1].rstrip() + '…'
    return text


def to_number(value: Any) -> float | None:
    """For numeric(5,2) columns bounded to [0,100]. A SMALL overflow (100.004 from internal
    provider rounding) is clamped: dropping the whole row for that makes no sense. A LARGE
    overflow (-50, 9999) is NOT clamped to 0/100 -- it is treated as missing data. Clamping
    there would invert the diagnosis: a -50 read as '0% used' looks healthy, and that is
    exactly what this panel exists to keep from slipping through."""
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
    """group_key/window_key must match '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' (CHECK from 013).
    A raw value that does not match is NOT dropped -- it is sanitized, because losing a whole
    window over an odd character is worse than storing it under a slightly different key."""
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
        # A valid host is not invented on the fly: better stop here than send a sample that the
        # quota_collections CHECK would reject anyway, but only after invoking the CLIs.
        raise QuotaCollectionError(f"host invalido para quota_collections.host: '{text}'")
    return text


def pick(d: dict, *keys: str, default: Any = None) -> Any:
    """Source CLIs mix camelCase (ai-usage) and potentially snake_case if someone normalizes
    beforehand; both spellings are tried instead of assuming one."""
    for key in keys:
        if key in d and d[key] is not None:
            return d[key]
    return default


# ------------------------------------------------------------------------------------------
# Bindings: (provider, group_key) -> account_id from provider_accounts.
# ------------------------------------------------------------------------------------------

class AccountBindings:
    """The intent file the operator maintains. Without it (or without an entry for a given
    group) the window is still published, with account_id=NULL and a binding_note: losing the
    data because it is not yet bound to an account is exactly the mistake that cost the
    original incident (the new group no one saw)."""

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
# Invocation of the ai-usage CLI.
# ------------------------------------------------------------------------------------------

def resolve_binary(cmd: list[str]) -> list[str]:
    """ai-usage lives in ~/.local/bin alongside the agent containers; in kratos it may not
    be on the PATH of a systemd unit (which starts with a minimal PATH). PATH is tried first,
    then ~/.local/bin -- subprocess yields a clear error if it is still not found."""
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
        # Only a bounded fragment of stderr, and NEVER the full stdout: if any provider dumps
        # a session token in an error message, that text must not end up in our log.
        raise QuotaCollectionError(f'{resolved[0]} salio con status {result.returncode}: {trim(result.stderr, 300)}')
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise QuotaCollectionError(f'salida de {resolved[0]} no es JSON valido: {exc}') from exc


def collect_raw(cmd: list[str], timeout: int, fallback_providers: list[str]) -> dict[str, Any]:
    """Fault-tolerant entry point: if the whole CLI does not run, a synthetic raw JSON is
    built with every known provider marked ok=false, treated by the rest of the pipeline
    exactly like 'one provider did not respond' and PUBLISHED -- publishing nothing is
    indistinguishable from 'the collector did not run' and hides the problem."""
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
# Normalization: raw JSON from ai-usage -> payload of POST /v3/quotas/samples.
# ------------------------------------------------------------------------------------------

def normalize_window(raw_window: dict) -> dict:
    window_key = sanitize_key(pick(raw_window, 'key', 'window_key'), 'window')
    used_percent = to_number(pick(raw_window, 'usedPercent', 'used_percent'))
    remaining_percent = to_number(pick(raw_window, 'remainingPercent', 'remaining_percent'))
    used_units = to_units(pick(raw_window, 'usedUnits', 'used_units'), 0)
    if used_percent is None and remaining_percent is None and used_units is None:
        # Mirrors CHECK quota_window_samples_has_a_number: discard here, with a reason.
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
        # Mandatory normalization (contract): group_key = limitId or 'default'. It is the
        # only thing that separates 'codex' (exhausted) from 'codex_bengalfox' (free) within
        # the same provider -- flattening it would show balance in the very account with none.
        group_key = sanitize_key(pick(raw_window, 'limitId', 'limit_id', default='default'), 'default')
        groups.setdefault(group_key, []).append(window)

    # One row per window: the schema carries group_key/account_id/binding_note per window.
    flat_windows = []
    for group_key, windows in groups.items():
        account_id, binding_note = bindings.resolve(name, group_key)
        for window in windows:
            flat_windows.append({
                **window,
                'group_key': group_key,
                'account_id': account_id,
                'binding_note': binding_note,
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
        'windows': flat_windows,
    }


def failed_provider_entry(name: str, reason: str, captured_at: str) -> dict:
    return {
        'provider': name, 'ok': False, 'available': False,
        'kind': None, 'source': None, 'plan': None,
        'note': trim(reason, 512),
        'effective_remaining_percent': None, 'observed_at': captured_at,
        'available_groups': [], 'limiting_groups': [], 'windows': [],
    }


def resolve_schema_version(raw: dict) -> int:
    reported = to_int(pick(raw, 'schemaVersion', 'schema_version'))
    if reported is None or not (1 <= reported <= 999):
        if reported is not None:
            log(f'schemaVersion reportado ({reported}) fuera de rango; se ignora')
        return COLLECTOR_SCHEMA_VERSION
    if reported != COLLECTOR_SCHEMA_VERSION:
        # This is not a collector error: the gateway is the one that has to decide whether it
        # is an unknown major (422) or a compatible minor revision. This script only warns.
        log(f'schemaVersion reportado ({reported}) distinto del esperado ({COLLECTOR_SCHEMA_VERSION}); se publica igual')
    return reported


def build_payload(
    raw: Any, host: str, captured_at: str, bindings: AccountBindings, fallback_providers: list[str],
) -> dict:
    providers_raw = raw.get('providers') if isinstance(raw, dict) else None
    if not isinstance(providers_raw, dict):
        # The CLI ran (exit 0, valid JSON) but with a shape this script does not recognize.
        # Same as when a CLI does not respond: a failure report is published for each known
        # provider (the same CAUCE_QUOTA_PROVIDERS collect_raw uses, not a hardcoded constant)
        # instead of aborting without saying anything.
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
        except Exception as exc:  # one provider never brings down the rest of the publish
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
# mTLS publication.
# ------------------------------------------------------------------------------------------

def build_ssl_context(pki_dir: str) -> ssl.SSLContext:
    cert = os.path.join(pki_dir, 'client.crt')
    key = os.path.join(pki_dir, 'client.key')
    ca = os.path.join(pki_dir, 'ca.crt')
    for label, path in (('client.crt', cert), ('client.key', key), ('ca.crt', ca)):
        if not os.path.isfile(path):
            # The ABSENCE of the file is reported (it is not secret); never its contents.
            raise QuotaCollectionError(f'falta {label} en {pki_dir}')
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    try:
        ctx.load_verify_locations(cafile=ca)
        ctx.load_cert_chain(certfile=cert, keyfile=key)
    except ssl.SSLError as exc:
        # A corrupted/truncated PEM is a CONFIGURATION error (exit 2), not a network one:
        # retrying is pointless. The OpenSSL message never includes the file contents, only a
        # parse reason ('PEM lib', 'no start line', etc), so it is safe to log.
        raise QuotaCollectionError(f'PKI invalida en {pki_dir}: {exc}') from exc
    ctx.verify_mode = ssl.CERT_REQUIRED
    # Name verification stays ALWAYS on (check_hostname is never turned off): the connection
    # is by tailnet IP (100.64.0.6), and Python validates literal IPs against IP-type SANs the
    # same way it validates DNS names. Same pattern already used by
    # ops/pty-agent/cauce_pty_agent.py (_tls_context/_connect): if the gateway's cert ever
    # stopped carrying that IP as a SAN, the escape hatch is CAUCE_QUOTA_GATEWAY_SERVER_NAME
    # (see PinnedHTTPSConnection), not turning verification off.
    ctx.check_hostname = True
    # Real detail that has already cost time: the Cauce internal CA does not carry Extended
    # Key Usage: without this patch, a Python with VERIFY_X509_STRICT (new, some 3.13 builds)
    # rejects a valid-chain certificate even when the chain itself is correct. hasattr in case
    # it runs on a version that does not even define the flag.
    if hasattr(ssl, 'VERIFY_X509_STRICT'):
        ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
    return ctx


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """http.client connects and verifies the certificate against the SAME string by default;
    this collector connects by IP (100.64.0.6, tailnet) and wants to be able to verify against
    a different server_hostname if ever needed (gateway cert without an IP SAN). It is the
    same decoupling ops/pty-agent already solves with RELAY_SERVER_NAME, here applied to an
    HTTP connection instead of the raw socket of the PTY relay."""

    def __init__(self, host: str, port: int, context: ssl.SSLContext, server_hostname: str, timeout: float):
        super().__init__(host, port, timeout=timeout, context=context)
        self._pinned_server_hostname = server_hostname

    def connect(self) -> None:
        sock = socket.create_connection((self.host, self.port), self.timeout, self.source_address)
        self.sock = self._context.wrap_socket(sock, server_hostname=self._pinned_server_hostname)


def summarize_response(raw_body: str) -> None:
    """Everything the route returns is server-side information meant for logs (collection_id,
    counters, pause flags) -- nothing secret here, unlike what the script reads from disk
    (certificates) or from the CLI (raw stdout, potentially noisy)."""
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
        # mTLS makes no sense over http, and without a host to resolve there is nowhere to
        # connect: this is a configuration error, not a network one (retrying is pointless).
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
                # CLIENT error (config, permissions, schema): retrying changes nothing.
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
        # Degenerate case (ai-usage ran but reported no providers). Still published: collectors[]
        # measures freshness against received_at, and "ran but saw nothing" is different from
        # "did not run", so it is still worth leaving a row behind.
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
