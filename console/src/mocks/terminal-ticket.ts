/** Structurally valid v1 ticket for browser contract tests and the opt-in demo backend. */
function mockTerminalTicket(input: {
  sessionId: string;
  tenantId: string;
  alias: string;
  container: string;
  runtimeUser: string;
  mode: string;
  expiresAt: string;
  ttlSeconds: number;
}): string {
  const exp = Math.floor(Date.parse(input.expiresAt) / 1_000);
  const payload = JSON.stringify({
    v: 1,
    sid: input.sessionId,
    op: 'console-test-operator',
    sub: `${input.tenantId}:test-operator`,
    tgt: {
      tenant: input.tenantId,
      alias: input.alias,
      container: input.container,
      generation: 'test-generation',
      image: 'sha256:test-image',
      uid: 1_000,
      user: input.runtimeUser,
    },
    mode: input.mode,
    iat: exp - input.ttlSeconds,
    exp,
  });
  const encoded = globalThis.btoa(String.fromCharCode(...new TextEncoder().encode(payload)))
    .replace(/=+$/u, '').replaceAll('+', '-').replaceAll('/', '_');
  // The browser enforces only the canonical 32-byte HMAC shape; signature verification belongs to the gateway/relay.
  const structuralSignature = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  return `v1.${encoded}.${structuralSignature}`;
}

function base64url(value: string): string {
  return globalThis.btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    .replace(/=+$/u, '').replaceAll('+', '-').replaceAll('/', '_');
}

/** The `ready` resume token the console accepts: a legacy r1 token wrapped with the grant's authority proof. */
export function mockAuthorityResumeToken(sessionId: unknown, authorityProof: unknown): string {
  const legacyPayload = JSON.stringify({ v: 1, sid: sessionId, op: 'fixture-operator', iat: 1_750_000_000,
    exp: 1_750_003_600, nonce: 'A'.repeat(22) });
  const legacy = `r1.${base64url(legacyPayload)}.${'A'.repeat(43)}`;
  return `r2.${base64url(JSON.stringify([legacy, authorityProof]))}`;
}

function mockAuthorityProof(input: { sessionId: string; tenantId: string; requestId: string }): string {
  const origin = {
    kind: 'human',
    humanId: '33333333-3333-4333-8333-333333333333',
    loginSid: 'mock-console-session-1234',
    actor: { tenantId: input.tenantId, alias: 'test-operator' },
    credentialStamp: 'A'.repeat(43),
    issuedAtSeconds: 1_750_000_000,
    expiresAtSeconds: 1_750_003_600,
  };
  const payload = JSON.stringify({ version: 2, sessionId: input.sessionId, requestId: input.requestId,
    semanticDigest: 'a'.repeat(64), origin });
  const encoded = globalThis.btoa(String.fromCharCode(...new TextEncoder().encode(payload)))
    .replace(/=+$/u, '').replaceAll('+', '-').replaceAll('/', '_');
  return `ac2.${encoded}.${'A'.repeat(43)}`;
}

export function mockTerminalGrant(input: {
  sessionId: string;
  tenantId: string;
  alias: string;
  mode: string;
  container?: string;
  runtimeUser?: string;
  ttlSeconds?: number;
  expiresAt?: string;
  receiptRecovered?: boolean;
  requestId?: string;
  ownerGeneration?: string;
  sharesContainerWith?: { tenant_id: string; alias: string }[];
}): Record<string, unknown> {
  const container = input.container ?? 'test-container';
  const runtimeUser = input.runtimeUser ?? 'dev';
  const ttlSeconds = input.ttlSeconds ?? 30;
  const expiresAt = input.expiresAt ?? new Date(Date.now() + ttlSeconds * 1_000).toISOString();
  return {
    session_id: input.sessionId,
    authority_proof: mockAuthorityProof({ sessionId: input.sessionId, tenantId: input.tenantId,
      requestId: input.requestId ?? '11111111-1111-4111-8111-111111111111' }),
    ticket: mockTerminalTicket({
      sessionId: input.sessionId,
      tenantId: input.tenantId,
      alias: input.alias,
      container,
      runtimeUser,
      mode: input.mode,
      expiresAt,
      ttlSeconds,
    }),
    websocket_path: '/v3/console/terminal/ws',
    expires_at: expiresAt,
    ttl_seconds: ttlSeconds,
    receipt_recovered: input.receiptRecovered ?? false,
    request_id: input.requestId ?? '11111111-1111-4111-8111-111111111111',
    owner_generation: input.ownerGeneration ?? '1',
    target: {
      tenant_id: input.tenantId,
      alias: input.alias,
      container,
      runtime_user: runtimeUser,
      mode: input.mode,
      shares_container_with: input.sharesContainerWith ?? [],
    },
  };
}
