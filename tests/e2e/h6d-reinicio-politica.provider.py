#!/usr/local/bin/python3
import json
import os
import pathlib
import re
import signal
import sys
import tty
import uuid


def emit(value):
    print(json.dumps(value), flush=True)


if "app-server" in sys.argv:
    for line in sys.stdin:
        packet = json.loads(line)
        if "id" in packet:
            account = {"type": "chatgpt", "email": "fixture-owner@example.invalid"}
            result = {"account": account} if packet["method"] == "account/read" else {}
            emit({"id": packet["id"], "result": result})
    sys.exit(0)

headless = "exec" in sys.argv
prompt = sys.stdin.read() if headless and sys.argv[-1] == "-" else " ".join(sys.argv[1:])
bootstrap = re.search(r"CAUCE_BOOTSTRAP_[a-f0-9]{64}", prompt) if headless else None
if bootstrap:
    emit({"type": "thread.started", "thread_id": "host-setup-fixture"})
    emit({"type": "item.completed", "item": {"type": "agent_message", "text": bootstrap.group(0)}})
    sys.exit(0)

home = pathlib.Path(os.environ["CODEX_HOME"])
sessions = home / "sessions"
sessions.mkdir(parents=True, exist_ok=True, mode=0o700)
resume = "resume" in sys.argv
native = str(uuid.uuid4())
if resume:
    candidates = sys.argv[sys.argv.index("resume") + 1:]
    exact = next((value for value in candidates if re.fullmatch(r"[a-f0-9-]{36}", value)), None)
    if exact:
        native = exact
    elif "--last" in candidates:
        matching = []
        for candidate in sessions.glob("rollout-*.jsonl"):
            metadata = json.loads(candidate.read_text().splitlines()[0])["payload"]
            if metadata.get("cwd") == os.getcwd():
                matching.append((candidate.stat().st_mtime_ns, metadata["id"]))
        if not matching:
            sys.exit(3)
        native = max(matching)[1]
    else:
        sys.exit(4)

rollout = sessions / ("rollout-canary-" + native + ".jsonl")
memory = home / ("memory-" + native + ".json")
if resume and not rollout.exists():
    sys.exit(5)
if resume and (home / "h6d-fail-resume").exists():
    sys.exit(42)


def append(value):
    with rollout.open("a") as stream:
        stream.write(json.dumps(value) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


if not rollout.exists():
    append({"type": "session_meta", "payload": {"id": native, "source": "cli", "cwd": os.getcwd()}})
with (home / "h6d-invocations.jsonl").open("a") as stream:
    stream.write(json.dumps({"pid": os.getpid(), "native_id": native, "resumed": resume,
                             "mode": "exec" if headless else "tui", "cwd": os.getcwd()}) + "\n")
    stream.flush()
    os.fsync(stream.fileno())


def answer(text):
    turn = str(uuid.uuid4())
    append({"type": "event_msg", "payload": {"type": "task_started", "turn_id": turn}})
    append({"type": "response_item", "payload": {"type": "message", "role": "user",
            "content": [{"type": "input_text", "text": text}],
            "internal_chat_message_metadata_passthrough": {"turn_id": turn}}})
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
    append({"type": "event_msg", "payload": {"type": "task_complete", "turn_id": turn,
            "last_agent_message": response}})
    return response


if headless:
    emit({"type": "thread.started", "thread_id": native})
    emit({"type": "item.completed", "item": {"type": "agent_message", "text": answer(prompt)}})
    sys.exit(0)

signal.signal(signal.SIGINT, lambda *_: sys.exit(130))
print("POLICY_READY:" + native, flush=True)
tty.setraw(sys.stdin.fileno())
sys.stdout.write("\x1b[?2004h\r\n› ")
sys.stdout.flush()
pending = ""
pasting = False
while True:
    chunk = os.read(sys.stdin.fileno(), 4096).decode(errors="replace")
    if not chunk:
        break
    pending += chunk
    if "\x1b[200~" in pending:
        pasting = True
    if "\x1b[201~" in pending:
        pasting = False
    sys.stdout.write(chunk.replace("\x1b[200~", "").replace("\x1b[201~", "").replace("\n", "\r\n"))
    sys.stdout.flush()
    if pasting or not pending.endswith(("\r", "\n")):
        continue
    text = pending.replace("\x1b[200~", "").replace("\x1b[201~", "").replace("\r", "\n").strip()
    pending = ""
    sys.stdout.write("\r\n" + answer(text) + "\r\n› ")
    sys.stdout.flush()
