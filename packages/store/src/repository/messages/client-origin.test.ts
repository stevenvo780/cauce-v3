import { describe, expect, it } from 'vitest';
import { withMessageAuthor } from './author.js';

const client = { kind: 'oauth_client', verification: 'local_grant', issuer: 'https://cauce.example',
  client_id: 'https://chatgpt.com/oauth/client.json', instance: 'unknown' };
const origin = { client, delegation_label: 'Cronos' };
const author = { kind: 'human', subject_id: `human:${'a'.repeat(64)}`, display_name: 'Steven' };

describe('message client origin projection', () => {
  it('copies bounded server metadata without replacing its human author or routing identity', () => {
    const result = withMessageAuthor({ actor_alias: 'kant', author, client_origin: origin });
    expect(result).toMatchObject({ actor_alias: 'kant', author, client_origin: origin });
    expect(result.client_origin).not.toBe(origin);
    expect(result.client_origin.client).not.toBe(client);
  });

  it.each([
    { ...origin, grant_id: 'private' },
    { ...origin, delegation_label: ' forged ' },
    { ...origin, client: { ...client, instance: 'verified' } },
    { ...origin, client: { ...client, access_token: 'private' } },
    { client: { kind: 'unknown' }, delegation_label: 'Cronos' },
    { ...origin, client: { ...client, verification: 'self_declared' } },
  ])('discards invalid metadata without manufacturing a client identity: %j', bad => {
    expect(withMessageAuthor({ author, client_origin: bad }).client_origin).toBeNull();
  });

  it('never infers a client from a message body, origin, tenant or alias', () => {
    const result = withMessageAuthor({ author, tenant_id: 'Steven', actor_alias: 'kant',
      body: { client_origin: origin }, origin: { metadata: { client_origin: origin } } });
    expect(result).not.toHaveProperty('client_origin');
  });

  it('preserves an explicitly unknown client without accepting a declared label', () => {
    const unknown = { client: { kind: 'unknown' }, delegation_label: null };
    expect(withMessageAuthor({ author, client_origin: unknown }).client_origin).toEqual(unknown);
  });
});
