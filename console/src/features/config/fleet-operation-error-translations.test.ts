import { describe, expect, it } from 'vitest';
import { isPrimaryMembershipError, primaryMembershipErrorText, translateFleetOperationError } from './fleet-operation-error-translations';

describe('fleet operation error translations', () => {
  it('translates the primary membership refusal with the group name', () => {
    expect(translateFleetOperationError('primary membership must be enabled in the activation intent', 'grp.miguel'))
      .toBe('Para activar el agente su grupo principal (grp.miguel) debe quedar habilitado. Marca "Habilitar membresía".');
    expect(primaryMembershipErrorText()).toBe('Para activar el agente su grupo principal debe quedar habilitado. Marca "Habilitar membresía".');
    expect(isPrimaryMembershipError('primary membership must be enabled in the activation intent')).toBe(true);
    expect(isPrimaryMembershipError(primaryMembershipErrorText('grp.x'))).toBe(true);
  });
  it('translates the other probable preview refusals', () => {
    expect(translateFleetOperationError('target tenant is not active')).toMatch(/no está activo/);
    expect(translateFleetOperationError('target harness is not enabled')).toMatch(/arnés.*no está habilitado/);
    expect(translateFleetOperationError('physical runtime identity is immutable')).toMatch(/clave física.*no se puede cambiar/);
    expect(translateFleetOperationError('physical runtime identity is reserved')).toMatch(/ya está reservada/);
    expect(translateFleetOperationError('membership room or routing role is unavailable')).toMatch(/rol de ruteo no está disponible/);
    expect(translateFleetOperationError('fleet host belongs to another company')).toMatch(/pertenece a otra empresa/);
    expect(translateFleetOperationError('fleet host must be registered in the target company first')).toMatch(/aún no está registrada/);
    expect(translateFleetOperationError('fleet controller placement is not configured')).toMatch(/controlador de flota no está configurado/);
    expect(translateFleetOperationError('agent identity already exists')).toMatch(/Ya existe un agente/);
  });
  it('returns undefined for unknown messages', () => {
    expect(translateFleetOperationError('some unknown failure')).toBeUndefined();
  });
});
