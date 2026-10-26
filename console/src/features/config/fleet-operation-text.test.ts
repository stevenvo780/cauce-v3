import { describe, expect, it } from 'vitest';
import type { FleetOperation } from '@cauce/protocol/fleet-operation';
import { FleetExecutionReasonSchema } from '@cauce/protocol/fleet-operation';
import { blockingOperation, cancellable, fleetErrorText, isUnpreparedMaintenance, operationErrorHuman, operationHeadline, operationStatusMeta, resumable, stepProgress, STEPS } from './fleet-operation-text';

const base = {
  id: '11111111-1111-4111-8111-111111111111',
  request_sha256: '0'.repeat(64),
  kind: 'create',
  target: { resource: 'agent', tenant_id: 'A', alias: 'w' },
  version: 1,
  actor: { tenant_id: 'A', alias: 'operator' },
  expected_revision: 4,
  desired_revision: 5,
  applied_revision: null,
  error: null,
  created_at: '2026-10-07T12:00:00Z',
  updated_at: '2026-10-07T12:00:00Z',
} as unknown as FleetOperation;

function operation(steps: FleetOperation['steps'], status: FleetOperation['status'] = 'running'): FleetOperation {
  return { ...base, status, steps };
}

describe('fleet operation step labels', () => {
  it.each(FleetExecutionReasonSchema.options)('explica la causa cerrada %s con una siguiente acción', reason => {
    const human = operationErrorHuman({ code: 'STEP_FAILED', step: 'stop', retryable: true, reason });
    expect(human.message).not.toBe('El ejecutor no pudo completar este paso.');
    expect(human.message.length).toBeGreaterThan(20); expect(human.next.length).toBeGreaterThan(20);
  });
  it('tells where the conversations of each shared harness live and how to leave one to continue', () => {
    const human = operationErrorHuman({ code: 'STEP_FAILED', step: 'stop', retryable: false, reason: 'shared_conversation_unaccredited' });
    expect(human.message).not.toContain('Codex');
    for (const place of ['«Abrir terminal»', '$CODEX_HOME/sessions', '$CLAUDE_CONFIG_DIR/projects', '$GROK_HOME/sessions', 'Muse',
      'seed --native-id', 'No se detuvo nada', 'prepara una actualización nueva']) expect(human.next).toContain(place);
  });
  it('names every step by what happens to the agent, never by the executor internals', () => {
    expect(Object.values(STEPS)).not.toContain('Artefactos');
    expect(Object.values(STEPS)).not.toContain('Credenciales');
    expect(Object.values(STEPS)).not.toContain('Runtime');
    expect(Object.values(STEPS)).not.toContain('Admisión');
    expect(Object.values(STEPS)).not.toContain('Cierre de entregas');
    expect(STEPS.prepare).toBe('Preparar el cambio');
    expect(STEPS.profile).toBe('Aplicar el perfil');
    expect(STEPS.stop).toBe('Detener el agente');
  });

  it('reports done and current step in user words for the headline', () => {
    const running = operation([
      { name: 'prepare', status: 'succeeded' },
      { name: 'artifacts', status: 'running' },
      { name: 'runtime', status: 'pending' },
    ]);
    expect(stepProgress(running)).toEqual({ current: 2, total: 3, done: 1, label: 'Archivos' });
    expect(operationHeadline(running)).toBe('Preparar a w está en curso. Hecho: 1 de 3 · Ahora: Archivos.');
  });

  it('describes pending update restoration without claiming an operator cancellation', () => {
    const current = { ...operation([{ name: 'credentials', status: 'failed' }], 'cancelling'), kind: 'update' as const,
      error: { code: 'STEP_FAILED' as const, step: 'credentials' as const, retryable: true } };
    expect(operationStatusMeta(current).label).toBe('Restaurando el estado anterior');
    expect(operationHeadline(current)).toContain('Restaurando el estado anterior del agente.');
    expect(operationHeadline(current)).toContain('El ejecutor no pudo completar este paso.');
    expect(operationHeadline(current)).not.toContain('Cancelando');
    expect(resumable(current)).toBe(false);
  });

  it('keeps a restored failure visible and requires closing it before another update', () => {
    const current = { ...operation([{ name: 'credentials', status: 'compensated' }], 'failed'), kind: 'update' as const,
      error: { code: 'STEP_FAILED' as const, step: 'credentials' as const, retryable: false } };
    expect(operationHeadline(current)).toContain('La actualización falló y se restauró el estado anterior.');
    expect(operationHeadline(current)).toContain('Cierra esta operación y prepara una actualización nueva.');
    expect(resumable(current)).toBe(false); expect(cancellable(current)).toBe(true);
  });

  it.each(['queued', 'running'] as const)('lets a manual action reach the server over %s unprepared host maintenance', status => {
    const current: FleetOperation = { ...operation([{ name: 'prepare', status: 'pending' }], status), kind: 'update',
      desired_revision: null, actor: { ...base.actor, actor_subject: 'host:test-host:approved-key' } };
    expect(isUnpreparedMaintenance(current)).toBe(true);
    expect(blockingOperation(current, 'stop')).toBeUndefined();
    expect(blockingOperation(current, 'retire')).toBeUndefined();
  });

  it.each<[string, Partial<FleetOperation>]>([
    ['published preparation', { desired_revision: 5 }],
    ['started preparation', { steps: [{ name: 'prepare', status: 'running' }] }],
    ['completed preparation', { steps: [{ name: 'prepare', status: 'succeeded' }] }],
    ['human request', { actor: { ...base.actor, actor_subject: 'console:operator' } }],
    ['unidentified request', { actor: base.actor }],
    ['another action', { kind: 'stop' }],
    ['another target', { target: { resource: 'room', tenant_id: 'A', room_id: 'room' } }],
    ['failed request', { status: 'failed' }],
    ['authentication wait', { status: 'awaiting_auth' }],
    ['pending cancellation', { status: 'cancelling' }],
  ])('keeps %s blocking new manual actions', (_label, changes) => {
    const current: FleetOperation = { ...operation([{ name: 'prepare', status: 'pending' }]), kind: 'update',
      desired_revision: null, actor: { ...base.actor, actor_subject: 'host:test-host:approved-key' }, ...changes };
    expect(isUnpreparedMaintenance(current)).toBe(false);
    expect(blockingOperation(current, 'retire')).toBe(current);
  });

  it('does not name an old successful start as the cause of a new server conflict', () => {
    const previous: FleetOperation = { ...operation([], 'succeeded'), kind: 'start' };
    const message = 'target already has an unresolved fleet operation';
    expect(fleetErrorText(message, previous, 'retire'))
      .toBe('Hay una operación de flota sin terminar; cancélala para poder retirar.');
    expect(fleetErrorText(message, { ...previous, status: 'running' }, 'retire'))
      .toBe('Hay una operación de inicio sin terminar; cancélala para poder retirar.');
  });
});
