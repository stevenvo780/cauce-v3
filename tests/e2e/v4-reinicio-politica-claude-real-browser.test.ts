import { claudePolicyRecoveryBundle } from './h6d-reinicio-politica.fixtures.js';
import { definePolicyRestart } from './v4-reinicio-politica.flow.js';

definePolicyRestart({ harness: 'claude', runtimeBundle: claudePolicyRecoveryBundle, owner: 'p10-claude-1026' });
