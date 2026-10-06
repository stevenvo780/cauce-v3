import { z } from 'zod';
import { UUID_ANY_PATTERN } from '../patterns.js';
import { TenantSchema } from './core.js';

export const HUMAN_CLIENT_PROVENANCE_CAPABILITY = 'human_message_client_provenance_v1' as const;
export const HUMAN_CLIENT_DELEGATION_CAPABILITY = 'human_message_client_delegation_v1' as const;
export const ClientDelegationLabelSchema = z.string().min(1).max(128)
  .refine((value) => value.normalize('NFC') === value && !/[^A-Za-z0-9 ._-]/u.test(value)
    && /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]*[A-Za-z0-9])?$/u.test(value));
const PublicClientIdSchema = z.string().min(1)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 2048 && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127));
export const ClientProvenanceWireSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unknown') }).strict(),
  z.object({ kind: z.literal('oauth_client'), verification: z.literal('local_grant'),
    issuer: PublicClientIdSchema, client_id: PublicClientIdSchema, instance: z.literal('unknown') }).strict(),
]);
export const HumanClientProvenanceSchema = z.object({
  root_message_id: z.string().regex(UUID_ANY_PATTERN), client: ClientProvenanceWireSchema,
}).strict();
export const HumanClientDelegationSchema = z.object({
  root_message_id: z.string().regex(UUID_ANY_PATTERN), owner_human_id: z.string().regex(UUID_ANY_PATTERN),
  owner_tenant_id: TenantSchema, label: ClientDelegationLabelSchema,
  basis: z.literal('owner_declared_grant'), instance: z.literal('unknown'),
}).strict();
