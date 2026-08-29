#!/usr/bin/env python3
"""Hermes one-shot stdin bridge. Prompt and native logs never reach argv/stdout."""

import asyncio
import contextlib
import inspect
import io
import json
import os
import pathlib
import re
import sys


MAX_INPUT_BYTES = 1024 * 1024
HTTP_ERROR = re.compile(r"^(?:error:\s*)?HTTP\s+\d{3}\b", re.IGNORECASE)


def read_prompt() -> str:
    payload = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(payload) > MAX_INPUT_BYTES:
        raise ValueError("input limit exceeded")
    prompt = payload.decode("utf-8", errors="strict")
    if not prompt:
        raise ValueError("empty input")
    return prompt


def decode_value(value):
    if not isinstance(value, str):
        return value
    stripped = value.strip()
    if not stripped:
        return None
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return stripped


def trailing_json(captured: str):
    """Decode a final JSON value, including pretty JSON after suppressed logs."""
    offsets = []
    offset = 0
    for line in captured.splitlines(keepends=True):
        offsets.append(offset)
        offset += len(line)
    if not offsets and captured:
        offsets.append(0)
    for offset in reversed(offsets):
        candidate = captured[offset:].strip()
        if not candidate or candidate[0] not in '{["-0123456789ntf':
            continue
        try:
            return True, json.loads(candidate)
        except json.JSONDecodeError:
            continue
    return False, None


def final_value(captured: str, returned):
    if isinstance(returned, int) and not isinstance(returned, bool):
        if returned != 0:
            raise RuntimeError("Hermes one-shot exited nonzero")
        returned = None

    stripped = captured.strip()
    if stripped:
        found, decoded = trailing_json(captured)
        if found:
            return decoded
    decoded_return = decode_value(returned)
    if decoded_return is not None:
        return decoded_return
    if stripped:
        final_line = stripped.splitlines()[-1].strip()
        if HTTP_ERROR.match(final_line):
            raise RuntimeError("Hermes one-shot returned an HTTP error without a response")
        return final_line
    raise ValueError("Hermes produced no final output")


def main() -> int:
    prompt = read_prompt()
    # Hermes contains legacy absolute imports (for example `from utils import ...`). The process
    # runs inside the agent's workspace, where an external `utils/` can silently shadow
    # the runtime module. The supervisor accredits an exact Git checkout and passes its non-secret
    # path; putting it first reproduces the resolution supported by the official CLI.
    source_value = os.environ.get("CAUCE_HERMES_SOURCE_DIR")
    runtime_value = os.environ.get("CAUCE_HERMES_RUNTIME_DIR")
    if (source_value is None) != (runtime_value is None):
        raise ValueError("incomplete Hermes runtime accreditation")
    if source_value and runtime_value:
        runtime_dir = pathlib.Path(runtime_value)
        source_dir = pathlib.Path(source_value)
        if (
            not runtime_dir.is_absolute()
            or runtime_dir.resolve() != runtime_dir
            or not source_dir.is_absolute()
            or source_dir.resolve() != source_dir
            or source_dir != runtime_dir / "source"
            or ".." in runtime_dir.parts
        ):
            raise ValueError("invalid Hermes source directory")
        for checked in (runtime_dir, source_dir):
            details = checked.stat(follow_symlinks=False)
            if not checked.is_dir() or details.st_uid != 0 or details.st_mode & 0o022:
                raise ValueError("untrusted Hermes runtime directory")
        sys.path.insert(0, str(source_dir))
    from hermes_cli.oneshot import run_oneshot

    # From the next line onward the turn MAY have effects. The marker is emitted here and not
    # earlier or later: earlier would lie (reading the prompt and importing hermes can still fail
    # without having touched anything), and later would leave a half-done turn indistinguishable
    # from one that never started — the expensive error: retrying already-paid work. It goes to
    # stderr because stdout is the structured contract. See HARNESS_START_MARKER in sdk/types.ts.
    sys.stderr.write("<<cauce:harness-started>>\n")
    sys.stderr.flush()

    capture = io.StringIO()
    with contextlib.redirect_stdout(capture):
        returned = run_oneshot(prompt)
        if inspect.isawaitable(returned):
            returned = asyncio.run(returned)

    envelope = {"result": final_value(capture.getvalue(), returned)}
    sys.stdout.write(json.dumps(envelope, ensure_ascii=False, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception:
        sys.stderr.write("hermes stdin bridge failed\n")
        raise SystemExit(1)
