import { describe, expect, it } from 'vitest';
import { ConfigChangeRequestSchema, ConfigMutationSchema } from '@cauce/protocol';

/**
 * The generic editor only versions configuration that becomes effective in the database. Profile
 * and identity additionally require applying files inside the runtime; that is why their only
 * public write is the canonical profile PUT, with its own revision, preflight, and exact per-file ACK.
 */
describe('el perfil no tiene una segunda vía de escritura', () => {
  it.each(['create', 'update', 'delete'] as const)(
    'ConfigMutationSchema rechaza agent_profile/%s',
    (action) => {
      expect(ConfigMutationSchema.safeParse({
        resource: 'agent_profile', action, tenant_id: 'Steven', alias: 'zeus',
        ...(action === 'delete' ? {} : { value: { purpose: 'duplicado' } }),
      }).success).toBe(false);
    },
  );

  it('rechaza agents.role_brief porque es una proyección legacy de role_summary', () => {
    expect(ConfigMutationSchema.safeParse({
      resource: 'agent', action: 'update', tenant_id: 'Steven', alias: 'zeus',
      value: { role_brief: 'duplicado' },
    }).success).toBe(false);
  });

  it('el sobre completo tampoco acepta la vía duplicada', () => {
    expect(ConfigChangeRequestSchema.safeParse({
      dry_run: false,
      expected_revision: 42,
      mutation: {
        resource: 'agent_profile', action: 'update', tenant_id: 'Steven', alias: 'zeus',
        value: { purpose: 'duplicado' },
      },
    }).success).toBe(false);
  });

  it('control negativo: una edición real del registro sigue siendo válida', () => {
    expect(ConfigMutationSchema.parse({
      resource: 'agent', action: 'update', tenant_id: 'Steven', alias: 'zeus',
      value: { display_name: 'Zeus', enabled: false },
    })).toMatchObject({ resource: 'agent', value: { display_name: 'Zeus', enabled: false } });
  });
});
