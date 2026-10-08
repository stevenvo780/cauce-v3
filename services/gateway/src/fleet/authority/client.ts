import { request } from 'node:http';
import { z } from 'zod';
import { assertAuthoritySocket, type AuthoritySocketPolicy } from './socket.js';
import { AuthorityInventorySchema, AuthorityIssuedSchema, AuthorityRequestSchema, FleetAuthorityError,
  type AuthorityScope, type AuthorityIssue, type AuthorityInventoryPins, type AuthorityRequest } from './schemas.js';

const ErrorSchema = z.object({ error: z.enum(['INVALID_REQUEST', 'AUTHORITY_REVOKED', 'AUTHORITY_UNAVAILABLE']) }).strict();
export class FleetAuthorityClient {
  constructor(private readonly filename: string, private readonly policy: AuthoritySocketPolicy) {}
  async invoke(input: AuthorityRequest): Promise<unknown> {
    const value = AuthorityRequestSchema.parse(input);
    if (value.scope.host_id !== this.policy.host_id) throw new FleetAuthorityError('AUTHORITY_REVOKED');
    await assertAuthoritySocket(this.filename, this.policy);
    const body = JSON.stringify(value);
    return new Promise((resolve, reject) => {
      const unavailable = () => { reject(new FleetAuthorityError('AUTHORITY_UNAVAILABLE')); };
      const outgoing = request({ socketPath: this.filename, path: '/authority', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
        let bytes = 0; const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 262_144) { response.destroy(); unavailable(); } else chunks.push(chunk);
        });
        response.once('error', unavailable);
        response.once('end', () => {
          try {
            const output: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (response.statusCode !== 200) { reject(new FleetAuthorityError(ErrorSchema.parse(output).error)); return; }
            resolve(output);
          } catch { unavailable(); }
        });
      });
      outgoing.setTimeout(90_000, () => { outgoing.destroy(); unavailable(); });
      outgoing.once('error', unavailable); outgoing.end(body);
    });
  }
  async inventory(scope: AuthorityScope) { return AuthorityInventorySchema.parse(await this.invoke({ action: 'inventory', scope })); }
  async verifyAbsent(scope: AuthorityScope) { return AuthorityInventorySchema.parse(await this.invoke({ action: 'verify_absent', scope })); }
  async issue(scope: AuthorityScope, request: AuthorityIssue) { return AuthorityIssuedSchema.parse(await this.invoke({ action: 'issue', scope, ...request })); }
  async revoke(scope: AuthorityScope, expected_inventory: AuthorityInventoryPins) {
    return AuthorityInventorySchema.parse(await this.invoke({ action: 'revoke', scope, expected_inventory }));
  }
}
