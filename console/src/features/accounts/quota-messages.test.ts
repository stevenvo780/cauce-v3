import { expect, it } from 'vitest';
import { ApiError } from '../../api/client/core';
import { describeOperationError, describeQuotaEnvironmentError } from './quota-messages';

it.each([
  ['SCOPE_CHANGED', 'El agente cambió de ordenador o de configuración; vuelve a consultar.'],
  ['EXPIRED', 'La consulta caducó sin respuesta del ordenador; vuelve a consultar.'],
])('traduce el fallo durable %s a su acción de recuperación', (code, message) => {
  expect(describeOperationError(code)).toBe(message);
});

it.each([
  [403, 'forbidden', 'quota account or host is unavailable in the acting company', 'La cuenta o la computadora no está disponible'],
  [409, 'conflict', 'quota executor is unavailable for this host and provider', 'El ejecutor de cuotas de la computadora no está disponible'],
  [409, 'quota_host_unavailable', 'host offline', 'El ejecutor de cuotas de la computadora no está disponible'],
  [500, 'internal', 'English server error', 'El servidor no confirmó el estado del entorno'],
] as const)('explica el error de entorno HTTP %s sin repetir el mensaje del servidor', (status, code, serverMessage, expected) => {
  const message = describeQuotaEnvironmentError(new ApiError(serverMessage, status, code), 'fallback');
  expect(message).toContain(expected);
  expect(message).not.toContain(serverMessage);
});

it('conserva el texto general de cuotas para otros conflictos de entorno', () => {
  const message = describeQuotaEnvironmentError(new ApiError('authentication already active', 409, 'conflict'), 'fallback');
  expect(message).toContain('Otro cambio llegó antes');
});
