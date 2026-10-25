import type { ComputerRuntimeBundle } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { controlledSharedProvider } from './s2d-provider.js';
import { cancelDeployRuntime } from './v4-fleet-cancel-deploy.runtime.js';

const provider = `#!/usr/local/bin/python3
import os,sys
if not sys.stdin.isatty() or 'app-server' in sys.argv or '--json' in sys.argv:
 exec(${JSON.stringify(cancelDeployRuntime.providerCli)})
else:
 os.execv('/usr/local/bin/node',['/usr/local/bin/node','--input-type=commonjs','-e',${JSON.stringify(controlledSharedProvider.replace(/^#![^\n]*\n/u, ''))},'codex',*sys.argv[1:]])
`;

export const sharedCycleRuntime: ComputerRuntimeBundle = { ...cancelDeployRuntime, providerCli: provider, sharedTui: true };
