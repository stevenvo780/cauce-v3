import { z } from 'zod';
import type { DatabaseClient } from '@cauce/store';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../password.js';

const Email = z.string().trim().toLowerCase().email().max(254);
const Alias = z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/u);
const Tenant = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u);
const Name = z.string().trim().min(1).max(120).refine(value => Array.from(value).every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127));
const Password = z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH);
export const PeopleAdminIdSchema = z.uuid();
export const PeopleAdminRevisionSchema = z.string().regex(/^[1-9][0-9]{0,19}$/u).refine(value => BigInt(value) <= 9_223_372_036_854_775_807n);
const Fields = { email: Email, display_name: Name, role: z.enum(['operator', 'reader']), tenant_id: Tenant, alias: Alias, active: z.boolean() };
export const PeopleAdminCreateSchema = z.object({ ...Fields, password: Password }).strict();
export const PeopleAdminControlSchema = z.object({ expected_revision: PeopleAdminRevisionSchema }).strict();
export const PeopleAdminUpdateSchema = z.object({ ...Fields, password: Password }).partial().extend({ expected_revision: PeopleAdminRevisionSchema }).strict()
  .refine(value => Object.keys(value).some(key => key !== 'expected_revision'));
export const PeopleAdminPersonSchema = z.object({ id: PeopleAdminIdSchema, ...Fields, revision: PeopleAdminRevisionSchema }).strict();
export type PeopleAdminPerson = z.infer<typeof PeopleAdminPersonSchema>;
export type PeopleAdminCreate = z.infer<typeof PeopleAdminCreateSchema>;
export type PeopleAdminUpdate = z.infer<typeof PeopleAdminUpdateSchema>;
export type PeopleAdminControl = z.infer<typeof PeopleAdminControlSchema>;
export interface PeopleAdminActor {
  tenant_id: string; alias: string; subject: string; signal?: AbortSignal;
  humanAuthority(client: DatabaseClient): Promise<{ humanId: string; tenantId: string; actorAlias: string }>;
}
export const PEOPLE_ADMIN_CAPABILITIES = { create: true, update: true, retire: true, restore: true, purge: true } as const;
export const PeopleAdminListSchema = z.object({ items: z.array(PeopleAdminPersonSchema).max(1000).refine(items => new Set(items.map(item => item.id)).size === items.length),
  capabilities: z.object({ create: z.boolean(), update: z.boolean(), retire: z.boolean(), restore: z.boolean(), purge: z.boolean() }).strict() }).strict();
export const PeopleAdminPurgeSchema = z.object({ id: PeopleAdminIdSchema, revision: PeopleAdminRevisionSchema, purged: z.literal(true) }).strict();
export class PeopleAdminError extends Error {
  constructor(readonly code: 'invalid_request' | 'forbidden' | 'conflict' | 'not_found' | 'unverified') {
    super('human administration could not be verified');
  }
}
