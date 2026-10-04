import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const LOOPBACK = '127.0.0.1';
const STARTUP_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT = 4_000;
const PORT_ATTEMPTS = 3;

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not reserve a loopback port');
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

function outputBuffer(child) {
  let output = '';
  const append = (chunk) => { output = (output + String(chunk)).slice(-OUTPUT_LIMIT); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  return () => output;
}

function closed(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForClose(child, timeoutMs) {
  if (closed(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer;
    const finish = (didClose) => {
      clearTimeout(timer);
      child.off('close', onClose);
      resolve(didClose);
    };
    const onClose = () => finish(true);
    child.once('close', onClose);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

async function closeChild(child) {
  if (!closed(child) && child.pid !== undefined) child.kill('SIGTERM');
  if (await waitForClose(child, CLOSE_TIMEOUT_MS)) return;
  if (!closed(child) && child.pid !== undefined) child.kill('SIGKILL');
  if (!await waitForClose(child, CLOSE_TIMEOUT_MS)) {
    throw new Error(`Vite process ${String(child.pid)} was not reaped after SIGKILL`);
  }
}

function waitUntilReady(child, port, output) {
  const origin = `http://${LOOPBACK}:${String(port)}`;
  return new Promise((resolve, reject) => {
    let checking = false;
    let timer;
    let poll;
    const finish = (error) => {
      clearTimeout(timer);
      clearInterval(poll);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve(origin);
    };
    const readinessLine = new RegExp(`Local:\\s+${origin.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\/`);
    const probe = async () => {
      if (checking || !readinessLine.test(output())) return;
      checking = true;
      try {
        const response = await fetch(origin, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) finish();
      } catch {
        // The own Vite process may print its ready line just before the listener accepts requests.
      } finally {
        checking = false;
      }
    };
    const onExit = (code, signal) => finish(new Error(
      `Vite exited before readiness on ${origin} (code ${String(code)}, signal ${String(signal)})\n${output() || '(no output)'}`,
    ));
    const onError = (error) => finish(new Error(
      `Vite failed before readiness on ${origin}: ${error.message}\n${output() || '(no output)'}`,
    ));
    child.once('exit', onExit);
    child.once('error', onError);
    poll = setInterval(() => { void probe(); }, 50);
    timer = setTimeout(() => finish(new Error(
      `Vite did not become ready on ${origin}\n${output() || '(no output)'}`,
    )), STARTUP_TIMEOUT_MS);
    void probe();
  });
}

async function startAtPort(root, viteEntry, port) {
  const child = spawn(process.execPath, [viteEntry, '--host', LOOPBACK, '--port', String(port), '--strictPort'], {
    cwd: root,
    env: { ...process.env, VITE_USE_MOCKS: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = outputBuffer(child);
  try {
    const origin = await waitUntilReady(child, port, output);
    let closePromise;
    return {
      origin,
      pid: child.pid,
      close() {
        closePromise ??= closeChild(child);
        return closePromise;
      },
    };
  } catch (startupError) {
    try {
      await closeChild(child);
    } catch (closeError) {
      throw new AggregateError([startupError, closeError], 'Vite startup and cleanup both failed');
    }
    throw startupError;
  }
}

export async function startLayoutDevServer({ root, viteEntry }) {
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    const port = await reservePort();
    try {
      return await startAtPort(root, viteEntry, port);
    } catch (error) {
      if (attempt + 1 === PORT_ATTEMPTS || !String(error).includes(`Port ${String(port)} is already in use`)) {
        throw error;
      }
    }
  }
  throw new Error('could not start Vite after reserving loopback ports');
}
