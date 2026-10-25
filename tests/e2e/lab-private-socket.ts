import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, rm } from 'node:fs/promises';

const WRAPPER = 'import base64,sys; code=base64.b64decode(sys.argv[1]); sys.argv=[sys.argv[0],*sys.argv[2:]]; exec(code)';
const BRIDGE_SOURCE = `
import os, socket, threading, sys, signal
path, port = sys.argv[1], int(sys.argv[2])
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
try:
    os.remove(path)
except FileNotFoundError:
    pass
server.bind(path)
os.chmod(path, 0o600)
server.listen(16)
def stop(_signum, _frame):
    server.close()
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGHUP, stop)
def copy(source, sink):
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            sink.sendall(data)
    except OSError:
        pass
    finally:
        for channel in (source, sink):
            try:
                channel.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                channel.close()
            except OSError:
                pass
while True:
    try:
        client, _address = server.accept()
    except OSError:
        break
    try:
        upstream = socket.create_connection(("127.0.0.1", port), timeout=5)
    except OSError:
        client.close()
        continue
    threading.Thread(target=copy, args=(client, upstream), daemon=True).start()
    threading.Thread(target=copy, args=(upstream, client), daemon=True).start()
try:
    os.remove(path)
except FileNotFoundError:
    pass
`;

async function stopChild(child: ChildProcess, socketPath?: string): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (socketPath !== undefined) await rm(socketPath, { force: true });
}

/** The workstation socket is not connectable from a container on the forwarded docker-lab daemon. */
export async function publishLabPrivateSocket(socketPath: string, port: number): Promise<{ close(): Promise<void> }> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('lab socket bridge requires the host proxy port');
  const stderr: string[] = [];
  const child = spawn('ssh', [
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15', '-R', `127.0.0.1:${String(port)}:127.0.0.1:${String(port)}`, 'docker-lab',
    'python3', '-c', WRAPPER, Buffer.from(BRIDGE_SOURCE, 'utf8').toString('base64'), socketPath, String(port),
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr.push(chunk.toString());
    if (stderr.length > 20) stderr.shift();
  });
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`lab socket bridge did not publish ${socketPath}: ${stderr.join('').slice(-500)}`));
    }, 10_000);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const poll = (): void => {
      if (settled) return;
      void lstat(socketPath).then((stat) => {
        if (settled) return;
        if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
          setTimeout(poll, 50);
          return;
        }
        finish();
      }).catch(() => { if (!settled) setTimeout(poll, 50); });
    };
    child.once('exit', (code) => {
      finish(new Error(`lab socket bridge exited ${String(code)}: ${stderr.join('').slice(-500)}`));
    });
    poll();
  });
  try {
    await ready;
  } catch (error) {
    await stopChild(child, socketPath);
    throw error;
  }
  return { close: () => stopChild(child, socketPath) };
}
