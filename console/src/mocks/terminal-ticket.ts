/** Structurally valid v1 ticket for browser contract tests and the opt-in demo backend. */
export function mockTerminalTicket(input: {
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
  // The browser cannot verify this segment; it only enforces canonical 32-byte HMAC shape. The
  // gateway/relay own signature verification, and no production code imports this fixture.
  const structuralSignature = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  return `v1.${encoded}.${structuralSignature}`;
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
