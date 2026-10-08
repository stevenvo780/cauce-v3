import { describe, expect, it, vi } from 'vitest';
import { peopleAdminClient, type PersonValues } from './people-admin-client';
import type { RequestFn } from './system-client';

const id = '11111111-1111-4111-8111-111111111111';
const revision = '1791321600123456';
const person = { id, email: 'one@example.test', display_name: 'Una persona', role: 'reader', tenant_id: 'A', alias: 'worker', active: true, revision };
const capabilities = { create: true, update: true, retire: true, restore: true, purge: true };
const input: PersonValues = { email: person.email, display_name: person.display_name, role: 'reader', tenant_id: 'A', alias: 'worker', active: true, password: 'private-password' };
function client(value: unknown) {
  const request = vi.fn(async () => value) as unknown as RequestFn;
  return { api: peopleAdminClient(request), request: vi.mocked(request) };
}
describe('people administration receipts', () => {
  it('reads explicit capabilities and refuses secret or duplicate rows', async () => {
    expect(await client({ items: [person], capabilities }).api.listPeople()).toEqual({ items: [person], capabilities });
    await expect(client({ items: [{ ...person, password: 'private-value' }], capabilities }).api.listPeople()).rejects.toThrow(/no acreditó/);
    await expect(client({ items: [person, person], capabilities }).api.listPeople()).rejects.toThrow(/no acreditó/);
    await expect(client({ items: [person], capabilities: { ...capabilities, create: 'true' } }).api.listPeople()).rejects.toThrow(/no acreditó/);
  });
  it('sends write-only password and exact microsecond CAS and rejects regressed receipts', async () => {
    const create = client(person);
    await create.api.createPerson(input);
    expect(JSON.parse(create.request.mock.calls[0]?.[1]?.body as string)).toEqual(input);
    const update = client({ ...person, display_name: 'Otro nombre', revision: '1791321600123457' });
    await update.api.updatePerson(id, revision, { display_name: 'Otro nombre' });
    expect(JSON.parse(update.request.mock.calls[0]?.[1]?.body as string)).toEqual({ expected_revision: revision, display_name: 'Otro nombre' });
    await expect(client(person).api.updatePerson(id, revision, { role: 'operator' })).rejects.toThrow(/no acreditó/);
    await expect(client({ ...person, id: '22222222-2222-4222-8222-222222222222', revision: '1791321600123457' }).api.retirePerson(id, revision)).rejects.toThrow(/no acreditó/);
  });
  it('checks retirement state and purge receipt against the removed revision', async () => {
    const retired = client({ ...person, active: false, revision: '1791321600123457' });
    expect((await retired.api.retirePerson(id, revision)).active).toBe(false);
    await expect(client({ ...person, revision: '1791321600123457' }).api.retirePerson(id, revision)).rejects.toThrow();
    const purged = client({ id, revision, purged: true });
    expect(await purged.api.purgePerson(id, revision)).toEqual({ id, revision, purged: true });
    await expect(client({ id, revision: '1791321600123457', purged: true }).api.purgePerson(id, revision)).rejects.toThrow();
  });
  it('rejects an injected patch before sending and maps server errors without exposing private messages', async () => {
    const controlled = client(person);
    await expect(controlled.api.updatePerson(id, revision, { expected_revision: '1' } as never)).rejects.toThrow();
    expect(controlled.request).not.toHaveBeenCalled();
    await controlled.api.createPerson(input);
    const mapper = controlled.request.mock.calls[0]?.[2]?.mapError;
    const mapped = mapper?.(409, { message: 'private-password' });
    if (!(mapped instanceof Error)) throw new Error('Expected a safe API error');
    expect(mapped.message).toContain('último administrador');
    expect(mapped.message).not.toContain('private-password');
  });
});
