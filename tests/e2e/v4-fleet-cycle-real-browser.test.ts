import { defineFleetCycle } from './v4-fleet-cycle.flow.js';
import { cancelDeployRuntime } from './v4-fleet-cancel-deploy.runtime.js';

defineFleetCycle({ runtimeBundle: cancelDeployRuntime });
