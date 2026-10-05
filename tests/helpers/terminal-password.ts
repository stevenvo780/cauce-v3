import { randomBytes, randomUUID } from 'node:crypto';
import { withTransaction, type DatabasePool } from '@cauce/store';
import { createConsoleCredentialStamp } from '../../services/gateway/src/console-credential-stamp.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { PasswordAuthProvider, signConsoleSession } from '../../services/gateway/src/password-auth.js';
import { encodeTerminalSubject } from '../../services/gateway/src/terminal/authority-continuity.js';

type OperatorName = 'steven' | 'miguel';
interface FixtureAccount {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly sid: string;
  readonly csrf: string;
  readonly stamp: string;
}

export class TerminalPasswordFixture {
  readonly provider: PasswordAuthProvider;
  private readonly signingKey = randomBytes(32);
  private readonly issuedAtSeconds = Math.floor(Date.now() / 1_000);
  private readonly expiresAtSeconds = this.issuedAtSeconds + 8 * 3_600;
  private readonly roomId = `terminal-password-${randomUUID()}`;
  private readonly accounts: Readonly<Record<OperatorName, FixtureAccount>>;
  private readonly proofs = new Map<string, string>();
  private initialized = false;

  constructor(private readonly pool: DatabasePool) {
    const account = (email: string): FixtureAccount => {
      const id = randomUUID();
      const passwordHash = '$scrypt$' + randomBytes(32).toString('base64url');
      return { id, email, passwordHash, sid: randomBytes(24).toString('base64url'),
        csrf: randomBytes(24).toString('base64url'),
        stamp: createConsoleCredentialStamp(this.signingKey, {
          userId: id, passwordHash, passwordChangedAtUs: '0',
        }) };
    };
    this.accounts = { steven: account('steven@example.test'), miguel: account('miguel@example.test') };
    this.provider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool),
      signingKey: this.signingKey, sessionTtlMs: 8 * 3_600_000 });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await withTransaction(this.pool, async (client) => {
      for (const account of Object.values(this.accounts)) {
        await client.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,
          role,tenant_id,alias,active,password_changed_at)
          VALUES($1,$2,$2,$3,'Terminal fixture','operator','Steven','kant',true,'epoch')`,
        [account.id, account.email, account.passwordHash]);
        await client.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
          VALUES($1,'Steven','kant','operator',ARRAY['read','route','control'])`, [account.id]);
      }
      await client.query(`INSERT INTO rooms(id,tenant_id) VALUES($1,'Steven') ON CONFLICT DO NOTHING`, [this.roomId]);
      await client.query(`INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES
        ('Steven',$1,'kant','operator'),('Steven',$1,'jarvis','agent'),('Steven',$1,'socrates','agent')
        ON CONFLICT(tenant_id,room_id,alias) DO UPDATE SET enabled=true,role=EXCLUDED.role`, [this.roomId]);
    });
    this.initialized = true;
  }

  private account(name: string): FixtureAccount {
    if (name !== 'steven' && name !== 'miguel') throw new Error('unknown terminal fixture operator');
    return this.accounts[name];
  }

  cookie(name = 'steven'): string {
    const account = this.account(name);
    return `${this.provider.cookieName}=${signConsoleSession(this.signingKey, {
      iss: 'cauce-v3-gateway', aud: 'cauce-v3-console', sub: account.id, sid: account.sid,
      csrf: account.csrf, iat: this.issuedAtSeconds, exp: this.expiresAtSeconds, credential_stamp: account.stamp,
    })}`;
  }

  operator(name: string): string { return this.account(name).email; }

  subject(name = 'steven'): string {
    const account = this.account(name);
    return encodeTerminalSubject({ kind: 'human', humanId: account.id, loginSid: account.sid,
      credentialStamp: account.stamp, actor: { tenantId: 'Steven', alias: 'kant' },
      issuedAtSeconds: this.issuedAtSeconds, expiresAtSeconds: this.expiresAtSeconds });
  }

  remember(receipt: { session_id: string; authority_proof: string }): void {
    if (!receipt.authority_proof.startsWith('ac2.') || receipt.authority_proof.length > 4_096) {
      throw new Error('terminal receipt is missing its original authority proof');
    }
    const previous = this.proofs.get(receipt.session_id);
    if (previous !== undefined && previous !== receipt.authority_proof) {
      throw new Error('terminal receipt changed its original authority proof');
    }
    this.proofs.set(receipt.session_id, receipt.authority_proof);
  }

  proof(sid: string): string {
    const proof = this.proofs.get(sid);
    if (proof === undefined) throw new Error('terminal authority proof was not remembered');
    return proof;
  }
}
