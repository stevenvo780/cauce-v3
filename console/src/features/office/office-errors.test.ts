import { expect, it } from 'vitest';
import { ApiError } from '../../api/client/core';
import { describeOfficeError } from './office-errors';

it('maps a network failure to contacting the server instead of echoing the browser sentence', () => {
  const message = describeOfficeError(new TypeError('Failed to fetch'));
  expect(message).toContain('No se pudo contactar con el servidor');
  expect(message).not.toContain('Failed to fetch');
});

it('hides a 5xx server sentence behind the retry instruction', () => {
  const message = describeOfficeError(new ApiError('English server error', 500, 'internal'));
  expect(message).toContain('Inténtalo más tarde');
  expect(message).not.toContain('English server error');
});
