import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseControlRequest, parseSessionRequest } from './plugin.js';

const session = () => ({ tenant_id: 'Steven', alias: 'a', mode: 'shell', cols: 80, rows: 24,
  request_id: randomUUID(), owner_token: randomUUID() });
const control = () => ({ action: 'take', authority_proof: `ac2.${'a'.repeat(100)}`,
  request_id: randomUUID(), owner_generation: '1', owner_token: randomUUID() });

describe('terminal requests without operator justification', () => {
  it('accepts exactly the session fields with an optional guarded initiator', () => {
    const body = session();
    expect(parseSessionRequest(body)).toEqual({ ...body, initiator: 'operator' });
    expect(parseSessionRequest({ ...body, initiator: 'auto', mode: 'harness' })).toMatchObject({ initiator: 'auto' });
    expect(() => parseSessionRequest({ ...body, initiator: 'auto', mode: 'harness_rw' })).toThrow('automatic viewer');
    expect(() => parseSessionRequest({ ...body, initiator: 'invalid' })).toThrow('initiator');
    expect(parseSessionRequest({ ...body, mode: 'harness_rw' })).not.toHaveProperty('reason');
  });

  it.each(['', '   ', 'legacy operator justification', null, 42])('rejects legacy reason %j as an unexpected field', (reason) => {
    expect(() => parseSessionRequest({ ...session(), reason })).toThrow('unexpected or missing fields');
    expect(() => parseControlRequest({ ...control(), reason })).toThrow('unexpected or missing fields');
    expect(() => parseControlRequest({ ...control(), action: 'release', reason })).toThrow('unexpected or missing fields');
  });

  it('takes and releases control without a reason, allowing busy only on take', () => {
    const body = control();
    expect(parseControlRequest(body)).toEqual(body);
    expect(parseControlRequest({ ...body, allow_busy: true })).toEqual({ ...body, allow_busy: true });
    expect(parseControlRequest({ ...body, allow_busy: false })).toEqual({ ...body, allow_busy: false });
    expect(parseControlRequest({ ...body, action: 'release' })).toEqual({ ...body, action: 'release' });
    expect(() => parseControlRequest({ ...body, action: 'release', allow_busy: false })).toThrow('allow_busy');
    expect(() => parseControlRequest({ ...body, allow_busy: 'true' })).toThrow('allow_busy');
    expect(() => parseControlRequest({ ...body, allow_busy: undefined })).toThrow('allow_busy');
    expect(() => parseControlRequest({ ...body, action: 'release', allow_busy: undefined })).toThrow('allow_busy');
  });

  it.each(['tenant_id', 'alias', 'mode', 'cols', 'rows', 'request_id', 'owner_token'])('still requires session field %s', (key) => {
    const body = Object.fromEntries(Object.entries(session()).filter(([field]) => field !== key));
    expect(() => parseSessionRequest(body)).toThrow('unexpected or missing fields');
  });

  it.each([
    { tenant_id: '' }, { alias: '' }, { alias: 'a'.repeat(65) }, { mode: 'other' },
    { cols: 19 }, { cols: 501 }, { rows: 4 }, { rows: 201 }, { cols: 20.5 },
    { request_id: 'invalid' }, { owner_token: 'invalid' },
  ])('preserves session bounds %j', (change) => {
    expect(() => parseSessionRequest({ ...session(), ...change })).toThrow();
  });

  it.each([
    { action: 'other' }, { authority_proof: '' }, { owner_generation: '0' },
    { owner_generation: '-1' }, { request_id: 'invalid' }, { owner_token: 'invalid' },
    { unexpected: true },
  ])('preserves control proof and owner bounds %j', (change) => {
    expect(() => parseControlRequest({ ...control(), ...change })).toThrow();
  });
});
