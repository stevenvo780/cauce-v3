#!/usr/bin/env python3
"""Telegram probes read only explicitly scoped tenant tokens and redact provider text."""
from __future__ import annotations

import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
import pathlib
import tempfile
import unittest
import urllib.parse
from unittest import mock

os.environ.setdefault("CAUCE_OWNER_TELEGRAM_CHAT_ID", "1000000001")

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "guardias" / "cauce-v3-medico-monitor"
_loader = importlib.machinery.SourceFileLoader("medico_monitor_tokens", str(SCRIPT))
_spec = importlib.util.spec_from_file_location("medico_monitor_tokens", SCRIPT, loader=_loader)
assert _spec and _spec.loader
MODULE = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(MODULE)


class _Response(io.BytesIO):
    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()


def _token(path: pathlib.Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8")


def _run(template: str, directory: pathlib.Path, stdin: str = "") -> tuple[str, list[str]]:
    seen: list[str] = []

    def urlopen(url: str, *_args: object, **_kwargs: object) -> _Response:
        token = urllib.parse.urlparse(url).path.split("/")[1][len("bot"):]
        seen.append(token)
        return _Response(json.dumps({"result": {"pending_update_count": len(token),
                                               "last_error_message": "foreign-private-canary"}}).encode())

    out = io.StringIO()
    template = template.replace("SCOPED_IDENTITIES_JSON", repr(json.dumps([
        ["Steven", "zeus"], ["Miguel", "janus"], ["Steven", "atlas"],
    ]))).replace("SCOPED_NOTICE_JSON", repr(json.dumps(["Steven", "zeus"])))
    code = compile(template.replace(MODULE.TOKEN_DIR, str(directory)), "template", "exec")
    with mock.patch("urllib.request.urlopen", side_effect=urlopen), mock.patch("sys.stdin", io.StringIO(stdin)), \
            contextlib.redirect_stdout(out):
        exec(code, {})
    return out.getvalue(), seen


class TelegramTokenLayoutTests(unittest.TestCase):
    def setUp(self) -> None:
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.directory = pathlib.Path(scratch.name)

    def test_probe_reads_only_scoped_tenant_tokens_and_redacts_last_error(self) -> None:
        _token(self.directory / "zeus.token", "flat")
        _token(self.directory / "Steven" / "zeus.token", "tenant-layout")
        _token(self.directory / "atlas.token", "flat-only")
        _token(self.directory / "Miguel" / "janus.token", "tenant-only")
        _token(self.directory / "atlas.token.bak-old", "backup")
        _token(self.directory / "ForeignTenant" / "zeus.token", "foreign-token")
        out, seen = _run(MODULE.SONDA_TELEGRAM, self.directory)
        result = {(row["tenant"], row["alias"]): row["status"] for row in json.loads(out)}
        self.assertEqual(result[("Steven", "zeus")]["pendientes"], len("tenant-layout"))
        self.assertEqual(result[("Steven", "atlas")]["error"], "FileNotFoundError")
        self.assertEqual(sorted(seen), sorted(["tenant-layout", "tenant-only"]))
        self.assertNotIn("foreign", out)
        self.assertEqual(result[("Steven", "zeus")]["ultimo_error_chars"], len("foreign-private-canary"))

    def test_notice_uses_the_exact_tenant_and_rejects_flat_fallback(self) -> None:
        stdin = json.dumps({"texto": "aviso"})
        _token(self.directory / "zeus.token", "flat")
        with self.assertRaises(FileNotFoundError):
            _run(MODULE.PLANTILLA_AVISO, self.directory, stdin)
        _token(self.directory / "Steven" / f"{MODULE.ALIAS_AVISO}.token", "tenant-layout")
        out, seen = _run(MODULE.PLANTILLA_AVISO, self.directory, stdin)
        self.assertEqual((out.strip(), seen), ("enviado", ["tenant-layout"]))
        _token(self.directory / "Hospital" / f"{MODULE.ALIAS_AVISO}.token", "other-tenant")
        self.assertEqual(_run(MODULE.PLANTILLA_AVISO, self.directory, stdin)[1], ["tenant-layout"])


if __name__ == "__main__":
    unittest.main()
