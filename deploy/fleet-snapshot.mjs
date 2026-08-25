#!/usr/bin/env node

import { createPool } from '../packages/store/dist/db.js';
import { assertProductionPostgresTls } from './postgres-tls.mjs';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

await assertProductionPostgresTls();
const pool = createPool(connectionString, { max: 1, applicationName: 'cauce-fleet-snapshot' });
try {
  const result = await pool.query(`
    SELECT jsonb_build_object(
      'schemaVersion', 3,
      'agents', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'tenant_id', tenant_id,
          'alias', alias,
          'harness_id', harness_id,
          'enabled', enabled,
          'container_name', container_name,
          'runtime_user', runtime_user,
          'home_directory', home_directory,
          'state_directory', state_directory
        ) ORDER BY tenant_id, alias)
        FROM agents
      ), '[]'::jsonb),
      'memberships', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'tenant_id', tenant_id,
          'alias', alias,
          'room_id', room_id,
          'role', role
        ) ORDER BY tenant_id, alias, room_id)
        FROM memberships
        WHERE enabled
      ), '[]'::jsonb),
      'rolePolicies', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'role', role,
          'allow_route', allow_route,
          'allow_read', allow_read,
          'allow_control', allow_control,
          'allow_notify', allow_notify
        ) ORDER BY role)
        FROM role_policies
      ), '[]'::jsonb),
      'leases', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'tenant_id', tenant_id,
          'alias', alias,
          'active', lease_until > now()
        ) ORDER BY tenant_id, alias)
        FROM connection_leases
      ), '[]'::jsonb)
    ) AS snapshot
  `);
  const snapshot = result.rows[0]?.snapshot;
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('fleet snapshot query returned an invalid document');
  }
  process.stdout.write(`${JSON.stringify(snapshot)}\n`);
} finally {
  await pool.end();
}
