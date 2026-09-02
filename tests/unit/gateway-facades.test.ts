import { describe, expect, it } from 'vitest';
import type { Principal } from '../../services/gateway/src/auth.js';
import {
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
 * The invariant under test is the tenant boundary, not the column names: a principal who is
 * neither the sender nor a delivery recipient sees nothing, and a recipient sees only their own
 * delivery. Each of the three row shapes the store emits — `MessageListRow`, `MessageDetailRow`
 * and `QueueSnapshotItem` — names the same participants differently, so every group also proves
 * that the facade reading it does NOT accept the vocabulary of the other two.
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

interface Party { tenant: string; alias: string }
type Row = Record<string, unknown>;

const KANT: Party = { tenant: 'Steven', alias: 'kant' };
const ATLAS: Party = { tenant: 'Miguel', alias: 'atlas' };
const MIDAS: Party = { tenant: 'Pablo', alias: 'midas' };

function listRow(sender: Party, recipients: Party[]): Row {
  return {
    message_id: 'm-1',
    tenant_id: sender.tenant,
    actor_alias: sender.alias,
    body_preview: 'hola',
    deliveries: recipients.map((recipient, index) => ({
      delivery_id: `d-${String(index)}`,
      recipient_tenant: recipient.tenant,
      recipient_alias: recipient.alias,
      status: 'pending',
    })),
  };
}

function detailRow(sender: Party, recipients: Party[]): Row {
  return {
    id: 'm-1',
    tenant_id: sender.tenant,
    actor_alias: sender.alias,
    body: { text: 'hola' },
    deliveries: recipients.map((recipient, index) => ({
      delivery_id: `d-${String(index)}`,
      tenant_id: recipient.tenant,
      alias: recipient.alias,
      status: 'pending',
    })),
  };
}

function queueRow(sender: Party, recipient: Party, state: string): Row {
  return {
    delivery_id: 'q-1',
    message_id: 'm-1',
    tenant_id: recipient.tenant,
    recipient_alias: recipient.alias,
    message_tenant_id: sender.tenant,
    actor_alias: sender.alias,
    state,
  };
}

function items(value: Row): Row[] {
  return value.items as Row[];
}

function aliases(row: Row | undefined, key: string): unknown[] {
  return ((row?.deliveries ?? []) as Row[]).map((delivery) => delivery[key]);
}

describe('visibleMessageList (forma MessageListRow)', () => {
  it('el emisor recibe su mensaje con TODAS las entregas del fan-out', () => {
    const result = visibleMessageList({ items: [listRow(KANT, [ATLAS, MIDAS])] }, stevenKant);
    expect(items(result)).toHaveLength(1);
    expect(aliases(items(result)[0], 'recipient_alias')).toEqual(['atlas', 'midas']);
  });

  it('el destinatario recibe SOLO su propia entrega, no el resto del fan-out', () => {
    const result = visibleMessageList({ items: [listRow(ATLAS, [KANT, MIDAS])] }, stevenKant);
    expect(items(result)).toHaveLength(1);
    expect(aliases(items(result)[0], 'recipient_alias')).toEqual(['kant']);
  });

  it('quien no es emisor ni destinatario no ve ningún item', () => {
    const result = visibleMessageList({ items: [listRow(ATLAS, [MIDAS])] }, stevenKant);
    expect(items(result)).toHaveLength(0);
  });

  it('no acepta el vocabulario de la forma detalle en las entregas de la lista', () => {
    const swapped = { ...listRow(ATLAS, []), deliveries: (detailRow(ATLAS, [KANT]).deliveries) };
    expect(items(visibleMessageList({ items: [swapped] }, stevenKant))).toHaveLength(0);
  });

  it('un mismo alias de otro tenant no cuela como destinatario', () => {
    const result = visibleMessageList({
      items: [listRow(MIDAS, [{ tenant: 'Miguel', alias: 'kant' }])],
    }, stevenKant);
    expect(items(result)).toHaveLength(0);
  });

  it('devuelve items vacíos cuando `items` no es un array y conserva el resto', () => {
    const result = visibleMessageList({ items: 'no-array', extra: 1 }, stevenKant);
    expect(result.items).toEqual([]);
    expect(result.extra).toBe(1);
  });

  it('descarta entradas de items que no son objetos', () => {
    const result = visibleMessageList({
      items: ['string', null, listRow(KANT, []), 42],
    }, stevenKant);
    expect(items(result)).toHaveLength(1);
  });

  it('descarta entregas que no son objetos sin perder la fila visible', () => {
    const row = { ...listRow(ATLAS, [KANT]), deliveries: ['no-es-objeto', null, ...(listRow(ATLAS, [KANT]).deliveries as Row[])] };
    expect(items(visibleMessageList({ items: [row] }, stevenKant))).toHaveLength(1);
  });
});

describe('visibleMessage (forma MessageDetailRow)', () => {
  it('el emisor recibe el detalle con TODAS las entregas', () => {
    const result = visibleMessage(detailRow(KANT, [ATLAS, MIDAS]), stevenKant);
    expect(aliases(result, 'alias')).toEqual(['atlas', 'midas']);
  });

  it('el destinatario recibe SOLO su propia entrega', () => {
    const result = visibleMessage(detailRow(ATLAS, [KANT, MIDAS]), stevenKant);
    expect(aliases(result, 'alias')).toEqual(['kant']);
  });

  it('quien no es emisor ni destinatario no recibe nada', () => {
    expect(visibleMessage(detailRow(ATLAS, [MIDAS]), stevenKant)).toBeUndefined();
  });

  it('no acepta el vocabulario de la forma lista en las entregas del detalle', () => {
    const swapped = { ...detailRow(ATLAS, []), deliveries: (listRow(ATLAS, [KANT]).deliveries) };
    expect(visibleMessage(swapped, stevenKant)).toBeUndefined();
  });

  it('el mismo detalle es visible para su emisor y opaco para un tercero', () => {
    const row = detailRow(ATLAS, [{ tenant: 'Miguel', alias: 'janus' }, MIDAS]);
    expect(visibleMessage(row, miguelAtlas)).toBeDefined();
    expect(visibleMessage(row, stevenKant)).toBeUndefined();
  });

  it('devuelve la fila tal cual cuando el emisor no trae entregas materializadas', () => {
    const row = { ...detailRow(KANT, []), deliveries: null };
    expect(visibleMessage(row, stevenKant)).toMatchObject({ id: 'm-1' });
  });
});

describe('visibleQueue (forma QueueSnapshotItem)', () => {
  it('cuenta pending/retry/dead de las filas dirigidas al principal', () => {
    const out = visibleQueue({
      items: [
        queueRow(ATLAS, KANT, 'pending'),
        queueRow(ATLAS, KANT, 'leased'),
        queueRow(ATLAS, KANT, 'retry'),
        queueRow(ATLAS, KANT, 'dead'),
        queueRow(ATLAS, KANT, 'failed'),
      ],
    }, stevenKant);
    expect(out).toMatchObject({ pending: 2, retrying: 1, dead: 2 });
    expect(items(out)).toHaveLength(5);
  });

  it('cuenta también como pending los estados leased/accepted/started', () => {
    const out = visibleQueue({
      items: ['accepted', 'started', 'pending', 'retry'].map((state) => queueRow(ATLAS, KANT, state)),
    }, stevenKant);
    expect(out).toMatchObject({ pending: 3, retrying: 1, dead: 0 });
  });

  it('descarta la fila dirigida a otro tenant y RETIENE los totales con ella', () => {
    const out = visibleQueue({
      items: [queueRow(ATLAS, KANT, 'dead'), queueRow(ATLAS, MIDAS, 'dead')],
      totals: { pending: 10, retrying: 2, dead: 1847 },
      muestra_recortada: true,
    }, stevenKant);
    expect(items(out)).toHaveLength(1);
    expect(out.totals).toBeUndefined();
    expect(out.muestra_recortada).toBeUndefined();
    expect(out.dead).toBe(1);
  });

  it('avala los totales del store cuando no retuvo ninguna fila', () => {
    const out = visibleQueue({
      items: [queueRow(ATLAS, KANT, 'dead')],
      totals: { pending: 10, retrying: 2, dead: 1847 },
      muestra_recortada: true,
    }, stevenKant);
    expect(out.totals).toEqual({ pending: 10, retrying: 2, dead: 1847 });
    expect(out.muestra_recortada).toBe(true);
  });

  it('ve la fila que emitió aunque el destinatario sea otro', () => {
    const out = visibleQueue({
      items: [queueRow(KANT, ATLAS, 'pending'), queueRow(MIDAS, ATLAS, 'dead')],
    }, stevenKant);
    expect(items(out)).toHaveLength(1);
    expect(out).toMatchObject({ pending: 1, dead: 0 });
  });

  it('no acepta el vocabulario de los mensajes para identificar al destinatario', () => {
    const out = visibleQueue({
      items: [{ recipient_tenant: 'Steven', recipient_alias: 'kant', state: 'pending' }],
    }, stevenKant);
    expect(items(out)).toHaveLength(0);
    expect(out.pending).toBe(0);
  });

  it('devuelve items=[] y contadores en cero cuando items no es array', () => {
    const out = visibleQueue({ items: 'oops' }, stevenKant);
    expect(out).toMatchObject({ pending: 0, retrying: 0, dead: 0 });
    expect(out.items).toEqual([]);
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
    expect(items(result).every((item) => item.tenant_id === 'Steven')).toBe(true);
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
        { tenant_id: 'Steven', actor_alias: 'kant', recipient_tenant: 'Miguel', recipient_alias: 'atlas' },
        { tenant_id: 'Miguel', actor_alias: 'atlas', recipient_tenant: 'Pablo', recipient_alias: 'midas' },
      ],
    }, stevenKant);
    expect(result.items).toHaveLength(1);
    expect(items(result)[0]?.actor_alias).toBe('kant');
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
    expect(items(result)[0]?.tenant_id).toBe('Pablo');
  });

  it('incluye filas donde el principal es el destinatario (recipient_tenant/recipient_alias)', () => {
    const result = visibleOriginRelays({
      items: [
        { tenant_id: 'Miguel', actor_alias: 'atlas', recipient_tenant: 'Steven', recipient_alias: 'kant' },
        { tenant_id: 'Pablo', actor_alias: 'midas', recipient_tenant: 'Pablo', recipient_alias: 'midas' },
      ],
    }, stevenKant);
    expect(result.items).toHaveLength(1);
    expect(items(result)[0]?.actor_alias).toBe('atlas');
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