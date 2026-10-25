import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { dirname, join } from 'node:path';

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$/;

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
  if (socketPath !== undefined) {
    await rm(socketPath, { force: true });
    await rm(join(dirname(socketPath), 'bridge.py'), { force: true });
  }
}

/** OpenSSH receives one argument, so the remote target stays an IPv4 host and a port. */
export function labTcpTarget(host: string, port: number): string {
  if (!IPV4.test(host)) throw new Error('lab tcp bridge requires an IPv4 host');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('lab tcp bridge requires a tcp port');
  return `${host}:${String(port)}`;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('lab tcp bridge did not reserve a loopback port'));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve(); });
  });
  return port;
}

function appendStderr(child: ChildProcess): string[] {
  const stderr: string[] = [];
  const stream = child.stderr;
  if (stream === null) throw new Error('lab tcp bridge did not pipe stderr');
  stream.on('data', (chunk: Buffer) => {
    stderr.push(chunk.toString());
    if (stderr.length > 20) stderr.shift();
  });
  return stderr;
}

async function waitUntilLoopbackAccepts(port: number, child: ChildProcess, stderr: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`lab tcp bridge did not accept on ${String(port)}: ${stderr.join('').slice(-500)}`));
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
      if (child.exitCode !== null || child.signalCode !== null) {
        finish(new Error(`lab tcp bridge exited ${String(child.exitCode)}: ${stderr.join('').slice(-500)}`));
        return;
      }
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.end(); finish(); });
      socket.once('error', () => { socket.destroy(); if (!settled) setTimeout(poll, 50); });
    };
    poll();
  });
}

/** Forwards a container port through the VM. An internal network drops packets that arrive from the workstation. */
export async function forwardLabTcp(host: string, port: number): Promise<{ port: number; close(): Promise<void> }> {
  const target = labTcpTarget(host, port);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const localPort = await reserveLoopbackPort();
    const child = spawn('ssh', [
      '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15', '-N', '-L', `127.0.0.1:${String(localPort)}:${target}`, 'docker-lab',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderr = appendStderr(child);
    try {
      await waitUntilLoopbackAccepts(localPort, child, stderr);
      return { port: localPort, close: () => stopChild(child) };
    } catch (error) {
      lastError = error;
      await stopChild(child);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('lab tcp bridge failed');
}

/** The workstation socket is not connectable from a container on the forwarded docker-lab daemon. */
export async function publishLabPrivateSocket(socketPath: string, port: number): Promise<{ close(): Promise<void> }> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('lab socket bridge requires the host proxy port');
  const scriptPath = join(dirname(socketPath), 'bridge.py');
  await writeFile(scriptPath, BRIDGE_SOURCE, { mode: 0o600 });
  const stderr: string[] = [];
  // OpenSSH joins the remote command for the login shell. These paths have no shell metacharacters.
  const child = spawn('ssh', [
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15', '-R', `127.0.0.1:${String(port)}:127.0.0.1:${String(port)}`, 'docker-lab',
    'python3', scriptPath, socketPath, String(port),
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
