import { expect, expectTypeOf, it } from 'vitest';
import type { Tenant } from '@cauce/protocol';
import { clientMailboxAddress } from '../src/client-mailbox.js';

const grant = 'c8c8b503-9938-4f64-bd2c-5416254b45c9';

it('requires an explicit tenant instead of choosing a business default', () => {
  expectTypeOf(clientMailboxAddress).parameters.toEqualTypeOf<[string, Tenant]>();
  expect(() => { Reflect.apply(clientMailboxAddress, undefined, [grant]); })
    .toThrowError('invalid mailbox tenant');
});

it('keeps the same grant isolated between arbitrary valid tenants', () => {
  const first = clientMailboxAddress(grant, 'empresa_uno');
  const second = clientMailboxAddress(grant, 'cliente-dos');
  expect(first).toMatch(/^mbx-[a-f0-9]{48}$/u);
  expect(second).toMatch(/^mbx-[a-f0-9]{48}$/u);
  expect(first).not.toBe(second);
  expect(clientMailboxAddress(grant.toUpperCase(), 'empresa_uno')).toBe(first);
});

it.each(['', 'empresa con espacios', '1empresa'])('rejects an invalid tenant without manufacturing an address: %j', tenant => {
  expect(() => clientMailboxAddress(grant, tenant)).toThrowError('invalid mailbox tenant');
});
