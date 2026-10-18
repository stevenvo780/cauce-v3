import {
  type Tenant
} from '@cauce/protocol';
import { describe, expect, it } from 'vitest';
import { planArtifacts } from '../src/artifacts.js';
import { TelegramEgressWorker } from '../src/egress.js';
import { TelegramApiError } from '../src/telegram.js';
import type {
  TelegramAliasConfig, TelegramApi, TelegramEffect, TelegramEffectInput, TelegramEgressRepository,
  TelegramOriginRelay, TelegramOriginRelayAck, TelegramSendResult, TelegramUpload
} from '../src/types.js';
import { noopActivity, noopObserver } from './bridge-fixtures.js';

/** Real 1x1 PNG: end-to-end byte path probe. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const PNG_DATA_URI = `data:image/png;base64,${PNG.toString('base64')}`;

function payload(artifacts: unknown, reply = 'Listo, ahí va.'): Record<string, unknown> {
  return { result: { output: { reply, artifacts } }, outcome: 'done' };
}

describe('plan de adjuntos', () => {
  it('sube los bytes de un data: URI y lo manda como foto', () => {
    const plan = planArtifacts(payload([{ name: 'captura.png', uri: PNG_DATA_URI }]));
    expect(plan.uploads).toHaveLength(1);
    const upload = plan.uploads[0];
    expect(upload?.kind).toBe('photo');
    expect(upload?.name).toBe('captura.png');
    expect(upload?.bytes.equals(PNG)).toBe(true);
    // A photo is not announced in the footer: it is visible.
    expect(plan.footer).toBe('');
  });

  it('lista los enlaces http(s) en vez de descargarlos (el puente vive al lado de producción)', () => {
    const plan = planArtifacts(payload([
      { name: 'Deploy demeter-dev', uri: 'https://demeter-dev.vercel.app/empresa/configuracion-clientes' }
    ]));
    expect(plan.uploads).toHaveLength(0);
    expect(plan.footer).toContain('📎 Adjuntos');
    expect(plan.footer).toContain('https://demeter-dev.vercel.app/empresa/configuracion-clientes');
    expect(plan.listed).toBe(1);
  });

  it('explica el file:// que vive en el contenedor del agente, y NO lo lee del disco local', () => {
    const plan = planArtifacts(payload([
      { name: 'Guion-Museo-de-Identidades.docx', uri: 'file:///workspace/clases/video/Guion.docx' },
      { name: 'secreto', uri: 'file:///run/secrets/database_url' }
    ]));
    expect(plan.uploads).toHaveLength(0);
    expect(plan.footer).toContain('Guion-Museo-de-Identidades.docx');
    expect(plan.footer).toContain('no viajó al chat');
    // The raw path is not repeated in the chat, and is NEVER opened: `/run/secrets/database_url`
    // it exists INSIDE the bridge, and reading it would publish the production credential.
    expect(plan.footer).not.toContain('/run/secrets/database_url');
  });
});

/* --------------------------------------------------------------------------- *
 * Egreso completo
 * --------------------------------------------------------------------------- */

const ALIAS: TelegramAliasConfig = {
  alias: 'seneca',
  tenant_id: 'Pablo',
  room_id: 'grp.pablo',
  token_file: '/dev/null',
  v2_shutdown_marker_file: '/dev/null',
  allowed_user_ids: ['9'],
  allowed_chat_ids: ['123456789'],
  recipients: [{ tenant_id: 'Pablo', alias: 'seneca' }],
  poll_timeout_seconds: 1,
  poll_lease_ms: 1_000
};

function relay(artifacts: unknown): TelegramOriginRelay {
  return {
    event_id: '11111111-1111-4111-8111-111111111111',
    attempt: 1,
    max_attempts: 5,
    claim_token: 'token',
    tenant_id: 'Pablo',
    adapter: 'telegram',
    origin: {
      adapter: 'telegram',
      channel: 'telegram',
      conversation_id: '123456789',
      external_message_id: '324',
      relay: [],
      metadata: { bridge_alias: 'seneca', bridge_tenant: 'Pablo' }
    },
    payload: payload(artifacts)
  };
}

/** In-memory repository: replays the effect accounting the real ACK demands. */
class MemoryRepository implements TelegramEgressRepository {
  readonly effects = new Map<string, TelegramEffect>();
  readonly acks: TelegramOriginRelayAck[] = [];
  private readonly events: TelegramOriginRelay[];

  constructor(event: TelegramOriginRelay) { this.events = [event]; }

  async claim(): Promise<TelegramOriginRelay[]> { return this.events.splice(0); }
  async renew(): Promise<boolean> { return true; }

  async ack(acknowledgement: TelegramOriginRelayAck): Promise<void> {
    if (acknowledgement.status === 'sent') {
      const rows = [...this.effects.values()];
      const expected = acknowledgement.effect_count ?? 0;
      const sent = rows.filter((row) => row.state === 'sent');
      if (rows.length !== expected || sent.length !== expected ||
          !rows.every((row) => row.chunk_count === expected) ||
          Math.min(...rows.map((row) => row.chunk_index)) !== 0 ||
          Math.max(...rows.map((row) => row.chunk_index)) !== expected - 1) {
        throw new Error('Telegram sent ACK requires every chunk effect to be confirmed sent');
      }
    }
    this.acks.push(acknowledgement);
  }

  async prepareEffect(input: TelegramEffectInput): Promise<TelegramEffect> {
    const existing = this.effects.get(input.effect_id);
    if (existing) {
      if (existing.payload_hash !== input.payload_hash || existing.chunk_count !== input.chunk_count) {
        throw new Error('Telegram effect idempotency conflict');
      }
      return existing;
    }
    const created: TelegramEffect = { ...input, state: 'prepared', replay_count: 0 };
    this.effects.set(input.effect_id, created);
    return created;
  }

  async beginEffect(effectId: string): Promise<TelegramEffect> {
    const effect = this.effects.get(effectId);
    if (!effect) throw new Error('Effect not found');
    const row = { ...effect, state: 'sending' as const };
    this.effects.set(effectId, row);
    return row;
  }

  async resetPrepared(effectId: string): Promise<void> {
    const effect = this.effects.get(effectId);
    if (!effect) throw new Error('Effect not found');
    this.effects.set(effectId, { ...effect, state: 'prepared' });
  }

  async completeEffect(effectId: string, _hash: string, providerMessageId: string): Promise<void> {
    const effect = this.effects.get(effectId);
    if (!effect) throw new Error('Effect not found');
    this.effects.set(effectId, {
      ...effect, state: 'sent', provider_message_id: providerMessageId
    });
  }

  async markEffectAmbiguous(effectId: string, _hash: string, diagnostic: string): Promise<TelegramEffect> {
    const effect = this.effects.get(effectId);
    if (!effect) throw new Error('Effect not found');
    const row = { ...effect, state: 'ambiguous' as const, diagnostic };
    this.effects.set(effectId, row);
    return row;
  }

  async markEffectDead(effectId: string, _hash: string, diagnostic: string): Promise<TelegramEffect> {
    const effect = this.effects.get(effectId);
    if (!effect) throw new Error('Effect not found');
    const row = { ...effect, state: 'dead' as const, diagnostic };
    this.effects.set(effectId, row);
    return row;
  }

  async getEffect(effectId: string): Promise<TelegramEffect | undefined> { return this.effects.get(effectId); }
  async manualReplayEffect(
    chunkIndex: number,
    _payloadHash: string,
    _reason: string,
    _actorTenant: Tenant,
    _actorAlias: string,
    _duplicateRiskAcknowledged: boolean,
    _requestId: string,
    _deadLetterId: string,
    _incidentEvidenceSha256: string,
    _expectedReplayCount: number
  ): Promise<TelegramEffect> {
    void _payloadHash;
    void _reason;
    void _actorTenant;
    void _actorAlias;
    void _duplicateRiskAcknowledged;
    void _requestId;
    void _deadLetterId;
    void _incidentEvidenceSha256;
    void _expectedReplayCount;
    const effect = [...this.effects.values()].find((entry) => entry.chunk_index === chunkIndex);
    if (!effect) throw new Error('Effect not found');
    return effect;
  }
}

interface Enviado { readonly method: string; readonly value: string }

function fakeApi(
  overrides: Partial<TelegramApi> = {},
  sinSubidas = false
): { api: TelegramApi; sent: Enviado[] } {
  const sent: Enviado[] = [];
  let counter = 0;
  const api = {
    async getIdentity() { return { id: '1' }; },
    async getUpdates() { return []; },
    async getFile() { throw new Error('no'); },
    async downloadFile() { throw new Error('no'); },
    async sendText(_chat: string, text: string): Promise<TelegramSendResult> {
      sent.push({ method: 'sendText', value: text });
      counter += 1;
      return { message_id: String(counter) };
    },
    async sendPhoto(_chat: string, upload: TelegramUpload): Promise<TelegramSendResult> {
      sent.push({ method: 'sendPhoto', value: upload.name });
      counter += 1;
      return { message_id: String(counter) };
    },
    async sendDocument(_chat: string, upload: TelegramUpload): Promise<TelegramSendResult> {
      sent.push({ method: 'sendDocument', value: upload.name });
      counter += 1;
      return { message_id: String(counter) };
    },
    async setMessageReaction() { /* sin reacciones en estas pruebas */ },
    async sendChatAction() { /* idem */ },
    ...overrides
  } as TelegramApi;
  if (sinSubidas) {
    Reflect.deleteProperty(api, 'sendPhoto');
    Reflect.deleteProperty(api, 'sendDocument');
  }
  return { api, sent };
}

function worker(repository: TelegramEgressRepository, api: TelegramApi): TelegramEgressWorker {
  return new TelegramEgressWorker({
    activity: noopActivity(), observer: noopObserver(),
    repository, aliases: [ALIAS], apis: new Map([['Pablo/seneca', api]])
  });
}

describe('egreso con adjuntos', () => {
  it('manda el texto y DESPUÉS la foto, y ACKea la entrega entera', async () => {
    const event = relay([{ name: 'captura.png', uri: PNG_DATA_URI }]);
    const repository = new MemoryRepository(event);
    const { api, sent } = fakeApi();
    await worker(repository, api).runOnce();

    expect(sent.map((entry) => entry.method)).toEqual(['sendText', 'sendPhoto']);
    expect(repository.acks).toHaveLength(1);
    expect(repository.acks[0]?.status).toBe('sent');
    expect(repository.acks[0]?.effect_count).toBe(2);
  });

  it('un fallo de red al subir queda ambiguo y NO reenvía la foto sola', async () => {
    const event = relay([{ name: 'captura.png', uri: PNG_DATA_URI }]);
    const repository = new MemoryRepository(event);
    const { api } = fakeApi({
      async sendPhoto(): Promise<TelegramSendResult> {
        throw new TelegramApiError('Telegram request outcome is unknown', false, undefined, false);
      }
    });
    await worker(repository, api).runOnce();
    expect(repository.acks[0]?.status).toBe('dead');
    expect([...repository.effects.values()].map((row) => row.state)).toEqual(['sent', 'ambiguous']);
  });
});
