import { lstat } from 'node:fs/promises';

export type BrowserDocker = (args: string[], options?: { timeout: number }) => Promise<{ stdout: string }>;
export interface BrowserSecurityPolicy {
  readonly options: readonly string[];
  readonly imageUser: string;
  readonly daemon?: Readonly<{ version: string; apiVersion: string; minApiVersion: string; os: string; arch: string }>;
}
export interface BrowserContainerSecurity {
  user: unknown; privileged: unknown; securityOpt: unknown; capAdd: unknown; capDrop: unknown;
}

export function captureBrowserSecurity(environment: Readonly<NodeJS.ProcessEnv>) {
  const snapshot = Object.freeze({ CAUCE_E2E_BROWSER_SELINUX_COMPAT: environment.CAUCE_E2E_BROWSER_SELINUX_COMPAT });
  return Object.freeze({ environment: snapshot, options: Object.freeze(snapshot.CAUCE_E2E_BROWSER_SELINUX_COMPAT === '1' ? ['label=disable'] : []) });
}

export function browserSecurityOptions(environment: Readonly<NodeJS.ProcessEnv>): readonly string[] {
  const value = environment.CAUCE_E2E_BROWSER_SELINUX_COMPAT;
  if (value !== undefined && value !== '1') throw new Error('CAUCE_E2E_BROWSER_SELINUX_COMPAT must be absent or exactly 1');
  return Object.freeze(value === '1' ? ['label=disable'] : []);
}

export async function resolveBrowserSecurity(docker: BrowserDocker, imageId: string, options: readonly string[]): Promise<BrowserSecurityPolicy> {
  if (options.length > 1 || (options.length === 1 && options[0] !== 'label=disable')) throw new Error('Browser security options are not allowed');
  const imageFormat = '{"id":{{json .Id}},"user":{{json (or (index .Config "User") "")}}}';
  const image = JSON.parse((await docker(['image', 'inspect', '--format', imageFormat, imageId], { timeout: 15_000 })).stdout) as { id?: unknown; user?: unknown };
  if (image.id !== imageId || typeof image.user !== 'string') throw new Error('Browser image default user cannot be verified');
  let daemon: BrowserSecurityPolicy['daemon'];
  if (options.length !== 0) {
    const capabilities: unknown = JSON.parse((await docker(['info', '--format', '{{json .SecurityOptions}}'], { timeout: 15_000 })).stdout);
    if (!Array.isArray(capabilities) || !capabilities.includes('name=selinux')) throw new Error('Browser SELinux compatibility requires daemon SELinux support');
    const format = '{"version":{{json .Server.Version}},"apiVersion":{{json .Server.APIVersion}},"minApiVersion":{{json .Server.MinAPIVersion}},"os":{{json .Server.Os}},"arch":{{json .Server.Arch}}}';
    const version = JSON.parse((await docker(['version', '--format', format], { timeout: 15_000 })).stdout) as { [Key in keyof NonNullable<BrowserSecurityPolicy['daemon']>]: unknown } | null;
    if (version === null || ['version', 'apiVersion', 'minApiVersion', 'os', 'arch'].some((key) => typeof version[key as keyof typeof version] !== 'string' || version[key as keyof typeof version] === '')) throw new Error('Browser daemon version cannot be verified');
    daemon = Object.freeze(version as NonNullable<BrowserSecurityPolicy['daemon']>);
  }
  return Object.freeze({ options: Object.freeze([...options]), imageUser: image.user, ...(daemon === undefined ? {} : { daemon }) });
}

export function assertBrowserSecurity(container: BrowserContainerSecurity, policy: BrowserSecurityPolicy | undefined): void {
  if (policy === undefined) throw new Error('Owned browser security policy is unresolved');
  const options = container.securityOpt === null ? [] : container.securityOpt;
  const defaultCaps = (value: unknown) => value === null || (Array.isArray(value) && value.length === 0);
  if (container.user !== policy.imageUser || container.privileged !== false || !defaultCaps(container.capAdd) || !defaultCaps(container.capDrop)
    || !Array.isArray(options) || options.length !== policy.options.length || options.some((option, index) => option !== policy.options[index])) {
    throw new Error('Owned browser security policy changed');
  }
}

export async function verifyBrowserSocket(directory: string, expected: { uid: number; dev: number; ino: number }): Promise<void> {
  const socket = await lstat(`${directory}/proxy.sock`);
  if (!socket.isSocket() || socket.uid !== expected.uid || socket.dev !== expected.dev
    || socket.ino !== expected.ino || (socket.mode & 0o777) !== 0o600) throw new Error('Owned browser socket identity changed');
}
