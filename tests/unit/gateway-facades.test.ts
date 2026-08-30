import { describe, expect, it } from 'vitest';
import type { Principal } from '../../services/gateway/src/auth.js';
import {
  messageVisible,
  safeAuditPage,
  safeCancelReceipt,
  safeDlqPage,
  safeDlqResolution,
  safeReplayReceipt,
  sameTenantRows,
  visibleMessage,
  visibleMessageList,
  visibleOriginRelays,
  visibleQueue,
} from '../../services/gateway/src/facades.js';

/**
 * Tests for `services/gateway/src/facades.ts`.
 *
 * Coverage gap that motivated these tests: the `safe*Page`/`safe*Receipt` allowlist builders
 * were already exercised by `facades.dlq.test.ts`, and `visibleQueue` by `facades.test.ts`, but
 * the rest of the file — `messageVisible`, `visibleMessageList`, `visibleMessage`,
 * `sameTenantRows`, `visibleOriginRelays`, plus the `redactMessage` and `participant` helpers
 * reached through them — sat at 0 %. Each branch is exercised here without touching Postgres
 * (these are pure projection / visibility functions that consume already-shaped row objects).
 */

const stevenKant: Principal = {
  tenant_id: 'Steven',
  alias: 'kant',
  session_id: 's-steven',
  channel: 'console',
  roles: ['operator'],
  permissions: ['read'],
};

const miguelAtlas: Principal = {
  tenant_id: 'Miguel',
  alias: 'atlas',
  session_id: 's-miguel',
  channel: 'console',
  roles: ['operator'],
  permissions: ['read'],
};

function delivery(recipient: { tenant: string; alias: string }): Record<string, unknown> {
  return {
    recipient_tenant: recipient.tenant,
    recipient_alias: recipient.alias,
    state: 'pending',
  };
}

function visibleMessageRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    message_tenant_id: 'Steven',
    actor_alias: 'kant',
    body: 'hola',
    ...overrides,
  };
}

describe('messageVisible', () => {
  it('es visible cuando el principal es el emisor del mensaje', () => {
    const row = visibleMessageRow();
    expect(messageVisible(row, stevenKant)).toBe(true);
  });

  it('es visible cuando el principal aparece como participante de la conversación', () => {
    const row = {
      message_tenant_id: 'Miguel',
      actor_alias: 'atlas',
      participants: [{ tenant_id: 'Steven', alias: 'kant' }],
      deliveries: [delivery({ tenant: 'Pablo', alias: 'midas' })],
    };
    expect(messageVisible(row, stevenKant)).toBe(true);
  });

  it('es visible cuando el principal aparece en la lista de deliveries como destinatario', () => {
    const row = {
      message_tenant_id: 'Miguel',
      actor_alias: 'atlas',
      deliveries: [
        delivery({ tenant: 'Pablo', alias: 'midas' }),
        delivery({ tenant: 'Steven', alias: 'kant' }),
      ],
    };
    expect(messageVisible(row, stevenKant)).toBe(true);
  });

  it('NO es visible cuando el principal es ajeno a emisor, participantes y destinatarios', () => {
    const row = {
      message_tenant_id: 'Miguel',
      actor_alias: 'atlas',
      participants: [{ tenant_id: 'Pablo', alias: 'midas' }],
      deliveries: [delivery({ tenant: 'Pablo', alias: 'midas' })],
    };
    expect(messageVisible(row, stevenKant)).toBe(false);
  });

  it('reconoce al destinatario aunque la fila use `tenant_id`/`alias` sin prefijo recipient_', () => {
    const row = {
      message_tenant_id: 'Miguel',
      actor_alias: 'atlas',
      deliveries: [
        { tenant_id: 'Steven', alias: 'kant', state: 'pending' },
      ],
    };
    expect(messageVisible(row, stevenKant)).toBe(true);
  });

  it('descarta deliveries malformados que no son objetos (strings, nulls)', () => {
    const row = {
      message_tenant_id: 'Miguel',
      actor_alias: 'atlas',
      deliveries: [
        'no-es-objeto',
        null,
        delivery({ tenant: 'Steven', alias: 'kant' }),
      ],
    };
    expect(messageVisible(row, stevenKant)).toBe(true);
  });
});

describe('visibleMessageList', () => {
  it('filtra por visibilidad y redacta las deliveries que no me pertenecen', () => {
    const value = {
      items: [
        // Mensaje mío (Steven:kant) → no se redacta
        { message_tenant_id: 'Steven', actor_alias: 'kant', body: 'mio' },
        // Mensaje ajeno donde soy destinatario → visible y con deliveries filtradas
        {
          message_tenant_id: 'Miguel',
          actor_alias: 'atlas',
          body: 'para-kant',
          deliveries: [
            delivery({ tenant: 'Steven', alias: 'kant' }),
            delivery({ tenant: 'Pablo', alias: 'midas' }),
          ],
        },
        // Mensaje totalmente ajeno → descartado
        {
          message_tenant_id: 'Pablo',
          actor_alias: 'midas',
          deliveries: [delivery({ tenant: 'Pablo', alias: 'midas' })],
        },
      ],
    };

    const result = visibleMessageList(value, stevenKant);

    const items = result.items as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ message_tenant_id: 'Steven', actor_alias: 'kant' });
    const incoming = items[1] ?? {};
    const remaining = (incoming.deliveries as Record<string, unknown>[]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ recipient_tenant: 'Steven', recipient_alias: 'kant' });
  });

  it('devuelve items vacíos cuando `items` no es un array (no rompe)', () => {
    const result = visibleMessageList({ items: 'no-array', extra: 1 }, stevenKant);
    expect(result.items).toEqual([]);
    expect(result.extra).toBe(1);
  });

  it('descarta entradas de items que no son objetos', () => {
    const result = visibleMessageList({
      items: [
        'string',
        null,
        visibleMessageRow(), // mío
        42,
      ],
    }, stevenKant);
    expect(result.items).toHaveLength(1);
  });
});

describe('visibleMessage', () => {
  it('devuelve la fila redacted cuando el mensaje es visible', () => {
    const row = {
      message_tenant_id: 'Miguel',
      actor_alias: 'atlas',
      body: 'hola',
      deliveries: [
        delivery({ tenant: 'Steven', alias: 'kant' }),
        delivery({ tenant: 'Pablo', alias: 'midas' }),
      ],
    };
    const result = visibleMessage(row, stevenKant);
    expect(result).toBeDefined();
    const deliveries = (result as Record<string, unknown>).deliveries as Record<string, unknown>[];
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ recipient_tenant: 'Steven', recipient_alias: 'kant' });
  });

  it('devuelve undefined cuando el principal no es ni emisor ni participante ni destinatario', () => {
    const row = {
      message_tenant_id: 'Pablo',
      actor_alias: 'midas',
      deliveries: [delivery({ tenant: 'Pablo', alias: 'midas' })],
    };
    expect(visibleMessage(row, stevenKant)).toBeUndefined();
  });

  it('devuelve la fila SIN filtrar deliveries cuando el principal es el emisor', () => {
    const row = {
      message_tenant_id: 'Steven',
      actor_alias: 'kant',
      deliveries: [
        delivery({ tenant: 'Pablo', alias: 'midas' }),
        delivery({ tenant: 'Miguel', alias: 'atlas' }),
      ],
    };
    const result = visibleMessage(row, stevenKant);
    expect(result).toBeDefined();
    expect((result as Record<string, unknown>).deliveries).toHaveLength(2);
  });
});

describe('visibleQueue', () => {
  it('cuenta pending/retry/dead correctamente respetando visibilidad por destinatario', () => {
    const out = visibleQueue({
      items: [
        // Steven:kant (mío) - estados mezclados
        { recipient_tenant: 'Steven', recipient_alias: 'kant', state: 'pending' },
        { recipient_tenant: 'Steven', recipient_alias: 'kant', state: 'leased' },
        { recipient_tenant: 'Steven', recipient_alias: 'kant', state: 'retry' },
        { recipient_tenant: 'Steven', recipient_alias: 'kant', state: 'dead' },
        { recipient_tenant: 'Steven', recipient_alias: 'kant', state: 'failed' },
        // No míos - ignorados
        { recipient_tenant: 'Miguel', recipient_alias: 'atlas', state: 'pending' },
        { recipient_tenant: 'Pablo', recipient_alias: 'midas', state: 'dead' },
      ],
    }, stevenKant);
    expect(out).toMatchObject({ pending: 2, retrying: 1, dead: 2 });
    expect(out.items).toHaveLength(5);
  });

  it('cuenta también como pending los estados leased/accepted/started', () => {
    const out = visibleQueue({
      items: [
        { recipient_tenant: 'Steven', recipient_alias: 'kant', state: 'accepted' },
        { recipient_tenant: 'Steven', recipient_alias: 'kant', state: 'started' },
        { recipient_tenant: 'Steven', recipient_alias: 'kant', state: 'pending' },
        { recipient_tenant: 'Steven', recipient_alias: 'kant', state: 'retry' },
      ],
    }, stevenKant);
    expect(out).toMatchObject({ pending: 3, retrying: 1, dead: 0 });
  });

  it('devuelve items=[] y contadores en cero cuando items no es array', () => {
    const out = visibleQueue({ items: 'oops' }, stevenKant);
    expect(out).toMatchObject({ pending: 0, retrying: 0, dead: 0 });
    expect(out.items).toEqual([]);
  });

  it('cuenta filas mías porque soy el emisor aunque no sea el destinatario', () => {
    const out = visibleQueue({
      items: [
        // El principal Steven:kant emite el mensaje, recipient es otro.
        { message_tenant_id: 'Steven', actor_alias: 'kant', recipient_tenant: 'Miguel', recipient_alias: 'atlas', state: 'pending' },
        // El principal NO está ni como emisor ni como destinatario → fuera
        { message_tenant_id: 'Pablo', actor_alias: 'midas', recipient_tenant: 'Miguel', recipient_alias: 'atlas', state: 'dead' },
      ],
    }, stevenKant);
    expect(out.items).toHaveLength(1);
    expect(out.pending).toBe(1);
    expect(out.dead).toBe(0);
  });

  it('NO aplica el fallback de recipient_tenant a tenant_id cuando falta recipient_alias', () => {
    // queueRowVisible solo hace fallback de recipient_tenant (no de recipient_alias).
    // Una fila con sólo {tenant_id, alias} (sin prefijo recipient_) NO debe matchear.
    const out = visibleQueue({
      items: [
        { tenant_id: 'Steven', alias: 'kant', state: 'pending' },
      ],
    }, stevenKant);
    expect(out.items).toHaveLength(0);
    expect(out.pending).toBe(0);
  });
});

describe('sameTenantRows', () => {
  it('filtra dejando solo las filas del tenant del principal', () => {
    const result = sameTenantRows({
      items: [
        { tenant_id: 'Steven', alias: 'kant', count: 1 },
        { tenant_id: 'Miguel', alias: 'atlas', count: 2 },
        { tenant_id: 'Steven', alias: 'jarvis', count: 3 },
      ],
    }, stevenKant);
    expect(result.items).toHaveLength(2);
    expect((result.items as Record<string, unknown>[]).every(
      (item) => item.tenant_id === 'Steven',
    )).toBe(true);
  });

  it('preserva las claves top-level del value original (no las pisa)', () => {
    const result = sameTenantRows({
      nextCursor: 'abc',
      items: [{ tenant_id: 'Steven', alias: 'kant' }],
      total: 1,
    }, stevenKant);
    expect(result).toMatchObject({ nextCursor: 'abc', total: 1 });
  });

  it('devuelve items vacío cuando items no es array y conserva el resto', () => {
    const result = sameTenantRows({ items: 'oops', total: 0 }, stevenKant);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });
});

describe('visibleOriginRelays', () => {
  it('incluye filas cuyo emisor coincide con el principal', () => {
    const result = visibleOriginRelays({
      items: [
        // Steven:kant es emisor → visible
        { tenant_id: 'Steven', actor_alias: 'kant', recipient_tenant: 'Miguel', recipient_alias: 'atlas' },
        // Steven:kant NO es ni emisor ni participant ni recipient → fuera
        { tenant_id: 'Miguel', actor_alias: 'atlas', recipient_tenant: 'Pablo', recipient_alias: 'midas' },
      ],
    }, stevenKant);
    expect(result.items).toHaveLength(1);
    expect((result.items as Record<string, unknown>[])[0]?.actor_alias).toBe('kant');
  });

  it('incluye filas donde el principal figura como participante', () => {
    const result = visibleOriginRelays({
      items: [
        {
          tenant_id: 'Pablo', actor_alias: 'midas',
          participants: [{ tenant_id: 'Steven', alias: 'kant' }],
          recipient_tenant: 'Miguel', recipient_alias: 'atlas',
        },
        { tenant_id: 'Miguel', actor_alias: 'atlas', recipient_tenant: 'Pablo', recipient_alias: 'midas' },
      ],
    }, stevenKant);
    expect(result.items).toHaveLength(1);
    expect((result.items as Record<string, unknown>[])[0]?.tenant_id).toBe('Pablo');
  });

  it('incluye filas donde el principal es el destinatario (recipient_tenant/recipient_alias)', () => {
    const result = visibleOriginRelays({
      items: [
        { tenant_id: 'Miguel', actor_alias: 'atlas', recipient_tenant: 'Steven', recipient_alias: 'kant' },
        { tenant_id: 'Pablo', actor_alias: 'midas', recipient_tenant: 'Pablo', recipient_alias: 'midas' },
      ],
    }, stevenKant);
    expect(result.items).toHaveLength(1);
    expect((result.items as Record<string, unknown>[])[0]?.actor_alias).toBe('atlas');
  });

  it('descarta entradas que no son objetos y conserva la estructura externa', () => {
    const result = visibleOriginRelays({
      items: [
        'no-object',
        null,
        { tenant_id: 'Steven', actor_alias: 'kant', recipient_tenant: 'Miguel', recipient_alias: 'atlas' },
        { tenant_id: 'Miguel', actor_alias: 'atlas', recipient_tenant: 'Steven', recipient_alias: 'kant' },
      ],
      nextCursor: 'abc',
    }, stevenKant);
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBe('abc');
  });

  it('rechaza con items vacío cuando items no es array', () => {
    const result = visibleOriginRelays({ items: undefined }, stevenKant);
    expect(result.items).toEqual([]);
  });
});

describe('principales cruzados: stevenKant NO debe ver mensajes de miguelAtlas', () => {
  it('una fila de Miguel:atlas no es visible para Steven:kant por ninguna vía', () => {
    const row = {
      message_tenant_id: 'Miguel',
      actor_alias: 'atlas',
      deliveries: [
        { recipient_tenant: 'Miguel', recipient_alias: 'janus', state: 'pending' },
        { recipient_tenant: 'Pablo', recipient_alias: 'midas', state: 'pending' },
      ],
      participants: [{ tenant_id: 'Pablo', alias: 'midas' }],
    };
    expect(messageVisible(row, stevenKant)).toBe(false);
    expect(visibleMessage(row, stevenKant)).toBeUndefined();
  });

  it('la misma fila sí es visible para miguelAtlas (su propio emisor)', () => {
    const row = {
      message_tenant_id: 'Miguel',
      actor_alias: 'atlas',
      deliveries: [
        { recipient_tenant: 'Miguel', recipient_alias: 'janus', state: 'pending' },
      ],
    };
    expect(messageVisible(row, miguelAtlas)).toBe(true);
  });
});

describe('safeAuditPage (allowlist del audit cross-tenant)', () => {
  it('proyecta cada fila con campos validados y refleja cursor cuando es válido', () => {
    const page = safeAuditPage({
      next_cursor: '4242',
      items: [{
        event_id: '18',
        at: '2026-08-26T08:00:00.000Z',
        tenant_id: 'Miguel',
        actor_alias: 'atlas',
        action: 'delivery.ack',
        decision: 'info',
        request_id: null,
        trace_id: 'trace-1',
        summary: JSON.stringify({ ack: 'done' }),
      }],
    });
    const auditItems = page.items as Record<string, unknown>[];
    expect(page.next_cursor).toBe('4242');
    expect(auditItems[0]).toMatchObject({
      event_id: '18',
      tenant_id: 'Miguel',
      actor_alias: 'atlas',
      action: 'delivery.ack',
      decision: 'info',
      request_id: null,
      trace_id: 'trace-1',
    });
    expect(JSON.parse(auditItems[0]?.summary as string)).toEqual({ ack: 'done' });
  });

  it('rechaza identificadores malformados y resume cualquier summary a null si no es JSON', () => {
    const page = safeAuditPage({
      next_cursor: '99',
      items: [{
        event_id: 'x',
        at: 'x'.repeat(65),
        tenant_id: 'tenant'.padEnd(129, 'x'),
        actor_alias: 7,
        action: 'BAD ACTION',
        decision: 'allowed',
        request_id: 'not-a-uuid',
        trace_id: 'x'.repeat(257),
        summary: 'no-es-json',
      }],
    });
    expect(page.next_cursor).toBe('99');
    const badItems = page.items as Record<string, unknown>[];
    const item = badItems[0] ?? {};
    expect(item).toMatchObject({
      event_id: null,
      at: null,
      tenant_id: null,
      actor_alias: null,
      action: null,
      decision: null,
      request_id: null,
      trace_id: null,
      summary: null,
    });
  });

  it('descarta items que no son objetos y devuelve items vacío cuando page no es objeto', () => {
    const empty = safeAuditPage(null);
    expect(empty.items).toEqual([]);
    expect(empty.next_cursor).toBeNull();

    const filtered = safeAuditPage({
      next_cursor: '99',
      items: ['string', null, { event_id: '1', action: 'a.b', decision: 'allow' }],
    });
    expect(filtered.items).toHaveLength(1);
  });
});

describe('safeDlqPage (allowlist del DLQ para el navegador)', () => {
  it('proyecta una fila válida conservando solo los campos causales permitidos', () => {
    const page = safeDlqPage({
      schemaVersion: 1,
      total: 1,
      truncated: false,
      nextCursor: 'abcd',
      items: [{
        target: 'outbox',
        id: '70000000-0000-4000-8000-000000000001',
        tenantId: 'Steven',
        kind: 'origin_relay',
        adapter: 'telegram',
        disposition: 'ambiguous',
        open: true,
        actionable: true,
        evidenceSha256: 'a'.repeat(64),
        attempts: 3,
        resolutionRule: 'telegram_effect_ambiguous_v1',
        createdAt: '2026-08-26T00:00:00.000Z',
        dispositionAt: null,
        resolvedAt: null,
        reopenCount: 0,
        lastReopenedAt: null,
      }],
    });
    expect(page).toMatchObject({
      schemaVersion: 1,
      total: 1,
      truncated: false,
      nextCursor: 'abcd',
    });
    expect(page.items).toHaveLength(1);
  });

  it('normaliza campos con tipos o longitudes inválidos a null', () => {
    const page = safeDlqPage({
      schemaVersion: 2,
      total: -1,
      truncated: 'no',
      nextCursor: 'NOT_HEX',
      items: [{
        target: 'unknown',
        id: 'no-uuid',
        tenantId: 'a'.repeat(200),
        kind: 7,
        adapter: [],
        disposition: 'foo',
        open: 1,
        actionable: 'true',
        evidenceSha256: 'a'.repeat(65),
        attempts: Number.POSITIVE_INFINITY,
        resolutionRule: 'NO-RULE',
        createdAt: 7,
        dispositionAt: 'x'.repeat(100),
        resolvedAt: null,
        reopenCount: -3,
        lastReopenedAt: undefined,
      }],
    });
    expect(page.schemaVersion).toBeNull();
    expect(page.total).toBeNull();
    expect(page.truncated).toBeNull();
    expect(page.nextCursor).toBeNull();
    const dlqItems = page.items as Record<string, unknown>[];
    const item = dlqItems[0] ?? {};
    expect(item.target).toBeNull();
    expect(item.id).toBeNull();
    expect(item.tenantId).toBeNull();
    expect(item.kind).toBeNull();
    expect(item.adapter).toBeNull();
    expect(item.disposition).toBeNull();
    expect(item.open).toBeNull();
    expect(item.actionable).toBeNull();
    expect(item.evidenceSha256).toBeNull();
    expect(item.attempts).toBeNull();
    expect(item.resolutionRule).toBeNull();
    expect(item.createdAt).toBeNull();
    expect(item.dispositionAt).toBeNull();
    expect(item.reopenCount).toBeNull();
  });

  it('acepta nextCursor hex de longitud par entre 2 y 1024', () => {
    expect(safeDlqPage({ nextCursor: 'ab12', items: [] }).nextCursor).toBe('ab12');
    expect(safeDlqPage({ nextCursor: 'a'.repeat(1024), items: [] }).nextCursor).toBe('a'.repeat(1024));
    expect(safeDlqPage({ nextCursor: 'a', items: [] }).nextCursor).toBeNull();
    expect(safeDlqPage({ nextCursor: 'a'.repeat(1025), items: [] }).nextCursor).toBeNull();
    expect(safeDlqPage({ nextCursor: 'ab', items: [] }).nextCursor).toBe('ab');
    expect(safeDlqPage({ nextCursor: 'abc', items: [] }).nextCursor).toBeNull();
  });

  it('devuelve estructura vacía cuando page no es objeto o items no es array', () => {
    expect(safeDlqPage(undefined).items).toEqual([]);
    expect(safeDlqPage({ items: 'oops' }).items).toEqual([]);
    expect(safeDlqPage({ items: ['no-object', null] }).items).toEqual([]);
  });
});

describe('safeDlqResolution (acuse de no-replay)', () => {
  it('proyecta el acuse completo cuando los campos cumplen el contrato', () => {
    const result = safeDlqResolution({
      schemaVersion: 1,
      suite: 'cauce-v3-dlq-no-replay-resolution',
      phase: 'resolved',
      appliedCount: 1,
      alreadyApplied: false,
      evidenceSha256: 'a'.repeat(64),
      reasonSha256: 'b'.repeat(64),
      possibleDuplicateAcknowledged: true,
      possibleNoDeliveryAcknowledged: false,
    });
    expect(result).toEqual({
      schemaVersion: 1,
      suite: 'cauce-v3-dlq-no-replay-resolution',
      phase: 'resolved',
      appliedCount: 1,
      alreadyApplied: false,
      evidenceSha256: 'a'.repeat(64),
      reasonSha256: 'b'.repeat(64),
      possibleDuplicateAcknowledged: true,
      possibleNoDeliveryAcknowledged: false,
    });
  });

  it('normaliza suite/phase/schemaVersion/appliedCount a null cuando no encajan', () => {
    const result = safeDlqResolution({
      schemaVersion: 2,
      suite: 'otra-suite',
      phase: 'failed',
      appliedCount: -1,
      alreadyApplied: 'true',
      evidenceSha256: 'a'.repeat(65),
      reasonSha256: null,
      possibleDuplicateAcknowledged: 'yes',
      possibleNoDeliveryAcknowledged: 1,
    });
    expect(result).toEqual({
      schemaVersion: null,
      suite: null,
      phase: null,
      appliedCount: null,
      alreadyApplied: null,
      evidenceSha256: null,
      reasonSha256: null,
      possibleDuplicateAcknowledged: null,
      possibleNoDeliveryAcknowledged: null,
    });
  });
});

describe('safeReplayReceipt (acuse de replay durable)', () => {
  it('proyecta el acuse válido con delivery_id/replayed_from_delivery_id como UUIDs', () => {
    const result = safeReplayReceipt({
      delivery_id: '70000000-0000-4000-8000-000000000001',
      replayed_from_delivery_id: '70000000-0000-4000-8000-000000000002',
      state: 'pending',
      replayed: true,
    });
    expect(result).toEqual({
      delivery_id: '70000000-0000-4000-8000-000000000001',
      replayed_from_delivery_id: '70000000-0000-4000-8000-000000000002',
      state: 'pending',
      replayed: true,
    });
  });

  it('fails closed cuando delivery_id o state no encajan en el contrato', () => {
    const result = safeReplayReceipt({
      delivery_id: 'not-uuid',
      replayed_from_delivery_id: '70000000-0000-4000-8000-000000000002',
      state: 'done',
      replayed: 'yes',
    });
    expect(result).toEqual({
      delivery_id: null,
      replayed_from_delivery_id: '70000000-0000-4000-8000-000000000002',
      state: null,
      replayed: null,
    });
  });
});

describe('safeCancelReceipt (acuse de cancelación sin reason)', () => {
  it('proyecta la cancelación válida con parent_notice y cancelled_from_state dentro del set', () => {
    const result = safeCancelReceipt({
      delivery_id: '70000000-0000-4000-8000-000000000001',
      state: 'dead',
      cancelled: true,
      cancelled_from_state: 'started',
      parent_notice: 'returned',
      origin_relayed: true,
      replayable: false,
    });
    expect(result).toEqual({
      delivery_id: '70000000-0000-4000-8000-000000000001',
      state: 'dead',
      cancelled: true,
      cancelled_from_state: 'started',
      parent_notice: 'returned',
      origin_relayed: true,
      replayable: false,
    });
  });

  it('normaliza cancelled_from_state y parent_notice a null cuando no son del set', () => {
    const result = safeCancelReceipt({
      delivery_id: '70000000-0000-4000-8000-000000000001',
      state: 'dead',
      cancelled: true,
      cancelled_from_state: 'bogus-state',
      parent_notice: 'bogus-notice',
      origin_relayed: 'no',
      replayable: 'no',
    });
    expect(result.cancelled_from_state).toBeNull();
    expect(result.parent_notice).toBeNull();
    expect(result.origin_relayed).toBeNull();
    expect(result.replayable).toBeNull();
  });
});