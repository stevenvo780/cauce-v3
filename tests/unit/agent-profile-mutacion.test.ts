import { describe, expect, it } from 'vitest';
import { ConfigChangeRequestSchema, ConfigMutationSchema } from '@cauce/protocol';

/**
 * El editor genérico sólo versiona configuración que queda efectiva en la base. Perfil e identidad
 * requieren además aplicar ficheros dentro del runtime; por eso su única escritura pública es el
 * PUT canónico de perfil, con revisión propia, preflight y ACK exacto por fichero.
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
