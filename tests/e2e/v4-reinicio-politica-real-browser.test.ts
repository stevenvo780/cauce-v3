import { policyRecoveryBundle } from './h6d-reinicio-politica.fixtures.js';
import { definePolicyRestart } from './v4-reinicio-politica.flow.js';

definePolicyRestart({ harness: 'codex', runtimeBundle: policyRecoveryBundle });
