import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const fixture = vi.hoisted(() => ({
  directory: '', certificate: '', pendingRead: undefined as Promise<void> | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    readdir: async (path: string) => {
      if (fixture.pendingRead !== undefined) await fixture.pendingRead;
      return original.readdir(path);
    },
  };
});

class TestServer extends EventEmitter {
  listening = false;
  listen(_port: number, _host: string, callback: () => void): void {
    this.listening = true;
    callback();
  }
  close(callback: () => void): void { callback(); }
}

vi.mock('./config.js', () => ({
  loadRelayConfig: () => ({
    tlsCertFile: fixture.certificate, tlsKeyFile: fixture.certificate,
    clientCaFile: fixture.certificate, agentCaFile: fixture.certificate,
    gatewayClientCertFile: fixture.certificate, gatewayClientKeyFile: fixture.certificate,
    expectedRelayInstanceId: 'test-relay', presenceMaxStaleMs: 30_000,
    agentPort: 8445, browserPort: 8446, healthPort: 8085, listenHost: '127.0.0.1',
    recordingDir: fixture.directory || undefined,
  }),
}));
vi.mock('./relay-identity.js', () => ({
  relayProcessIdentity: () => ({ relayInstanceId: 'test-relay' }),
}));
vi.mock('./gateway-client.js', () => ({
  HttpsTerminalGatewayClient: class { publishPresence(): Promise<void> { return Promise.resolve(); } },
}));
vi.mock('./agent-leg.js', () => ({
  createAgentTlsServer: () => new TestServer(),
  AgentLeg: class {
    presence(): readonly never[] { return []; }
    close(): Promise<void> { return Promise.resolve(); }
  },
}));
vi.mock('./browser-leg.js', () => ({
  createBrowserHttpsServer: () => new TestServer(),
  BrowserLeg: class { close(): Promise<void> { return Promise.resolve(); } },
}));
vi.mock('./governance-relay.js', () => ({ setupGovernanceRelay: () => undefined }));
vi.mock('./health.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./health.js')>(),
  createRelayHealthServer: () => new TestServer(),
}));
vi.mock('./sessions.js', async (importOriginal) => ({
  CLOSE_CODES: (await importOriginal<typeof import('./sessions.js')>()).CLOSE_CODES,
  SessionManager: class {
    closeAll(): void { /* No sessions are opened by this startup fixture. */ }
    flush(): Promise<void> { return Promise.resolve(); }
  },
}));

const DAY_MS = 86_400_000;
const SIGNALS = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'] as const;
let root: string;
const eventProcess: EventEmitter = process;
let listeners: Map<string, ReturnType<EventEmitter['listeners']>>;
let exit: MockInstance<NodeJS.Process['exit']>;

function writeCast(name: string, ageDays: number): string {
  const path = join(fixture.directory, name);
  writeFileSync(path, 'asciicast\n', { mode: 0o600 });
  const modified = new Date(Date.now() - ageDays * DAY_MS);
  utimesSync(path, modified, modified);
  return path;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(40 * DAY_MS);
  vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(1_000);
  exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  listeners = new Map(SIGNALS.map((signal) => [signal, eventProcess.listeners(signal)]));
  root = mkdtempSync(join(tmpdir(), 'cauce-relay-retention-'));
  fixture.directory = join(root, 'recordings');
  mkdirSync(fixture.directory);
  fixture.certificate = join(root, 'certificate');
  writeFileSync(fixture.certificate, 'test-certificate');
});

afterEach(() => {
  for (const signal of SIGNALS) {
    for (const listener of eventProcess.listeners(signal)) {
      if (!listeners.get(signal)?.includes(listener)) {
        eventProcess.removeListener(signal, listener as (...args: unknown[]) => void);
      }
    }
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('terminal relay recording retention startup', () => {
  it.each(['src', 'dist'])('loads retention from the compiled %s service layout', async (layout) => {
    const expired = writeCast('expired.cast', 31);
    const recent = writeCast('recent.cast', 29);
    const mainDirectory = join(root, 'services', 'terminal-relay', layout);
    const retentionDirectory = join(root, 'services', 'gateway', layout, 'terminal');
    mkdirSync(mainDirectory, { recursive: true });
    mkdirSync(retentionDirectory, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    const compile = (source: URL): string => ts.transpileModule(readFileSync(source, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
    }).outputText;
    const main = compile(new URL('./main.ts', import.meta.url)).replace(
      /from ['"]\.\/([^'"]+)['"]/gu,
      (_match, module: string) => `from '${new URL(module, import.meta.url).href}'`,
    );
    const mainPath = join(mainDirectory, 'main.js');
    writeFileSync(mainPath, main);
    writeFileSync(join(retentionDirectory, 'recording-retention.js'), compile(
      new URL('../../gateway/src/terminal/recording-retention.ts', import.meta.url),
    ));

    await import(pathToFileURL(mainPath).href);
    await vi.waitFor(() => { expect(existsSync(expired)).toBe(false); });
    expect(existsSync(recent)).toBe(true);
  });

  it('starts without waiting for or overlapping a pending recording directory scan', async () => {
    const expired = writeCast('expired.cast', 31);
    const filesystem = await import('node:fs/promises');
    const scans = vi.spyOn(filesystem, 'readdir');
    let release = (): void => undefined;
    fixture.pendingRead = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    const starting = import('./main.js').then(() => { started = true; });
    try {
      await vi.waitFor(() => { expect(started).toBe(true); });
      expect(existsSync(expired)).toBe(true);
      expect(scans).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(7_200_000);
      expect(scans).toHaveBeenCalledTimes(1);
    } finally {
      fixture.pendingRead = undefined;
      release();
      await starting;
    }
    await vi.waitFor(() => { expect(existsSync(expired)).toBe(false); });
  });

  it('sweeps on startup and hourly while preserving recordings younger than 30 days', async () => {
    const expired = writeCast('expired.cast', 31);
    const recent = writeCast('recent.cast', 29);

    await import('./main.js');

    await vi.waitFor(() => { expect(existsSync(expired)).toBe(false); });
    expect(existsSync(recent)).toBe(true);
    const next = writeCast('next.cast', 31);
    await vi.advanceTimersByTimeAsync(3_599_000);
    expect(existsSync(next)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => { expect(existsSync(next)).toBe(false); });
    expect(existsSync(recent)).toBe(true);

    process.emit('SIGTERM');
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(0); });
    const afterShutdown = writeCast('after-shutdown.cast', 31);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(existsSync(afterShutdown)).toBe(true);
  });

  it('starts when the directory is missing and sweeps after it becomes available', async () => {
    rmSync(fixture.directory, { recursive: true });
    await import('./main.js');
    await vi.waitFor(() => { expect(console.warn).toHaveBeenCalled(); });
    expect(exit).not.toHaveBeenCalled();

    mkdirSync(fixture.directory);
    const expired = writeCast('expired.cast', 31);
    await vi.advanceTimersByTimeAsync(3_600_000);
    await vi.waitFor(() => { expect(existsSync(expired)).toBe(false); });
  });

  it('does not schedule retention when recordings are disabled', async () => {
    const expired = writeCast('expired.cast', 31);
    fixture.directory = '';
    await import('./main.js');
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(existsSync(expired)).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
  });
});
