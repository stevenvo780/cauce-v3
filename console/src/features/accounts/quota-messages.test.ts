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

it.each([
  [409, 'conflict', 'quota executor is unavailable for this host and provider', 'ejecutor de cuotas', 'proveedor'],
  [403, 'forbidden', 'quota account or host is unavailable in the acting company', 'cuenta o el ordenador', 'empresa'],
] as const)('explains the resource failure for %s %s without blaming the role or a concurrent change', (status, code, detail, subject, action) => {
  const message = describeQuotaEnvironmentError(new ApiError(detail, status, code), 'fallback');
  expect(message).toContain(subject);
  expect(message).toContain(action);
  expect(message).not.toContain('Tu rol');
  expect(message).not.toContain('Otro cambio llegó antes');
});

it.each([403, 409])('keeps a concrete environment refusal reason for status %s', (status) => {
  const message = describeQuotaEnvironmentError(
    new ApiError('La computadora ya no pertenece a esta empresa.', status, status === 403 ? 'forbidden' : 'conflict'),
    'fallback',
  );
  expect(message).toContain('La computadora ya no pertenece a esta empresa.');
});

it('does not append a generic HTTP refusal', () => {
  expect(describeQuotaEnvironmentError(new ApiError('Forbidden', 403, 'forbidden'), 'fallback')).toBe('Tu rol no permite esta acción.');
});
