import { registerDownSafetyTests } from './down-safety.fixtures.js';

registerDownSafetyTests(import.meta.url, '057_quota_environments.sql', [
  { version: '058_context_versions.sql', marker: 'agent_context_versions', kind: 'table' },
  { version: '059_host_enrollment.sql', marker: 'fleet_host_enrollments', kind: 'table' },
  { version: '061_people_admin_history.sql', marker: 'cauce_runtime_grants_061()', kind: 'function' },
  { version: '062_authority_read_guard.sql', marker: 'cauce_runtime_grants_062()', kind: 'function' },
  { version: '063_company_registration_director.sql', marker: 'cauce_runtime_grants_063()', kind: 'function' },
  { version: '064_company_context_anchor.sql', marker: 'cauce_ensure_context_director_anchor(text,text,text,bigint,text)', kind: 'function' },
  { version: '065_runtime_grants_replay.sql', marker: 'cauce_runtime_grants_065()', kind: 'function' },
]);
