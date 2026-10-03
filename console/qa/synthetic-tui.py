import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios

PROGRAM = r'''
import os, signal, termios, tty
tty.setraw(0)
def resized(*_):
    rows, cols = termios.tcgetwinsize(0)
    os.write(1, f"\r\nRESIZE {cols} {rows}\r\n".encode())
signal.signal(signal.SIGWINCH, resized)
os.write(1, b"\x1b[2J\x1b[HSYNTHETIC TUI: bytes only; no command execution\r\n")
while True:
    data = os.read(0, 65536)
    if not data:
        break
    os.write(1, b"\r\nKEY " + data.hex().encode() + b"\r\n")
'''


def attach_terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
    os.tcsetpgrp(0, os.getpgrp())


master, slave = pty.openpty()
child = subprocess.Popen(
    [sys.executable, '-u', '-c', PROGRAM],
    stdin=slave, stdout=slave, stderr=slave, preexec_fn=attach_terminal,
)
os.close(slave)
pending = b''
try:
    while child.poll() is None:
        readable, _, _ = select.select([master, sys.stdin.fileno()], [], [], 1)
        if master in readable:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            os.write(sys.stdout.fileno(), data)
        if sys.stdin.fileno() in readable:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                break
            pending += data
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                message = json.loads(line)
                if message['type'] == 'input':
                    os.write(master, bytes.fromhex(message['hex']))
                elif message['type'] == 'resize':
                    size = struct.pack('HHHH', message['rows'], message['cols'], 0, 0)
                    fcntl.ioctl(master, termios.TIOCSWINSZ, size)
finally:
    os.close(master)
    if child.poll() is None:
        child.terminate()
    child.wait(timeout=3)
