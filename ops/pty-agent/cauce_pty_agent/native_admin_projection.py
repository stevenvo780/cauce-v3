from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urlsplit

import tomllib

from .native_admin_paths import ID, MAX_FILE_BYTES, NativeError


def descriptor(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or not set(value).issubset({"url", "bearer_token_env_var"}):
        raise NativeError("invalid_input")
    url = value.get("url")
    if not isinstance(url, str) or len(url) > 2048:
        raise NativeError("invalid_input")
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or any(ord(char) < 32 for char in url)):
        raise NativeError("invalid_input")
    reference = value.get("bearer_token_env_var")
    if reference is not None and (not isinstance(reference, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", reference)):
        raise NativeError("invalid_input")
    return dict(value)


def decode_config(harness: str, raw: bytes | None) -> dict[str, Any]:
    try:
        value = (tomllib.loads(raw.decode()) if harness == "codex" else json.loads(raw.decode())) if raw else {}
    except (ValueError, UnicodeError):
        raise NativeError("unsupported") from None
    if not isinstance(value, dict):
        raise NativeError("unsupported")
    return value


def servers(harness: str, raw: bytes | None) -> dict[str, Any]:
    value = decode_config(harness, raw).get("mcp_servers" if harness == "codex" else "mcpServers", {})
    if not isinstance(value, dict):
        raise NativeError("unsupported")
    return value


def public_server(harness: str, value: Any) -> dict[str, Any] | None:
    try:
        if harness == "codex":
            return descriptor(value)
        if not isinstance(value, dict) or not set(value).issubset({"type", "url", "headers"}) or value.get("type") != "http":
            return None
        result = {"url": value.get("url")}
        headers = value.get("headers", {})
        if headers:
            if not isinstance(headers, dict) or set(headers) != {"Authorization"}:
                return None
            match = re.fullmatch(r"Bearer \$\{([A-Z][A-Z0-9_]{0,127})\}", str(headers["Authorization"]))
            if not match:
                return None
            result["bearer_token_env_var"] = match[1]
        return descriptor(result)
    except (NativeError, ValueError):
        return None


def project_mcp(harness: str, raw: bytes | None, identifier: str, value: dict[str, str] | None) -> bytes:
    config = decode_config(harness, raw)
    key = "mcp_servers" if harness == "codex" else "mcpServers"
    entries = servers(harness, raw)
    if identifier in entries and public_server(harness, entries[identifier]) is None:
        raise NativeError("unsupported")
    native: dict[str, Any] | None = value
    if harness == "claude" and value is not None:
        native = {"type": "http", "url": value["url"]}
        if "bearer_token_env_var" in value:
            native["headers"] = {"Authorization": "Bearer ${" + value["bearer_token_env_var"] + "}"}
    expected = {**config, key: dict(entries)}
    if native is None:
        expected[key].pop(identifier, None)
    else:
        expected[key][identifier] = native
    if harness == "claude":
        result = (json.dumps(expected, ensure_ascii=False, indent=2) + "\n").encode()
    else:
        source = raw.decode() if raw else ""
        pattern = re.compile(r"(?m)^\[([^\]\n]+)\][ \t]*(?:#.*)?$")
        sections = list(pattern.finditer(source))
        spans = []
        for index, match in enumerate(sections):
            if match.group(1) == "mcp_servers." + identifier:
                spans.append((match.start(), sections[index + 1].start() if index + 1 < len(sections) else len(source)))
        if identifier in entries and len(spans) != 1:
            raise NativeError("unsupported")
        for start, end in reversed(spans):
            source = source[:start] + source[end:]
        if native is not None:
            source += "\n[mcp_servers." + identifier + "]\n"
            source += "".join(name + " = " + json.dumps(field) + "\n" for name, field in native.items())
        result = source.encode()
        parsed = decode_config(harness, result)
        if not parsed.get(key):
            parsed.pop(key, None)
        if not expected.get(key):
            expected.pop(key, None)
        if parsed != expected:
            raise NativeError("unsupported")
    if len(result) > MAX_FILE_BYTES:
        raise NativeError("too_large")
    return result


def markdown(kind: str, identifier: str, value: Any) -> bytes:
    if not isinstance(value, dict) or set(value) != {"content"} or not isinstance(value["content"], str):
        raise NativeError("invalid_input")
    text = value["content"]
    raw = text.encode()
    if len(raw) > 16384 or any(ord(char) < 32 and char not in "\n\r\t" for char in text):
        raise NativeError("too_large")
    if not text.startswith("---\n") or "\n---\n" not in text[4:]:
        raise NativeError("invalid_input")
    header = text[4:].split("\n---\n", 1)[0]
    names = re.findall(r"(?m)^name:[ \t]*([a-z][a-z0-9_-]{0,63})[ \t]*$", header)
    description = re.findall(r"(?m)^description:[ \t]*(\S[^\n]*)$", header)
    if names != [identifier] or len(description) != 1:
        raise NativeError("invalid_input")
    if kind not in ("skill", "subagent") or not ID.fullmatch(identifier):
        raise NativeError("unsupported")
    return raw
