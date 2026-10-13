import { expect, it } from 'vitest';
import { ApiError } from '../../api/client/core';
import { describeOperationError, describeQuotaEnvironmentError } from './quota-messages';

it.each([
  ['SCOPE_CHANGED', 'El agente cambió de ordenador o de configuración; vuelve a consultar.'],
  ['EXPIRED', 'La consulta caducó sin respuesta del ordenador; vuelve a consultar.'],
])('traduce el fallo durable %s a su acción de recuperación', (code, message) => {
  expect(describeOperationError(code)).toBe(message);
});

it('a 500 while reading an environment hides the server sentence', () => {
  const message = describeQuotaEnvironmentError(new ApiError('English server error', 500, 'internal'), 'fallback');
  expect(message).toContain('El servidor no confirmó el estado del entorno');
  expect(message).not.toContain('English server error');
});

it('keeps the quota account conflict text and does not echo the store sentence', () => {
  const message = describeQuotaEnvironmentError(
    new ApiError('quota account version changed or the change is not allowed', 409, 'conflict'),
    'fallback',
  );
  expect(message).toContain('Otro cambio llegó antes');
  expect(message).not.toContain('quota account');
});
