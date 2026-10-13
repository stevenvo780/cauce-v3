import { describe, expect, it } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { PeopleAdminRepository } from './people-admin-store.js';
import { PeopleAdminError, type PeopleAdminActor } from './people-admin-schema.js';

describe('people administration database contention', () => {
  it.each(['55P03', '40001', '40P01'])('maps %s to a typed conflict without exposing driver details', async code => {
    const pool = { connect: async () => { throw Object.assign(new Error('private driver details'), { code }); } } as unknown as DatabasePool;
    const actor = { tenant_id: 'Fixture', alias: 'fixture', subject: 'fixture' } as PeopleAdminActor;
    const operation = new PeopleAdminRepository(pool).list(actor);
    await expect(operation).rejects.toBeInstanceOf(PeopleAdminError);
    await expect(operation).rejects.toMatchObject({ code: 'conflict', message: 'human administration could not be verified' });
  });
});
