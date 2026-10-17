import { spawnSync } from 'node:child_process';

const MARCA = 'CAUCE_QA_RED_AISLADA';
const NAMESPACE = ['--user', '--map-root-user', '--net', 'sh', '-c'];

/* Docker adding or dropping a host network makes Chromium abort every load in flight with ERR_NETWORK_CHANGED,
 * and no switch turns that observer off. The gate re-runs itself, Vite and Chromium included, in a private network
 * namespace that only has its own loopback; where unprivileged namespaces are unavailable it says so and runs in place. */
export function enRedAislada(argumentos = process.argv.slice(1)) {
  if (process.env[MARCA] === '1') return;
  const sonda = spawnSync('unshare', [...NAMESPACE, 'ip link set lo up'], { encoding: 'utf8' });
  if (sonda.status !== 0) {
    const motivo = (sonda.error?.message ?? sonda.stderr ?? '').trim() || `exit ${String(sonda.status)}`;
    console.error(`layout: no private network namespace (${motivo}); a host network change can abort page loads`);
    return;
  }
  const hijo = spawnSync('unshare', [...NAMESPACE, 'ip link set lo up && exec "$@"', 'sh',
    process.execPath, ...process.execArgv, ...argumentos], { stdio: 'inherit', env: { ...process.env, [MARCA]: '1' } });
  if (hijo.error) throw hijo.error;
  if (hijo.signal) process.kill(process.pid, hijo.signal);
  process.exit(hijo.status ?? 1);
}
