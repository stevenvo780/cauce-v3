import { describe, expect, it, vi } from 'vitest';
import {
  ApiError, PublishIntentExpiredError, PublishIntentReconciliationError, type CauceApi,
} from '../../api/client';
import { publishDurably } from './durable-publish';

type PublishApi = Pick<CauceApi, 'preparePublishIntent' | 'publishMessage' | 'confirmPublishIntent'>;

const key = 'server-journal-key';
const receipt = {
  message_id: 'a0000000-0000-4000-8000-000000000001',
  delivery_ids: ['b0000000-0000-4000-8000-000000000001'],
  duplicate: false,
  request_id: 'c0000000-0000-4000-8000-000000000001',
  trace_id: 'trace-durable-publish',
  idempotency_key: key,
  tenant_id: 'Steven',
  actor_alias: 'kant',
  request_hash: 'a'.repeat(64),
  causal_hash: 'b'.repeat(64),
};
const input = {
  room_id: 'grp.steven',
  recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
  body: { text: 'hola' },
  lane: 'interactive' as const,
  priority: 10,
};
const confirmation = {
  version: 1 as const,
  confirmed: true as const,
  idempotency_key: key,
  message_id: receipt.message_id,
  causal_hash: receipt.causal_hash,
};

function apiWith(overrides: Partial<PublishApi> = {}): PublishApi {
  return {
    preparePublishIntent: vi.fn().mockResolvedValue({
      version: 1, state: 'prepared', idempotency_key: key, receipt: null,
    }),
    publishMessage: vi.fn().mockResolvedValue(receipt),
    confirmPublishIntent: vi.fn().mockResolvedValue(confirmation),
    ...overrides,
  };
}

describe('durable console publish', () => {
  it('recovers a committed receipt without issuing another publish', async () => {
    const api = apiWith({
      preparePublishIntent: vi.fn().mockResolvedValue({
        version: 1, state: 'committed', idempotency_key: key, receipt,
      }),
    });

    await expect(publishDurably({
      api, input, publisherSubject: 'Steven:kant', expectedDeliveries: 1, reconcile: vi.fn(),
    })).resolves.toMatchObject({ receipt, reconciled: true, journalStatus: 'confirmed' });
    expect(api.publishMessage).not.toHaveBeenCalled();
    expect(api.confirmPublishIntent).toHaveBeenCalledTimes(1);
  });

  it('retries an ambiguous transport loss once with the exact server key', async () => {
    const publishMessage = vi.fn()
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce({ ...receipt, duplicate: true });
    const reconcile = vi.fn();
    const api = apiWith({ publishMessage });

    const result = await publishDurably({
      api, input, publisherSubject: 'Steven:kant', expectedDeliveries: 1, reconcile,
    });

    expect(result).toMatchObject({ reconciled: true, journalStatus: 'confirmed' });
    expect(publishMessage).toHaveBeenCalledTimes(2);
    expect(publishMessage.mock.calls[0]?.[0]).toEqual(publishMessage.mock.calls[1]?.[0]);
    expect(publishMessage.mock.calls[0]?.[0]).toMatchObject({ idempotency_key: key });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('retries a lost prepare response once with the same ephemeral submit nonce', async () => {
    const preparePublishIntent = vi.fn<PublishApi['preparePublishIntent']>()
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce({
        version: 1, state: 'prepared', idempotency_key: key, receipt: null,
      });
    const api = apiWith({ preparePublishIntent });

    await expect(publishDurably({
      api, input, publisherSubject: 'Steven:kant', expectedDeliveries: 1, reconcile: vi.fn(),
    })).resolves.toMatchObject({ receipt, journalStatus: 'confirmed' });
    expect(preparePublishIntent).toHaveBeenCalledTimes(2);
    expect(preparePublishIntent.mock.calls[0]?.[0].intent_nonce)
      .toBe(preparePublishIntent.mock.calls[1]?.[0].intent_nonce);
  });

  it('gives two deliberate concurrent identical submits distinct nonces and effects', async () => {
    const nonces: string[] = [];
    const preparePublishIntent = vi.fn(async (candidate: { intent_nonce: string }) => {
      nonces.push(candidate.intent_nonce);
      return {
        version: 1 as const,
        state: 'prepared' as const,
        idempotency_key: `server:${candidate.intent_nonce}`,
        receipt: null,
      };
    });
    let effect = 0;
    const publishMessage = vi.fn(async (candidate: { idempotency_key: string }) => {
      effect += 1;
      const suffix = effect === 1 ? '1' : '2';
      return {
        ...receipt,
        message_id: `a0000000-0000-4000-8000-00000000000${suffix}`,
        delivery_ids: [`b0000000-0000-4000-8000-00000000000${suffix}`],
        idempotency_key: candidate.idempotency_key,
      };
    });
    const confirmPublishIntent = vi.fn<PublishApi['confirmPublishIntent']>(async (candidate) => ({
      version: 1 as const, confirmed: true as const, ...candidate,
    }));
    const api = apiWith({ preparePublishIntent, publishMessage, confirmPublishIntent });

    const outcomes = await Promise.all([1, 2].map(async () => publishDurably({
      api, input, publisherSubject: 'Steven:kant', expectedDeliveries: 1, reconcile: vi.fn(),
    })));

    expect(new Set(nonces).size).toBe(2);
    expect(publishMessage).toHaveBeenCalledTimes(2);
    expect(new Set(outcomes.map(({ receipt: item }) => item.message_id)).size).toBe(2);
  });

  it('reconciles an exact committed 409 and never publishes a second effect', async () => {
    const preparePublishIntent = vi.fn().mockRejectedValue(new PublishIntentReconciliationError({
      version: 1,
      error: 'publish_intent_reconciliation_required',
      state: 'committed',
      idempotency_key: key,
      receipt,
    }));
    const reconcile = vi.fn();
    const api = apiWith({ preparePublishIntent });

    await expect(publishDurably({
      api, input, publisherSubject: 'Steven:kant', expectedDeliveries: 1, reconcile,
    })).resolves.toMatchObject({ receipt, reconciled: true, journalStatus: 'confirmed' });
    expect(api.publishMessage).not.toHaveBeenCalled();
    expect(api.confirmPublishIntent).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 422, 429])('does not retry a definitive HTTP %s rejection', async (status) => {
    const publishMessage = vi.fn().mockRejectedValue(new ApiError('rejected', status));
    const reconcile = vi.fn();
    const api = apiWith({ publishMessage });

    await expect(publishDurably({
      api, input, publisherSubject: 'Steven:kant', expectedDeliveries: 1, reconcile,
    })).rejects.toMatchObject({ status });
    expect(publishMessage).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
    expect(api.confirmPublishIntent).not.toHaveBeenCalled();
  });

  it('does not retry a late owner after the server proved its reservation expired without effect', async () => {
    const expiration = {
      version: 1 as const,
      error: 'publish_intent_expired' as const,
      state: 'expired' as const,
      idempotency_key: key,
      safe_to_resubmit: true as const,
    };
    const publishMessage = vi.fn().mockRejectedValue(new PublishIntentExpiredError(expiration));
    const reconcile = vi.fn();
    const api = apiWith({ publishMessage });

    await expect(publishDurably({
      api, input, publisherSubject: 'Steven:kant', expectedDeliveries: 1, reconcile,
    })).rejects.toMatchObject({ status: 410, expiration });
    expect(publishMessage).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
    expect(api.confirmPublishIntent).not.toHaveBeenCalled();
  });

  it('keeps a verified publish successful when both idempotent confirms lose their response', async () => {
    const confirmPublishIntent = vi.fn().mockRejectedValue(new TypeError('connection lost'));
    const api = apiWith({ confirmPublishIntent });

    await expect(publishDurably({
      api, input, publisherSubject: 'Steven:kant', expectedDeliveries: 1, reconcile: vi.fn(),
    })).resolves.toMatchObject({ receipt, reconciled: false, journalStatus: 'pending' });
    expect(confirmPublishIntent).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 409, 422, 429])(
    'surfaces a definitive confirm HTTP %s as rejected without retrying the committed effect',
    async (status) => {
      const confirmPublishIntent = vi.fn().mockRejectedValue(new ApiError('rejected', status));
      const api = apiWith({ confirmPublishIntent });

      await expect(publishDurably({
        api, input, publisherSubject: 'Steven:kant', expectedDeliveries: 1, reconcile: vi.fn(),
      })).resolves.toMatchObject({ receipt, journalStatus: 'rejected' });
      expect(confirmPublishIntent).toHaveBeenCalledTimes(1);
    },
  );

  it('changes an ambiguous confirm into rejected when its exact retry returns 409', async () => {
    const confirmPublishIntent = vi.fn()
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockRejectedValueOnce(new ApiError('journal conflict', 409));
    const api = apiWith({ confirmPublishIntent });

    await expect(publishDurably({
      api, input, publisherSubject: 'Steven:kant', expectedDeliveries: 1, reconcile: vi.fn(),
    })).resolves.toMatchObject({ receipt, journalStatus: 'rejected' });
    expect(confirmPublishIntent).toHaveBeenCalledTimes(2);
  });

  it('rejects a malformed prepare envelope before publishing', async () => {
    const api = apiWith({
      preparePublishIntent: vi.fn().mockResolvedValue({
        version: 1, state: 'prepared', idempotency_key: key, receipt,
      }),
    });

    await expect(publishDurably({
      api, input, publisherSubject: 'Steven:kant', expectedDeliveries: 1, reconcile: vi.fn(),
    })).rejects.toThrow(/intención durable exacta/u);
    expect(api.publishMessage).not.toHaveBeenCalled();
    expect(api.confirmPublishIntent).not.toHaveBeenCalled();
  });
});

describe('accepted receipt before durable confirmation', () => {
  it('notifies exactly once before a suspended confirmation completes', async () => {
    let confirm!: (value: typeof confirmation) => void;
    const confirmPublishIntent = vi.fn(() => new Promise<typeof confirmation>((resolve) => { confirm = resolve; }));
    const onAccepted = vi.fn();
    const api = apiWith({ confirmPublishIntent });
    let settled = false;
    const outcome = publishDurably({
      api, input, publisherSubject: 'Steven:kant', expectedDeliveries: 1, reconcile: vi.fn(), onAccepted,
    }).then((value) => { settled = true; return value; });
    await vi.waitFor(() => { expect(confirmPublishIntent).toHaveBeenCalledOnce(); });
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith({ receipt, reconciled: false });
    expect(onAccepted.mock.invocationCallOrder[0]).toBeLessThan(confirmPublishIntent.mock.invocationCallOrder[0]);
    expect(settled).toBe(false);
    confirm(confirmation);
    await expect(outcome).resolves.toMatchObject({ receipt, journalStatus: 'confirmed' });
    expect(onAccepted).toHaveBeenCalledOnce();
  });

  it.each([
    { status: 0, code: 'timeout', expected: 'pending', calls: 2 },
    { status: 409, code: undefined, expected: 'rejected', calls: 1 },
  ])('preserves the accepted receipt after confirmation $expected', async ({ status, code, expected, calls }) => {
    const confirmPublishIntent = vi.fn().mockRejectedValue(new ApiError('confirmation unavailable', status, code));
    const onAccepted = vi.fn();
    const api = apiWith({ confirmPublishIntent });
    const outcome = await publishDurably({
      api, input, publisherSubject: 'Steven:kant', expectedDeliveries: 1, reconcile: vi.fn(), onAccepted,
    });
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith({ receipt, reconciled: false });
    expect(outcome).toMatchObject({ receipt, journalStatus: expected });
    expect(confirmPublishIntent).toHaveBeenCalledTimes(calls);
    expect(api.publishMessage).toHaveBeenCalledOnce();
    for (const [request] of confirmPublishIntent.mock.calls) expect(request).toEqual({
      idempotency_key: key, message_id: receipt.message_id, causal_hash: receipt.causal_hash,
    });
  });

  it('notifies a reconciled committed effect without another publish', async () => {
    const api = apiWith({ preparePublishIntent: vi.fn().mockRejectedValue(new PublishIntentReconciliationError({
      version: 1, error: 'publish_intent_reconciliation_required', state: 'committed', idempotency_key: key, receipt,
    })) });
    const onAccepted = vi.fn();
    await publishDurably({
      api, input, publisherSubject: 'Steven:kant', expectedDeliveries: 1, reconcile: vi.fn(), onAccepted,
    });
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith({ receipt, reconciled: true });
    expect(api.publishMessage).not.toHaveBeenCalled();
  });

  it.each([
    { ...receipt, message_id: 'not-a-message-id' },
    { ...receipt, delivery_ids: [] },
    { ...receipt, actor_alias: 'other-actor' },
    { ...receipt, idempotency_key: 'other-key' },
  ])('never announces a malformed or mismatched receipt', async (invalid) => {
    const api = apiWith({ publishMessage: vi.fn().mockResolvedValue(invalid) });
    const onAccepted = vi.fn();
    await expect(publishDurably({
      api, input, publisherSubject: 'Steven:kant', expectedDeliveries: 1, reconcile: vi.fn(), onAccepted,
    })).rejects.toThrow('Resultado incierto');
    expect(onAccepted).not.toHaveBeenCalled();
    expect(api.confirmPublishIntent).not.toHaveBeenCalled();
  });

  it('does not let a presentation callback interrupt confirmation of a committed effect', async () => {
    const api = apiWith();
    await expect(publishDurably({
      api, input, publisherSubject: 'Steven:kant', expectedDeliveries: 1, reconcile: vi.fn(),
      onAccepted: () => { throw new Error('presentation failed'); },
    })).resolves.toMatchObject({ receipt, journalStatus: 'confirmed' });
    expect(api.publishMessage).toHaveBeenCalledOnce();
    expect(api.confirmPublishIntent).toHaveBeenCalledOnce();
  });
});
