#!/usr/local/bin/python3
import json
import os
import pathlib
import re
import signal
import sys
import tty
import uuid

IDENTITY = "fixture-owner@example.invalid"
SESSION = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
arguments = sys.argv[1:]


def emit(value):
    print(json.dumps(value), flush=True)


if "--version" in arguments:
    print("2.1.0 (Claude Code)")
    sys.exit(0)
if arguments[:2] == ["auth", "status"]:
    emit({"loggedIn": True, "email": IDENTITY, "authMethod": "claude.ai"})
    sys.exit(0)

headless = "--print" in arguments or "-p" in arguments
prompt = ""
if "-p" in arguments and arguments.index("-p") + 1 < len(arguments) and not arguments[arguments.index("-p") + 1].startswith("-"):
    prompt = arguments[arguments.index("-p") + 1]
elif headless and not sys.stdin.isatty():
    prompt = sys.stdin.read()
bootstrap = re.search(r"CAUCE_BOOTSTRAP_[a-f0-9]{64}", prompt) if headless else None
if bootstrap:
    emit({"type": "result", "subtype": "success", "is_error": False, "result": bootstrap.group(0),
          "session_id": str(uuid.uuid4())})
    sys.exit(0)


def option(name):
    if name not in arguments or arguments.index(name) + 1 >= len(arguments):
        return None
    value = arguments[arguments.index(name) + 1]
    if SESSION.fullmatch(value) is None:
        sys.exit(4)
    return value


config = pathlib.Path(os.environ["CLAUDE_CONFIG_DIR"])
config.mkdir(parents=True, exist_ok=True, mode=0o700)
resumed = option("--resume")
native = resumed or option("--session-id") or str(uuid.uuid4())
projects = config / "projects" / re.sub(r"[/.]", "-", os.getcwd().rstrip("/"))
projects.mkdir(parents=True, exist_ok=True, mode=0o700)
transcript = projects / (native + ".jsonl")
memory = config / ("memory-" + native + ".json")
if resumed and not transcript.exists():
    sys.exit(5)
if resumed and (config / "h6d-fail-resume").exists():
    sys.exit(42)
with (config / "h6d-invocations.jsonl").open("a") as stream:
    stream.write(json.dumps({"pid": os.getpid(), "native_id": native, "resumed": resumed is not None,
                             "mode": "exec" if headless else "tui", "cwd": os.getcwd()}) + "\n")
    stream.flush()
    os.fsync(stream.fileno())


def append(value):
    descriptor = os.open(transcript, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(descriptor, "a") as stream:
        stream.write(json.dumps(value) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def answer(text):
    turn = str(uuid.uuid4())
    append({"type": "user", "uuid": turn, "parentUuid": None, "isSidechain": False, "promptSource": "typed",
            "sessionId": native, "cwd": os.getcwd(), "message": {"role": "user", "content": text}})
    remembered = re.search(r"REMEMBER ([A-Za-z0-9-]+)", text)
    if remembered:
        memory.write_text(json.dumps({"datum": remembered.group(1)}))
        response = "STORED:" + remembered.group(1)
    elif "RECALL" in text:
        response = "RECALLED:" + json.loads(memory.read_text())["datum"] if memory.exists() else "MEMORY-ABSENT"
    else:
        response = "ACK"
    correlation = re.search(r'"cauce_correlation_id":"([a-f0-9]{64})"', text)
    if correlation:
        response = json.dumps({"reply": response, "messages": [], "status": "done", "retryable": False,
                               "artifacts": [], "cauce_correlation_id": correlation.group(1)})
    append({"type": "assistant", "uuid": str(uuid.uuid4()), "parentUuid": turn, "isSidechain": False, "sessionId": native,
            "cwd": os.getcwd(), "message": {"role": "assistant", "stop_reason": "end_turn",
                                            "content": [{"type": "text", "text": response}]}})
    return response


if headless:
    emit({"type": "result", "subtype": "success", "is_error": False, "result": answer(prompt), "session_id": native})
    sys.exit(0)

signal.signal(signal.SIGINT, lambda *_: sys.exit(130))
tty.setraw(sys.stdin.fileno())
sys.stdout.write("\x1b[?2004h")
sys.stdout.flush()
pending = ""
pasting = False


def render_idle():
    sys.stdout.write("\r\n❯ \x1b[2mTry \"refactor this file\"\x1b[22m\r\x1b[2C")
    sys.stdout.flush()


render_idle()
while True:
    chunk = os.read(sys.stdin.fileno(), 4096).decode(errors="replace")
    if not chunk:
        break
    if not pending:
        sys.stdout.write("\r\x1b[2K❯ ")
        sys.stdout.flush()
    pending += chunk
    if "\x1b[200~" in pending:
        pasting = True
    if "\x1b[201~" in pending:
        pasting = False
    sys.stdout.write(chunk.replace("\x1b[200~", "").replace("\x1b[201~", "").replace("\n", "\r\n"))
    sys.stdout.flush()
    if pasting or not pending.endswith(("\r", "\n")):
        continue
    pasted = re.search(r"\x1b\[200~(.*)\x1b\[201~", pending, re.S)
    text = (pasted.group(1) if pasted else pending.rstrip("\r\n")).replace("\r", "\n")
    pending = ""
    sys.stdout.write("\r\n" + answer(text) + "\r\n")
    sys.stdout.flush()
    render_idle()
