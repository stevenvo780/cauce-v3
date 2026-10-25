import type { ComputerRuntimeBundle } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { standardRecoveryBundle } from './v4-reiniciar-agente-standard.fixtures.js';

/**
 * Interactive terminals run the resumable shared-TUI provider (it keeps its conversation across a restart);
 * headless and app-server calls keep the runtime's own provider. The bundle also ships the recovery helper.
 */
export function withSharedTui(runtime: ComputerRuntimeBundle): ComputerRuntimeBundle {
  const providerCli = `#!/usr/local/bin/python3
import os,sys
# Real Codex writes private transcripts; the exact-conversation check rejects group or world writable files.
os.umask(0o077)
if sys.stdin.isatty() and 'app-server' not in sys.argv and 'exec' not in sys.argv and '--json' not in sys.argv:
 exec(${JSON.stringify(standardRecoveryBundle.providerCli)})
else:
 exec(${JSON.stringify(runtime.providerCli)})
`;
  return { ...runtime, providerCli, sharedTui: true, stage: directory => standardRecoveryBundle.stage(directory) };
}
