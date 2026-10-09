#!/usr/bin/env python3
"""The doctor's Telegram probe and notice read <tenant>/<alias>.token and fall back to the flat layout."""
from __future__ import annotations

import contextlib
import importlib.machinery
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
import urllib.parse
from unittest import mock

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
        return _Response(json.dumps({"result": {"pending_update_count": len(token)}}).encode())

    out = io.StringIO()
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

    def test_probe_prefers_the_tenant_layout_and_counts_each_alias_once(self) -> None:
        _token(self.directory / "zeus.token", "flat")
        _token(self.directory / "Steven" / "zeus.token", "tenant-layout")
        _token(self.directory / "atlas.token", "flat-only")
        _token(self.directory / "Miguel" / "janus.token", "tenant-only")
        _token(self.directory / "atlas.token.bak-old", "backup")
        out, seen = _run(MODULE.SONDA_TELEGRAM, self.directory)
        result = json.loads(out)
        self.assertEqual(sorted(result), ["atlas", "janus", "zeus"])
        self.assertEqual(result["zeus"]["pendientes"], len("tenant-layout"))
        self.assertEqual(result["atlas"]["pendientes"], len("flat-only"))
        self.assertEqual(sorted(seen), sorted(["tenant-layout", "flat-only", "tenant-only"]))

    def test_notice_uses_the_tenant_token_then_the_flat_one(self) -> None:
        stdin = json.dumps({"texto": "aviso"})
        _token(self.directory / "zeus.token", "flat")
        self.assertEqual(_run(MODULE.PLANTILLA_AVISO, self.directory, stdin)[1], ["flat"])
        _token(self.directory / "Steven" / f"{MODULE.ALIAS_AVISO}.token", "tenant-layout")
        out, seen = _run(MODULE.PLANTILLA_AVISO, self.directory, stdin)
        self.assertEqual((out.strip(), seen), ("enviado", ["tenant-layout"]))
        _token(self.directory / "Hospital" / f"{MODULE.ALIAS_AVISO}.token", "other-tenant")
        with self.assertRaisesRegex(SystemExit, "ambiguo"):
            _run(MODULE.PLANTILLA_AVISO, self.directory, stdin)


if __name__ == "__main__":
    unittest.main()
