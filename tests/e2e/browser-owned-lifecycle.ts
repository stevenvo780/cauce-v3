import { execFile } from 'node:child_process';
import { assertBrowserSecurity, browserSecurityOptions, captureBrowserSecurity, resolveBrowserSecurity, verifyBrowserSocket, type BrowserContainerSecurity, type BrowserDocker, type BrowserSecurityPolicy } from './browser-security-policy.js';
interface ExecOptions { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number }
class SubprocessError extends Error {
  readonly stderr: string;
  readonly stdout: string;
  constructor(command: string, cause: unknown, stdout: string, stderr: string) {
    super(`subprocess ${command} failed`, { cause });
    this.stdout = stdout.slice(-64 * 1024);
    this.stderr = stderr.slice(-8 * 1024);
  }
}
export function browserExec(command: string, args: string[], options: ExecOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeout ?? 60_000;
    const { timeout: _timeout, maxBuffer, ...execOptions } = options;
    let timedOut = false;
    let escalation: NodeJS.Timeout | undefined;
    const child = execFile(command, args, { encoding: 'utf8', maxBuffer: maxBuffer ?? 64 * 1024, ...execOptions }, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      if (error || timedOut) reject(new SubprocessError(command, error ?? new Error(`timed out after ${String(timeoutMs)}ms`), stdout, stderr));
      else resolve({ stdout, stderr });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), 1_000);
    }, timeoutMs);
  });
}

export function browserDocker(args: string[], options: ExecOptions = {}) {
  return browserExec('docker', args, { timeout: 15_000, maxBuffer: 64 * 1024, ...options });
}

export function browserErrorStderr(error: unknown): string {
  let current = error;
  while (current !== null && typeof current === 'object') {
    if ('stderr' in current) {
      if (typeof current.stderr === 'string') return current.stderr;
      if (Buffer.isBuffer(current.stderr)) return current.stderr.toString('utf8');
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return error instanceof Error ? error.message : String(error);
}

export function browserErrorStdout(error: unknown): string {
  let current = error;
  while (current !== null && typeof current === 'object') {
    if ('stdout' in current && typeof current.stdout === 'string') return current.stdout;
    current = 'cause' in current ? current.cause : undefined;
  }
  return '';
}

export interface BrowserDescriptor {
  name: string; owner: string; imageId: string; networkName: string; networkId: string; networkOwner: string; directory: string;
  socketIdentity: { uid: number; dev: number; ino: number };
}
interface Container extends BrowserContainerSecurity {
  id: string; name: string; image: string; owner: string; cohort: string; networkMode: string;
  mounts: { Type: string; Source: string; Destination: string; RW: boolean }[];
  state: { Status: string; Pid: number };
  networks: Record<string, { NetworkID: string }>;
}

export class BrowserResourcesRetained extends Error {
  readonly retainBrowserResources = true;
  constructor(readonly descriptor: BrowserDescriptor, cause?: unknown) {
    super('Owned browser operation unresolved; namespace and image retained', { cause });
  }
}
export function browserResourcesRetained(error: unknown): boolean {
  if (error instanceof BrowserResourcesRetained) return true;
  if (error instanceof AggregateError && error.errors.some(browserResourcesRetained)) return true;
  return error instanceof Error && browserResourcesRetained(error.cause);
}
function absentContainer(error: unknown, reference: string): boolean {
  let value = error;
  let absent = false;
  let code: unknown;
  while (value !== null && typeof value === 'object') {
    if ('code' in value) code = value.code;
    if ('stderr' in value && typeof value.stderr === 'string'
      && new RegExp(`^(?:Error response from daemon: |Error: )?No such (?:object|container): ${reference}$`, 'iu').test(value.stderr.trim())) absent = true;
    value = 'cause' in value ? value.cause : undefined;
  }
  return code === 1 && absent;
}

export function ownedBrowserLifecycle(docker: BrowserDocker, descriptor: BrowserDescriptor, timing = {
  now: () => performance.now(), wait: (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
}, environment: Readonly<NodeJS.ProcessEnv> = process.env) {
  const request = captureBrowserSecurity(environment);
  let security: BrowserSecurityPolicy | undefined;
  const expected = Object.freeze({ ...descriptor, securityOptions: request.options, socketIdentity: Object.freeze({
    uid: descriptor.socketIdentity.uid, dev: descriptor.socketIdentity.dev, ino: descriptor.socketIdentity.ino,
  }) });
  let cid: string | undefined;
  let createIssued = false;
  let retained = false;
  let cleanup: Promise<void> | undefined;
  const verifyNetwork = async () => {
    const format = '{"id":{{json .Id}},"name":{{json .Name}},"internal":{{json .Internal}},"owner":{{json (index .Labels "cauce.e2e.owner")}}}';
    const network = JSON.parse((await docker(['network', 'inspect', '--format', format, expected.networkId], { timeout: 15_000 })).stdout) as {
      id: string; name: string; internal: unknown; owner: string;
    };
    if (network.id !== expected.networkId || network.name !== expected.networkName || network.internal !== true
      || network.owner !== expected.networkOwner) throw new Error('Owned browser network identity changed');
  };
  const inspect = async (timeout = 15_000): Promise<Container | undefined> => {
    const reference = cid ?? expected.name;
    const format = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"owner":{{json (index .Config.Labels "io.cauce.qa.browser")}},"cohort":{{json (index .Config.Labels "cauce.e2e.owner")}},"networkMode":{{json .HostConfig.NetworkMode}},"mounts":{{json .Mounts}},"state":{{json .State}},"networks":{{json .NetworkSettings.Networks}},"user":{{json (or (index .Config "User") "")}},"privileged":{{json .HostConfig.Privileged}},"securityOpt":{{json .HostConfig.SecurityOpt}},"capAdd":{{json .HostConfig.CapAdd}},"capDrop":{{json .HostConfig.CapDrop}}}';
    try {
      const view = JSON.parse((await docker(['inspect', '--format', format, reference], { timeout })).stdout) as Container;
      if (!/^[a-f0-9]{64}$/u.test(view.id) || (cid !== undefined && view.id !== cid) || view.name !== `/${expected.name}`
        || view.image !== expected.imageId || view.owner !== expected.owner || view.cohort !== 'ui-functional'
        || view.networkMode !== expected.networkName || view.mounts.length !== 1 || view.mounts[0]?.Type !== 'bind'
        || view.mounts[0].Source !== expected.directory || view.mounts[0].Destination !== '/qa-browser-transport' || view.mounts[0].RW) {
        throw new Error('Owned browser container identity changed');
      }
      assertBrowserSecurity(view, security);
      if (view.state.Status === 'running' && (Object.keys(view.networks).length !== 1
        || view.networks[expected.networkName]?.NetworkID !== expected.networkId)) throw new Error('Owned browser network identity changed');
      return view;
    } catch (error) {
      if (absentContainer(error, reference)) return undefined;
      throw error;
    }
  };
  const waitAbsent = async () => {
    const deadline = timing.now() + 15_000;
    while (timing.now() < deadline) {
      const current = await inspect(Math.max(1, Math.floor(deadline - timing.now())));
      if (current === undefined) return;
      await timing.wait(100);
    }
    throw new Error('Owned browser removal remains unresolved');
  };
  const close = () => {
    cleanup ??= (async () => {
      try {
        if (!createIssued) return;
        await verifyBrowserSocket(expected.directory, expected.socketIdentity);
        const current = await inspect();
        if (current === undefined) {
          if (cid === undefined) throw new Error('CLI exit does not confirm remote create cancellation');
          return;
        }
        cid = current.id;
        await verifyNetwork();
        if (current.state.Status === 'running') {
          try {
            await docker(['stop', '--time', '5', cid], { timeout: 15_000 });
          } catch (error) {
            if (!absentContainer(error, cid)) throw error;
            let remaining: Container | undefined;
            try {
              remaining = await inspect();
            } catch {
              throw error;
            }
            if (remaining !== undefined) throw error;
          }
        }
        if (current.state.Status === 'created' && current.state.Pid === 0) {
          try { await docker(['rm', cid], { timeout: 15_000 }); }
          catch (error) {
            const pending = await inspect();
            if (pending === undefined) return;
            if (pending.state.Status !== 'removing') throw error;
          }
        }
        await waitAbsent();
      } catch (error) {
        retained = true;
        process.stdout.write(`E2E browser retained: ${JSON.stringify({ ...expected, state: 'UNRESOLVED' })}\n`);
        throw new BrowserResourcesRetained(expected, error);
      }
    })();
    return cleanup;
  };
  return { descriptor: expected, retained: () => retained, close, start: async () => {
    security = await resolveBrowserSecurity(docker, expected.imageId, browserSecurityOptions(request.environment));
    process.stdout.write(`E2E browser security: ${JSON.stringify(security)}\n`);
    await verifyBrowserSocket(expected.directory, expected.socketIdentity);
    await verifyNetwork();
    if (await inspect() !== undefined) throw new Error('Owned browser name already exists');
    process.stdout.write(`E2E browser descriptor: ${JSON.stringify(expected)}\n`);
    createIssued = true;
    const receipt = (await docker(['create', '--pull=never', '--rm', ...expected.securityOptions.flatMap((option) => ['--security-opt', option]), '--network', expected.networkName,
      '--mount', `type=bind,source=${expected.directory},target=/qa-browser-transport,readonly`, '--name', expected.name,
      '--label', 'cauce.e2e.owner=ui-functional', '--label', `io.cauce.qa.browser=${expected.owner}`,
      '--entrypoint', 'sh', expected.imageId, '-lc', 'sleep 600'], { timeout: 15_000 })).stdout.trim();
    if (!/^[a-f0-9]{64}$/u.test(receipt)) throw new Error('Owned browser create receipt lacks an exact CID');
    cid = receipt;
    const created = await inspect();
    if (created?.state.Status !== 'created' || created.state.Pid !== 0) throw new Error('Owned browser create receipt cannot be verified');
    await verifyNetwork();
    await docker(['start', cid], { timeout: 15_000 });
    const running = await inspect();
    if (running?.state.Status !== 'running' || running.state.Pid <= 0) throw new Error('Owned browser start not observed running');
    return cid;
  } };
}
