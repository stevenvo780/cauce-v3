import { defineFleetCycle } from './v4-fleet-cycle.flow.js';
import { sharedCycleRuntime } from './v4-fleet-cycle-shared-runtime.js';

defineFleetCycle({ runtimeBundle: sharedCycleRuntime, owner: 'a21b-ciclo-tui-compartida-1025', sharedTui: true });

