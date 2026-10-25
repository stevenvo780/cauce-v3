import { describe, expect, it } from 'vitest';
import type { FleetOperation } from '@cauce/protocol/fleet-operation';
import { FleetExecutionReasonSchema } from '@cauce/protocol/fleet-operation';
import { operationErrorHuman, operationHeadline, stepProgress, STEPS } from './fleet-operation-text';

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
  it('names every step by what happens to the agent, never by the executor internals', () => {
    expect(Object.values(STEPS)).not.toContain('Artefactos');
    expect(Object.values(STEPS)).not.toContain('Credenciales');
    expect(Object.values(STEPS)).not.toContain('Runtime');
    expect(Object.values(STEPS)).not.toContain('Admisión');
    expect(Object.values(STEPS)).not.toContain('Cierre de entregas');
    expect(STEPS.prepare).toBe('Preparar el cambio');
    expect(STEPS.profile).toBe('Aplicar el perfil');
    expect(STEPS.stop).toBe('Detener el contenedor');
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
});
