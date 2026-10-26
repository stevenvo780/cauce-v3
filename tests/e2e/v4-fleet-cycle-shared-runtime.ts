import type { ComputerRuntimeBundle } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { controlledSharedProvider } from './s2d-provider.js';
import { cancelDeployRuntime } from './v4-fleet-cancel-deploy.runtime.js';
import { stageSharedAdapter } from './v4-reiniciar-agente-standard.fixtures.js';

const provider = `#!/usr/local/bin/python3
import os,sys
if not sys.stdin.isatty() or 'app-server' in sys.argv or '--json' in sys.argv:
 exec(${JSON.stringify(cancelDeployRuntime.providerCli)})
else:
 os.execv('/usr/local/bin/node',['/usr/local/bin/node','--input-type=commonjs','-e',${JSON.stringify(controlledSharedProvider.replace(/^#![^\n]*\n/u, ''))},'codex',*sys.argv[1:]])
`;

/** A shared TUI release ships the SDK's shared-session helper: updates accredit the terminal with it before stopping. */
export const sharedCycleRuntime: ComputerRuntimeBundle = { ...cancelDeployRuntime, providerCli: provider, sharedTui: true,
  stage: directory => stageSharedAdapter(directory, 'codex') };
