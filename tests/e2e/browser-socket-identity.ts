export interface PrivateSocketView {
  readonly socket: boolean;
  readonly mode: number;
  readonly uid: number;
  readonly ino: number;
  readonly dev: number;
}

export interface PrivateSocketIdentity {
  readonly uid: number;
  readonly ino: number;
  readonly dev: number;
}

/** The workstation lstat and a container on the forwarded docker-lab daemon do not share device numbers. */
export function deviceNumbersAreComparable(dockerHost = process.env.DOCKER_HOST): boolean {
  return dockerHost?.includes('docker-lab.sock') !== true;
}

export function mountedSocketMatches(
  socket: PrivateSocketView,
  identity: PrivateSocketIdentity,
  dockerHost = process.env.DOCKER_HOST,
): boolean {
  const sameSocket = socket.socket
    && socket.mode === 0o600
    && socket.uid === identity.uid
    && socket.ino === identity.ino;
  if (!sameSocket) return false;
  if (!deviceNumbersAreComparable(dockerHost)) return true;
  return socket.dev === identity.dev;
}

/** The workstation connects to a VM tunnel only when the container network is not directly reachable. */
export function cdpUpstream(containerHost: string, tunnelPort: number | undefined): { host: string; port: number } {
  if (tunnelPort === undefined) return { host: containerHost, port: 9223 };
  if (!Number.isInteger(tunnelPort) || tunnelPort < 1 || tunnelPort > 65535) throw new Error('CDP tunnel port is invalid');
  return { host: '127.0.0.1', port: tunnelPort };
}
