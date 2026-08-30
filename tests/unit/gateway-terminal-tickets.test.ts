import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RESUME_HKDF_SALT, RESUME_TOKEN_VERSION, TICKET_HKDF_SALT, TICKET_VERSION,
  TicketError, deriveAliasKey, issueResumeToken, issueTicket, parseAndVerify,
  parseResumeToken, ticketDigest, ticketSha256, verifyResumeTokenSignature,
  verifyTicketSignature, type TicketPayload,
} from '../../services/gateway/src/terminal/tickets.js';

/**
 * Estrecha un opcional sin `!` ni `as`.
 *
 * Las dos reglas del preset se contradicen sobre un `T | undefined`: `no-non-null-assertion`
 * prohibe el `!` y `non-nullable-type-assertion-style` exige el `!` en lugar del `as`. La salida
 * no es elegir una, es no aseverar: si el valor falta, la prueba falla diciendo QUE falto, en vez
 * de reventar con «cannot read property of undefined».
 */
function exigir<T>(valor: T | undefined, que: string): T {
  if (valor === undefined) throw new Error(`se esperaba ${que} y no lo hubo`);
  return valor;
}

/**
 * Tests criptográficos herméticos para `services/gateway/src/terminal/tickets.ts`.
 *
 * El contrato del ticket PTY es compartido por tres implementaciones (gateway TS, terminal-relay
 * TS y pty-agent Python) y la única defensa común son estos vectores dorados. La lista de casos
 * sigue los `tests/terminal-pty/vectors.json` letra a letra: si el alias key, el orden de
 * claves del payload o un byte del HMAC cambia, el control de admisión del pty-agent aceptará
 * mañana una credencial forjada.
 *
 * Los vectores se FROZEN en este archivo: ningún test puede regenerarlos. Si cambia el contrato,
 * el fix correcto es regenerar las tres implementaciones en simultáneo y versionar `vectors.json`,
 * nunca ajustar el expected para que el assert siga verde.
 */

// Los tres valores siguientes vienen del contrato, no del harness. Se escriben como literales
// (no como copia de `vectors.json`) para que una "regeneración útil" del fichero no mueva el
// contrato en silencio.
const GOLDEN_MASTER = Buffer.from('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=', 'base64');
const GOLDEN_ALIAS_KEY_STEVEN_JARVIS = '33ab99cc766ee43031f9c22b8db78aeae5b04bc0ebedddfe8539330af7233efa';
const GOLDEN_ALIAS_KEY_STEVEN_KANT = 'c13362c6964d27b97b5af6d39b1f296b45256ada814babf03d49f7b115f49f3d';
const GOLDEN_ALIAS_KEY_MIGUEL_KRATOS = '38343b3ec054f31888da2867c237bc2d7743054dd24a7839f32c2f61409b37b5';
const GOLDEN_TICKET_STEVEN_JARVIS = 'v1.eyJ2IjoxLCJzaWQiOiIxMTExMTExMS0yMjIyLTMzMzMtNDQ0NC01NTU1NTU1NTU1NTUiLCJvcCI6InVuYXR0cmlidXRlZDpjb25zb2xlLWJhc2ljLWF1dGgiLCJzdWIiOiJTdGV2ZW46a2FudCIsInRndCI6eyJ0ZW5hbnQiOiJTdGV2ZW4iLCJhbGlhcyI6ImphcnZpcyIsImNvbnRhaW5lciI6ImNsYXciLCJnZW5lcmF0aW9uIjoiZ2VuLTEiLCJpbWFnZSI6InNoYTI1NjpkZWFkYmVlZiIsInVpZCI6MTAwMCwidXNlciI6ImNsYXcifSwibW9kZSI6InNoZWxsIiwiaWF0IjoxNzUwMDAwMDAwLCJleHAiOjE3NTAwMDAwMzB9.034UhsCFtCkD-mxdU51meZwH44SLyjrD1PT26ikM3iY';

function goldenPayload(): TicketPayload {
  return {
    v: 1,
    sid: '11111111-2222-3333-4444-555555555555',
    op: 'unattributed:console-basic-auth',
    sub: 'Steven:kant',
    tgt: {
      tenant: 'Steven',
      alias: 'jarvis',
      container: 'claw',
      generation: 'gen-1',
      image: 'sha256:deadbeef',
      uid: 1000,
      user: 'claw',
    },
    mode: 'shell',
    iat: 1_750_000_000,
    exp: 1_750_000_030,
  };
}

/** Voltea exactamente un bit del último byte de un HMAC SHA-256 codificado en base64url. */
function flipLastBit(signature: string): string {
  const decoded = Buffer.from(signature.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  const lastIndex = decoded.byteLength - 1;
  decoded[lastIndex] = (decoded[lastIndex] ?? 0) ^ 0x01;
  return decoded.toString('base64').replace(/=+$/, '').replaceAll('+', '-').replaceAll('/', '_');
}

describe('constantes exportadas del ticket', () => {
  it('la versión es la cadena literal "v1" y los sales HKDF son los del contrato v1', () => {
    expect(TICKET_VERSION).toBe('v1');
    expect(TICKET_HKDF_SALT).toBe('cauce-v3/pty-ticket/v1');
    expect(RESUME_TOKEN_VERSION).toBe('r1');
    expect(RESUME_HKDF_SALT).toBe('cauce-v3/pty-resume/v1');
  });
});

describe('deriveAliasKey: vectores dorados de HKDF', () => {
  it('reproduce byte a byte el alias key Steven:jarvis del contrato', () => {
    expect(deriveAliasKey(GOLDEN_MASTER, 'Steven', 'jarvis').toString('hex'))
      .toBe(GOLDEN_ALIAS_KEY_STEVEN_JARVIS);
  });

  it('reproduce byte a byte el alias key Steven:kant', () => {
    expect(deriveAliasKey(GOLDEN_MASTER, 'Steven', 'kant').toString('hex'))
      .toBe(GOLDEN_ALIAS_KEY_STEVEN_KANT);
  });

  it('reproduce byte a byte el alias key Miguel:kratos (aislamiento por tenant)', () => {
    expect(deriveAliasKey(GOLDEN_MASTER, 'Miguel', 'kratos').toString('hex'))
      .toBe(GOLDEN_ALIAS_KEY_MIGUEL_KRATOS);
  });

  it('keys distintas por (tenant, alias): un ticket para jarvis no sirve para kant', () => {
    const jarvis = deriveAliasKey(GOLDEN_MASTER, 'Steven', 'jarvis');
    const kant = deriveAliasKey(GOLDEN_MASTER, 'Steven', 'kant');
    expect(jarvis.equals(kant)).toBe(false);
    expect(jarvis.byteLength).toBe(32);
    expect(kant.byteLength).toBe(32);
  });

  it('mismo alias bajo dos tenants distintos produce keys distintas (SET RULE)', () => {
    const steven = deriveAliasKey(GOLDEN_MASTER, 'Steven', 'jarvis');
    const miguel = deriveAliasKey(GOLDEN_MASTER, 'Miguel', 'jarvis');
    expect(steven.equals(miguel)).toBe(false);
  });

  it('rechaza un master secret que no sean 32 bytes exactos', () => {
    expect(() => deriveAliasKey(Buffer.alloc(16), 'Steven', 'jarvis'))
      .toThrow(/master key must be 32 bytes/u);
    expect(() => deriveAliasKey(Buffer.alloc(64), 'Steven', 'jarvis'))
      .toThrow(/master key must be 32 bytes/u);
  });
});

describe('issueTicket: contrato de serialización canónica', () => {
  it('reproduce el ticket dorado Steven:jarvis byte a byte', () => {
    const key = Buffer.from(GOLDEN_ALIAS_KEY_STEVEN_JARVIS, 'hex');
    const ticket = issueTicket(goldenPayload(), key);
    expect(ticket).toBe(GOLDEN_TICKET_STEVEN_JARVIS);
  });

  it('el ticket empieza con la versión, contiene dos puntos y tres segmentos no vacíos', () => {
    const ticket = issueTicket(goldenPayload(), Buffer.from(GOLDEN_ALIAS_KEY_STEVEN_JARVIS, 'hex'));
    const parts = ticket.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(TICKET_VERSION);
    expect(exigir(parts[1], 'la segunda parte del billete').length).toBeGreaterThan(0);
    expect(exigir(parts[2], 'la tercera parte del billete').length).toBeGreaterThan(0);
    expect(ticket).toBe(`${exigir(parts[0], 'la primera parte')}.${exigir(parts[1], 'la segunda parte')}.${exigir(parts[2], 'la tercera parte')}`);
  });

  it('el mismo payload con otro alias key produce una firma distinta', () => {
    const jarvis = Buffer.from(GOLDEN_ALIAS_KEY_STEVEN_JARVIS, 'hex');
    const kant = Buffer.from(GOLDEN_ALIAS_KEY_STEVEN_KANT, 'hex');
    const jarvisTicket = issueTicket(goldenPayload(), jarvis);
    const kantTicket = issueTicket(goldenPayload(), kant);
    expect(jarvisTicket).not.toBe(kantTicket);
    expect(jarvisTicket.split('.')[1]).toBe(kantTicket.split('.')[1]);
    expect(jarvisTicket.split('.')[2]).not.toBe(kantTicket.split('.')[2]);
  });

  it('reproduce el ticket desde primitivas crudas como árbitro independiente del código', () => {
    const info = Buffer.from('pty:Steven:jarvis', 'utf8');
    const key = Buffer.from(hkdfSync('sha256', GOLDEN_MASTER, Buffer.from(TICKET_HKDF_SALT, 'utf8'), info, 32));
    const payloadJson = JSON.stringify(goldenPayload());
    const signingInput = `${TICKET_VERSION}.${Buffer.from(payloadJson, 'utf8').toString('base64').replace(/=+$/, '').replaceAll('+', '-').replaceAll('/', '_')}`;
    const mac = createHmac('sha256', key).update(Buffer.from(signingInput, 'ascii')).digest();
    const manual = `${signingInput}.${mac.toString('base64').replace(/=+$/, '').replaceAll('+', '-').replaceAll('/', '_')}`;
    expect(issueTicket(goldenPayload(), key)).toBe(manual);
  });
});

describe('verifyTicketSignature: invariantes criptográficas', () => {
  const key = Buffer.from(GOLDEN_ALIAS_KEY_STEVEN_JARVIS, 'hex');

  it('acepta un ticket recién firmado (round-trip) y decodifica los claims', () => {
    const ticket = issueTicket(goldenPayload(), key);
    const decoded = verifyTicketSignature(ticket, key);
    expect(decoded).toMatchObject({
      v: 1, sid: goldenPayload().sid, op: goldenPayload().op, sub: goldenPayload().sub,
      mode: 'shell', iat: 1_750_000_000, exp: 1_750_000_030,
      tgt: { tenant: 'Steven', alias: 'jarvis', container: 'claw', generation: 'gen-1',
        image: 'sha256:deadbeef', uid: 1000, user: 'claw' },
    });
  });

  it('rechaza con signature_invalid cuando se voltea un solo bit del HMAC', () => {
    const [version, encoded, signature] = GOLDEN_TICKET_STEVEN_JARVIS.split('.');
    const tampered = `${exigir(version, 'la versión del billete')}.${exigir(encoded, 'la carga codificada')}.${flipLastBit(exigir(signature, 'la firma'))}`;
    expect(() => verifyTicketSignature(tampered, key)).toThrow(TicketError);
    try {
      verifyTicketSignature(tampered, key);
    } catch (error) {
      expect(error).toBeInstanceOf(TicketError);
      expect((error as TicketError).reason).toBe('signature_invalid');
    }
  });

  it('rechaza con signature_invalid cuando el payload se manipula pero la firma queda igual', () => {
    // Vector dorado: mismo segmento de firma, segmento de payload con uid:0 (era 1000).
    const tamperedPayload = 'v1.eyJ2IjoxLCJzaWQiOiIxMTExMTExMS0yMjIyLTMzMzMtNDQ0NC01NTU1NTU1NTU1NTUiLCJvcCI6InVuYXR0cmlidXRlZDpjb25zb2xlLWJhc2ljLWF1dGgiLCJzdWIiOiJTdGV2ZW46a2FudCIsInRndCI6eyJ0ZW5hbnQiOiJTdGV2ZW4iLCJhbGlhcyI6ImphcnZpcyIsImNvbnRhaW5lciI6ImNsYXciLCJnZW5lcmF0aW9uIjoiZ2VuLTEiLCJpbWFnZSI6InNoYTI1NjpkZWFkYmVlZiIsInVpZCI6MCwidXNlciI6ImNsYXcifSwibW9kZSI6InNoZWxsIiwiaWF0IjoxNzUwMDAwMDAwLCJleHAiOjE3NTAwMDAwMzB9.034UhsCFtCkD-mxdU51meZwH44SLyjrD1PT26ikM3iY';
    expect(() => verifyTicketSignature(tamperedPayload, key)).toThrow(TicketError);
    try {
      verifyTicketSignature(tamperedPayload, key);
    } catch (error) {
      expect((error as TicketError).reason).toBe('signature_invalid');
    }
  });

  it('rechaza con signature_invalid cuando el ticket fue firmado con otro alias key', () => {
    // El ticket dorado de Steven:kant sobre el mismo payload; si lo verificamos con la key de
    // jarvis, la firma no coincide.
    const otherKey = Buffer.from(GOLDEN_ALIAS_KEY_STEVEN_KANT, 'hex');
    const foreignTicket = issueTicket(goldenPayload(), otherKey);
    expect(() => verifyTicketSignature(foreignTicket, key)).toThrow(TicketError);
    try {
      verifyTicketSignature(foreignTicket, key);
    } catch (error) {
      expect((error as TicketError).reason).toBe('signature_invalid');
    }
  });

  it('rechaza con malformed cuando la versión no es "v1"', () => {
    const [, encoded, signature] = GOLDEN_TICKET_STEVEN_JARVIS.split('.');
    const futureVersion = `v2.${exigir(encoded, 'la carga codificada')}.${exigir(signature, 'la firma')}`;
    expect(() => verifyTicketSignature(futureVersion, key)).toThrow(TicketError);
    try {
      verifyTicketSignature(futureVersion, key);
    } catch (error) {
      expect((error as TicketError).reason).toBe('malformed');
    }
  });

  it('rechaza con malformed un ticket con menos de tres segmentos', () => {
    const twoPart = `${TICKET_VERSION}.eyJ2IjoxfQ`;
    expect(() => verifyTicketSignature(twoPart, key)).toThrow(TicketError);
    try {
      verifyTicketSignature(twoPart, key);
    } catch (error) {
      expect((error as TicketError).reason).toBe('malformed');
    }
  });

  it('rechaza con malformed un segmento de payload con padding base64url (=)', () => {
    // El payload "{"v":1}" codificado con padding no es canónico; el parser exige forma estricta.
    const padded = `${TICKET_VERSION}.eyJ2IjoxfQ==.034UhsCFtCkD-mxdU51meZwH44SLyjrD1PT26ikM3iY`;
    expect(() => verifyTicketSignature(padded, key)).toThrow(TicketError);
  });

  it('rechaza con malformed un segmento que no es base64url válido', () => {
    const invalid = `${TICKET_VERSION}.!!!not-base64!!!.034UhsCFtCkD-mxdU51meZwH44SLyjrD1PT26ikM3iY`;
    expect(() => verifyTicketSignature(invalid, key)).toThrow(TicketError);
  });

  it('rechaza con malformed un payload que no es JSON', () => {
    // Encoda "not-json" en base64url canónico.
    const encoded = Buffer.from('not-json', 'utf8').toString('base64')
      .replace(/=+$/, '').replaceAll('+', '-').replaceAll('/', '_');
    const broken = `${TICKET_VERSION}.${encoded}.034UhsCFtCkD-mxdU51meZwH44SLyjrD1PT26ikM3iY`;
    expect(() => verifyTicketSignature(broken, key)).toThrow(TicketError);
  });

  it('rechaza con malformed un payload JSON que no es un objeto (es array)', () => {
    const encoded = Buffer.from('[1,2,3]', 'utf8').toString('base64')
      .replace(/=+$/, '').replaceAll('+', '-').replaceAll('/', '_');
    const signature = createHmac('sha256', key)
      .update(Buffer.from(`${TICKET_VERSION}.${encoded}`, 'ascii')).digest();
    const ticket = `${TICKET_VERSION}.${encoded}.${
      signature.toString('base64').replace(/=+$/, '').replaceAll('+', '-').replaceAll('/', '_')}`;
    expect(() => verifyTicketSignature(ticket, key)).toThrow(TicketError);
    try {
      verifyTicketSignature(ticket, key);
    } catch (error) {
      expect((error as TicketError).reason).toBe('malformed');
    }
  });

  it('rechaza con malformed un payload al que le falta un claim obligatorio', () => {
    // Sin iat: la firma es válida sobre los bytes que se firmaron, pero los claims son inválidos.
    const partial = JSON.stringify({ ...goldenPayload(), iat: undefined });
    const encoded = Buffer.from(partial, 'utf8').toString('base64')
      .replace(/=+$/, '').replaceAll('+', '-').replaceAll('/', '_');
    const signature = createHmac('sha256', key)
      .update(Buffer.from(`${TICKET_VERSION}.${encoded}`, 'ascii')).digest();
    const ticket = `${TICKET_VERSION}.${encoded}.${
      signature.toString('base64').replace(/=+$/, '').replaceAll('+', '-').replaceAll('/', '_')}`;
    expect(() => verifyTicketSignature(ticket, key)).toThrow(TicketError);
    try {
      verifyTicketSignature(ticket, key);
    } catch (error) {
      expect((error as TicketError).reason).toBe('malformed');
    }
  });
});

describe('parseAndVerify: ventana de validez', () => {
  const key = Buffer.from(GOLDEN_ALIAS_KEY_STEVEN_JARVIS, 'hex');

  it('acepta un ticket dentro de su ventana (iat < now < exp)', () => {
    const payload = parseAndVerify(GOLDEN_TICKET_STEVEN_JARVIS, key, 1_750_000_015);
    expect(payload.sid).toBe(goldenPayload().sid);
  });

  it('acepta el ticket un segundo antes de su exp (límite estricto: exp es exclusivo)', () => {
    expect(() => parseAndVerify(GOLDEN_TICKET_STEVEN_JARVIS, key, 1_750_000_029)).not.toThrow();
  });

  it('rechaza con expired el ticket un segundo después de su exp', () => {
    expect(() => parseAndVerify(GOLDEN_TICKET_STEVEN_JARVIS, key, 1_750_000_031))
      .toThrow(TicketError);
    try {
      parseAndVerify(GOLDEN_TICKET_STEVEN_JARVIS, key, 1_750_000_031);
    } catch (error) {
      expect((error as TicketError).reason).toBe('expired');
    }
  });

  it('rechaza con expired un ticket cuyo exp ya pasó al momento de emisión', () => {
    // Ticket dorado con exp:1749999960, ahora=1750000000 → claramente expirado.
    const expiredTicket = 'v1.eyJ2IjoxLCJzaWQiOiIxMTExMTExMS0yMjIyLTMzMzMtNDQ0NC01NTU1NTU1NTU1NTUiLCJvcCI6InVuYXR0cmlidXRlZDpjb25zb2xlLWJhc2ljLWF1dGgiLCJzdWIiOiJTdGV2ZW46a2FudCIsInRndCI6eyJ0ZW5hbnQiOiJTdGV2ZW4iLCJhbGlhcyI6ImphcnZpcyIsImNvbnRhaW5lciI6ImNsYXciLCJnZW5lcmF0aW9uIjoiZ2VuLTEiLCJpbWFnZSI6InNoYTI1NjpkZWFkYmVlZiIsInVpZCI6MTAwMCwidXNlciI6ImNsYXcifSwibW9kZSI6InNoZWxsIiwiaWF0IjoxNzQ5OTk5OTAwLCJleHAiOjE3NDk5OTk5NjB9.BBG_C9V7oWjmUv6oiKuWqN0whH7o_cCjqUM3hZglBfE';
    expect(() => parseAndVerify(expiredTicket, key, 1_750_000_000)).toThrow(TicketError);
    try {
      parseAndVerify(expiredTicket, key, 1_750_000_000);
    } catch (error) {
      expect((error as TicketError).reason).toBe('expired');
    }
  });
});

describe('ticketSha256 / ticketDigest: huellas durables', () => {
  it('ticketSha256 produce 32 bytes y es estable sobre el mismo ticket', () => {
    const digest = ticketSha256(GOLDEN_TICKET_STEVEN_JARVIS);
    expect(digest.byteLength).toBe(32);
    expect(digest.equals(ticketSha256(GOLDEN_TICKET_STEVEN_JARVIS))).toBe(true);
  });

  it('ticketDigest produce exactamente 16 caracteres hexadecimales y cambia con un byte del ticket', () => {
    const digest = ticketDigest(GOLDEN_TICKET_STEVEN_JARVIS);
    expect(digest).toMatch(/^[0-9a-f]{16}$/u);
    const tampered = `${GOLDEN_TICKET_STEVEN_JARVIS.slice(0, -1)}A`;
    expect(ticketDigest(tampered)).not.toBe(digest);
  });
});

describe('issueResumeToken / parseResumeToken: credencial de reanudación', () => {
  const master = Buffer.from('a'.repeat(32), 'utf8');

  it('emite y verifica un resume token: round-trip correcto', () => {
    const token = issueResumeToken(
      '11111111-2222-3333-4444-555555555555',
      'unattributed:console-basic-auth',
      1_800_000_000,
      master,
      1_750_000_000,
    );
    expect(token.startsWith(`${RESUME_TOKEN_VERSION}.`)).toBe(true);
    const decoded = verifyResumeTokenSignature(token, master);
    expect(decoded).toMatchObject({
      v: 1, sid: '11111111-2222-3333-4444-555555555555', op: 'unattributed:console-basic-auth',
      iat: 1_750_000_000, exp: 1_800_000_000,
    });
    expect(decoded.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/u);
  });

  it('cada emisión tiene un nonce distinto, así dos sesiones idénticas no colisionan', () => {
    const first = issueResumeToken('sid', 'op', 1_800_000_000, master, 1_750_000_000);
    const second = issueResumeToken('sid', 'op', 1_800_000_000, master, 1_750_000_000);
    expect(first).not.toBe(second);
    expect(verifyResumeTokenSignature(first, master).nonce).not.toBe(verifyResumeTokenSignature(second, master).nonce);
  });

  it('la key de resume se deriva de un dominio HKDF distinto al de tickets', () => {
    // Mismo master, info "resume-token" vs. "pty:<tenant>:<alias>" → keys diferentes.
    const resumeKey = Buffer.from(hkdfSync('sha256', master, Buffer.from(RESUME_HKDF_SALT, 'utf8'),
      Buffer.from('resume-token', 'utf8'), 32));
    const aliasKey = Buffer.from(hkdfSync('sha256', master, Buffer.from(TICKET_HKDF_SALT, 'utf8'),
      Buffer.from('pty:Steven:jarvis', 'utf8'), 32));
    expect(resumeKey.equals(aliasKey)).toBe(false);
  });

  it('verifyResumeTokenSignature rechaza un token firmado con otra master', () => {
    const token = issueResumeToken('sid', 'op', 1_800_000_000, master, 1_750_000_000);
    const otherMaster = randomBytes(32);
    expect(() => verifyResumeTokenSignature(token, otherMaster)).toThrow(TicketError);
  });

  it('verifyResumeTokenSignature rechaza una versión que no es r1', () => {
    const token = issueResumeToken('sid', 'op', 1_800_000_000, master, 1_750_000_000);
    const [, encoded, signature] = token.split('.');
    const wrongVersion = `r2.${exigir(encoded, 'la carga codificada')}.${exigir(signature, 'la firma')}`;
    expect(() => verifyResumeTokenSignature(wrongVersion, master)).toThrow(TicketError);
    try {
      verifyResumeTokenSignature(wrongVersion, master);
    } catch (error) {
      expect((error as TicketError).reason).toBe('malformed');
    }
  });

  it('parseResumeToken acepta un token dentro de su ventana y rechaza uno expirado', () => {
    const insideWindow = issueResumeToken('sid', 'op', 1_800_000_000, master, 1_750_000_000);
    expect(() => parseResumeToken(insideWindow, master, 1_790_000_000)).not.toThrow();
    expect(() => parseResumeToken(insideWindow, master, 1_800_000_001)).toThrow(TicketError);
    try {
      parseResumeToken(insideWindow, master, 1_800_000_001);
    } catch (error) {
      expect((error as TicketError).reason).toBe('expired');
    }
  });
});
