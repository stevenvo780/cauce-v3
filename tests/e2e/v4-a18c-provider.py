#!/usr/local/bin/python3
import json
import os
import pathlib
import re
import sys
import tty
import uuid

IDENTITY = "host-setup@example.test"
CODE = "A18C-APPROVE"
home = pathlib.Path(os.environ.get("CODEX_HOME", "/tmp/a18c-unconfigured"))


def emit(value):
    print(json.dumps(value), flush=True)


if "--version" in sys.argv:
    print("a18c-owned-provider 1.0")
    sys.exit(0)

if "login" in sys.argv:
    print("A18C: enter " + CODE + " to approve this owned test account", flush=True)
    if sys.stdin.readline().strip() != CODE:
        sys.exit(3)
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    marker = home / "auth.json"
    marker.write_text(json.dumps({"email": IDENTITY}) + "\n")
    marker.chmod(0o600)
    print("A18C_LOGIN_APPROVED", flush=True)
    sys.exit(0)

if "app-server" in sys.argv:
    for line in sys.stdin:
        packet = json.loads(line)
        if "id" in packet:
            account = {"type": "chatgpt", "email": IDENTITY} if (home / "auth.json").is_file() else None
            result = {"account": account} if packet["method"] == "account/read" else {}
            emit({"id": packet["id"], "result": result})
    sys.exit(0)


def response(prompt):
    bootstrap = re.search(r"CAUCE_BOOTSTRAP_[a-f0-9]{64}", prompt)
    if bootstrap:
        return bootstrap.group(0)
    nonce = re.search(r"A18C_NONCE_[a-f0-9]{32}", prompt)
    correlation = re.search(r'"cauce_correlation_id"\s*:\s*"([a-f0-9]{64})"', prompt)
    if not nonce or not correlation:
        raise RuntimeError("owned delivery lacks its nonce or correlation")
    return json.dumps({"reply": "A18C_REPLY:" + nonce.group(0), "messages": [],
                       "status": "done", "retryable": False, "artifacts": [],
                       "cauce_correlation_id": correlation.group(1)})


if "exec" in sys.argv or not sys.stdin.isatty():
    prompt = sys.stdin.read() if sys.argv[-1] == "-" else " ".join(sys.argv[1:])
    emit({"type": "thread.started", "thread_id": str(uuid.uuid4())})
    emit({"type": "item.completed", "item": {"type": "agent_message", "text": response(prompt)}})
    sys.exit(0)

native = sys.argv[sys.argv.index("resume") + 1] if "resume" in sys.argv else str(uuid.uuid4())
uuid.UUID(native)
sessions = home / "sessions"
sessions.mkdir(mode=0o700, parents=True, exist_ok=True)
transcript = sessions / ("rollout-a18c-" + native + ".jsonl")


def append(kind, payload):
    with transcript.open("a") as stream:
        stream.write(json.dumps({"type": kind, "payload": payload}) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


if not transcript.exists():
    append("session_meta", {"id": native, "source": "cli", "cwd": os.getcwd()})
tty.setraw(sys.stdin.fileno())
sys.stdout.write("\x1b[?2004hA18C_TUI_READY\r\n")
sys.stdout.flush()
pending = ""


def render_idle():
    if pending:
        raise RuntimeError("a draft cannot be rendered as an idle composer")
    sys.stdout.write("\r\n› \x1b[2mAsk owned provider...\x1b[22m\r\x1b[2C")
    sys.stdout.flush()


render_idle()
while True:
    chunk = os.read(sys.stdin.fileno(), 65536).decode(errors="replace")
    if not chunk:
        break
    if not pending:
        sys.stdout.write("\r\x1b[2K› ")
        sys.stdout.flush()
    pending += chunk
    if len(pending.encode()) > 1048576:
        raise RuntimeError("owned terminal input exceeds its bound")
    sys.stdout.write(chunk.replace("\x1b[200~", "").replace("\x1b[201~", "").replace("\n", "\r\n"))
    sys.stdout.flush()
    first = pending.find("\x1b[200~")
    last = pending.find("\x1b[201~")
    if first < 0 or last < first:
        continue
    submitted = re.search(r"\r\n|\r|\n", pending[last + 6:])
    if submitted is None:
        continue
    prompt = pending[first + 6:last].replace("\r\n", "\n").replace("\r", "\n")
    pending = pending[last + 6 + submitted.end():]
    turn = str(uuid.uuid4())
    append("event_msg", {"type": "task_started", "turn_id": turn})
    append("response_item", {"type": "message", "role": "user",
                            "content": [{"type": "input_text", "text": prompt}],
                            "internal_chat_message_metadata_passthrough": {"turn_id": turn}})
    answer = response(prompt)
    append("event_msg", {"type": "task_complete", "turn_id": turn, "last_agent_message": answer})
    sys.stdout.write("\r\n" + answer + "\r\n")
    sys.stdout.flush()
    if pending:
        draft = pending.replace("\x1b[200~", "").replace("\x1b[201~", "").replace("\r\n", "\n").replace("\r", "\n")
        sys.stdout.write("\r\n› " + draft.replace("\n", "\r\n"))
        sys.stdout.flush()
    else:
        render_idle()
