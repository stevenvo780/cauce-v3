import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client/core';
import { applicationNotice, contextRequestMessage } from './context-version-messages';

describe('context version error messages', () => {
  it('directs an unreadable version request to restoration instead of the generic 422 message', () => {
    const cause = new ApiError('stored version is unreadable', 422, 'context_version_unreadable');
    expect(contextRequestMessage(cause, 'Fallback')).toBe('La versión actual no se puede leer. Restaura una versión anterior desde el historial.');
  });

  it('requires history restoration for an unreadable version application', () => {
    const cause = new ApiError('stored version is unreadable', 422, 'context_version_unreadable');
    expect(applicationNotice(cause.code ?? '')).toEqual({
      pending: false,
      message: 'La versión actual no se puede leer. Restaura una versión anterior desde el historial.',
    });
  });

  it('explains the governed profile rejection without suggesting a version retry', () => {
    const message = contextRequestMessage(new ApiError('profile is governed', 409, 'profile_is_governed'), 'Fallback');
    expect(message).toContain('El perfil del agente está gobernado');
    expect(message).toContain('edítalo desde la consola');
    expect(message).toContain('context/notes/');
    expect(message).not.toContain('Conflicto de versión');
    expect(message).not.toContain('profile is governed');
  });

  it('still explains a typed version conflict and preserves the draft', () => {
    const message = contextRequestMessage(new ApiError('version changed', 409, 'context_version_conflict'), 'Fallback');
    expect(message).toContain('Conflicto de versión');
    expect(message).toContain('tu borrador se conserva');
  });

  it('keeps the governed path guidance for other routes', () => {
    const message = contextRequestMessage(new ApiError('path is governed', 403, 'context_governed_path'), 'Fallback');
    expect(message).toContain('Esa ruta está gobernada');
    expect(message).toContain('context/notes/');
  });
});
