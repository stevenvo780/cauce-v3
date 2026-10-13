import { expect, it } from 'vitest';
import { describeOperationError } from './quota-messages';

it.each([
  ['SCOPE_CHANGED', 'El agente cambió de ordenador o de configuración; vuelve a consultar.'],
  ['EXPIRED', 'La consulta caducó sin respuesta del ordenador; vuelve a consultar.'],
])('traduce el fallo durable %s a su acción de recuperación', (code, message) => {
  expect(describeOperationError(code)).toBe(message);
});
