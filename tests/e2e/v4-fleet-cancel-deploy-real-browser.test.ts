import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { command } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { cancelOperations } from './v4-fleet-cancel.helpers.js';
import { bodySnippet } from './v4-console-real-browser.helpers.js';
import { assertCancelDeployLive } from './v4-fleet-cancel-deploy.delivery.js';
import { runFreshStopDeployScenario, runStopDeployScenario } from './v4-fleet-stop-deploy.flow.js';
import { RECOVER_TERMINAL_RULES, recoverDeployRuntime, runRecoverDeployScenario } from './v4-fleet-recover-deploy.flow.js';
import { cancelDeployTuiRuntime, runSharedPolicyDeployScenario } from './v4-fleet-cancel-deploy.tui.js';
import { createCancelDeployActor, runCancelDeployScenario } from './v4-fleet-cancel-deploy.flow.js';
import { cancelDeployCapture, cancelDeployPrefix, cancelDeployReceipts, cancelDeployRun, startCancelDeployFixture,
  type CancelDeployFixture } from './v4-fleet-cancel-deploy.helpers.js';

const evidence: Record<string, unknown> = { run: cancelDeployRun };

function deliveredId(live: Record<string, unknown>): string {
  if (!Array.isArray(live.delivery) || live.delivery.length !== 1) throw new Error('the phase must finish one durable delivery');
  const delivery: unknown = live.delivery[0];
  if (!delivery || typeof delivery !== 'object' || !('id' in delivery) || typeof delivery.id !== 'string' ||
    !/^[a-f0-9-]{36}$/u.test(delivery.id) || !('status' in delivery) || delivery.status !== 'done') {
    throw new Error('the phase lacks its completed durable delivery identity');
  }
  return delivery.id;
}

async function collectReceipt(fixture: CancelDeployFixture, name: string, observed: Record<string, unknown>): Promise<void> {
  observed.journal = (await fixture.computer.onComputer(['journalctl', '--user', '--no-pager', '-n', '250'])).stdout;
  observed.browser = { trace: fixture.errors.trace, unexpected: fixture.errors.unexpected };
  observed.deliveries = (await fixture.computer.pool.query(`SELECT delivery.id,delivery.recipient_alias,delivery.status,delivery.last_error,
    delivery.consumer_instance_id,delivery.consumer_epoch,delivery.result FROM deliveries delivery
    WHERE delivery.recipient_tenant=$1 AND delivery.recipient_alias LIKE $2 ORDER BY delivery.created_at`,
  [fixture.tenantId, `deploy${cancelDeployRun}%`])).rows;
  observed.bootstrapProbes = (await fixture.computer.pool.query(`SELECT DISTINCT ON (event.metadata->'bootstrap_probe'->'probe'->>'probe_id')
    event.operation_id,event.created_at,event.metadata->'bootstrap_probe'->'probe'->>'alias' AS alias,
    event.metadata->'bootstrap_probe'->'probe'->>'phase' AS phase,
    event.metadata->'bootstrap_probe'->'probe'->>'action' AS action,
    event.metadata->'bootstrap_probe'->'probe'->>'profile_revision' AS profile_revision,
    event.metadata->'bootstrap_probe'->>'state' AS state,
    event.metadata->'bootstrap_probe'->'proof'->>'harness_started' AS harness_started,
    jsonb_array_length(COALESCE(event.metadata->'bootstrap_probe'->'proof'->'documents','[]'::jsonb))::int AS documents
    FROM fleet_operation_events event JOIN fleet_operations operation ON operation.id=event.operation_id
    WHERE operation.target->>'tenant_id'=$1 AND operation.target->>'alias' LIKE $2 AND event.metadata ? 'bootstrap_probe'
    ORDER BY event.metadata->'bootstrap_probe'->'probe'->>'probe_id',event.id DESC`,
  [fixture.tenantId, `deploy${cancelDeployRun}%`])).rows;
  const agents = (await fixture.computer.pool.query<{ alias: string; container_name: string | null; state_directory: string | null;
    enabled: boolean; lifecycle_state: string }>(
    'SELECT alias,container_name,state_directory,enabled,lifecycle_state FROM agents WHERE tenant_id=$1 AND alias LIKE $2',
    [fixture.tenantId, `deploy${cancelDeployRun}%`])).rows;
  observed.agentStates = agents.map(({ alias, enabled, lifecycle_state }) => ({ alias, enabled, lifecycle_state }));
  const logs: Record<string, string> = {};
  const operations: Record<string, unknown> = {};
  for (const agent of agents) {
    operations[agent.alias] = await cancelOperations(fixture, agent.alias);
    if (agent.container_name?.startsWith(`${cancelDeployPrefix}-`) && agent.state_directory?.startsWith('/home/cauce/.cauce/')) {
      const filename = join(cancelDeployReceipts, `${name}-${agent.alias}.adapter.log`);
      const copied = await command('docker', ['cp', `${agent.container_name}:${agent.state_directory}/.cauce-adapter.log`, filename]);
      if (copied.code === 0) { await chmod(filename, 0o600); logs[agent.alias] = filename; }
      else logs[agent.alias] = `owned adapter log unavailable: ${copied.stderr}`;
    }
  }
  observed.operations = operations; observed.adapterLogs = logs;
}

async function runCase(name: string, run: (fixture: CancelDeployFixture, observed: Record<string, unknown>) => Promise<void>,
  options: Parameters<typeof startCancelDeployFixture>[0] = {}): Promise<void> {
  await mkdir(cancelDeployReceipts, { recursive: true, mode: 0o700 });
  const observed: Record<string, unknown> = { case: name };
  evidence[name] = observed;
  const failures: unknown[] = [];
  let fixture: CancelDeployFixture | undefined;
  try {
    fixture = await startCancelDeployFixture(options);
    observed.source = { archive: fixture.setup.initialConfiguration.release.sha256, signer: fixture.setup.signerFingerprint };
    await run(fixture, observed);
    fixture.errors.assertClean();
  } catch (error) {
    failures.push(error);
    observed.failure = error instanceof Error ? error.message : String(error);
    if (fixture) {
      observed.page = await bodySnippet(fixture.page).catch((pageError: unknown) => pageError instanceof Error ? pageError.message : String(pageError));
      await cancelDeployCapture(fixture.page, `${name}-failure`).catch((captureError: unknown) => {
        observed.captureFailure = captureError instanceof Error ? captureError.message : String(captureError);
      });
    }
  }
  try { if (fixture) await collectReceipt(fixture, name, observed); }
  catch (error) { failures.push(error); observed.receiptFailure = error instanceof Error ? error.message : String(error); }
  try { if (fixture) { await fixture.close(); observed.cleanup = { containers: '', volumes: '', images: '' }; } }
  catch (error) { failures.push(error); observed.cleanupFailure = error instanceof Error ? error.message : String(error); }
  await writeFile(join(cancelDeployReceipts, `evidence-${name}.json`), JSON.stringify(observed, null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(cancelDeployReceipts, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, `fleet deployment ${name} failed`);
}

describe('cancelación con despliegue aprobado durante una actualización', () => {
  it('actualiza desde una política sin TUI compartida a la aprobación con TUI y entrega real', async () => {
    await runCase('shared-policy', async (fixture, observed) => {
      await runSharedPolicyDeployScenario(fixture, observed, async (actor, phase) => {
        const live: Record<string, unknown> = {};
        observed[phase] = live;
        await assertCancelDeployLive(actor, phase, live);
        return deliveredId(live);
      });
    }, { runtimeBundle: cancelDeployTuiRuntime, initialSharedTui: false });
  }, 900_000);

  it('reinicia con el bundle vigente un agente lanzado con la release anterior, también tras Ctrl+C de su adaptador', async () => {
    await runCase('recover-deployment', async (fixture, observed) => {
      await runRecoverDeployScenario(fixture, observed, async (actor, phase) => {
        const live: Record<string, unknown> = {};
        observed[phase] = live;
        await assertCancelDeployLive(actor, phase, live);
        return deliveredId(live);
      });
    }, { runtimeBundle: recoverDeployRuntime, errorRules: RECOVER_TERMINAL_RULES });
  }, 1_500_000);

  it('arranca el SDK real y procesa una entrega durable desde Chromium', async () => {
    await runCase('sdk', async (fixture, observed) => {
      const created = await createCancelDeployActor(fixture, '');
      observed.created = { operation: created.operation, observed: created.observed };
      expect(created.observed.adapterAlive).toBe(true);
      expect(created.observed.image).toBe(fixture.computer.agentImage);
      await assertCancelDeployLive(created.actor, 'preliminary', observed);
    });
  }, 900_000);

  it.each(['same-path', 'old-release'] as const)('cancela tras despliegue %s, arranca y entrega antes de actualizar la imagen', async scenario => {
    await runCase(scenario, async (fixture, observed) => {
      await runCancelDeployScenario(fixture, scenario, observed, async (actor, phase) => {
        const live: Record<string, unknown> = {};
        observed[phase] = live;
        await assertCancelDeployLive(actor, phase, live);
      });
    });
  }, 1_200_000);

  it('reintenta la misma parada tras un despliegue sin refrescar hasta Arrancar y entregar', async () => {
    await runCase('stop-deployment', async (fixture, observed) => {
      await runStopDeployScenario(fixture, observed, async (actor, phase) => {
        const live: Record<string, unknown> = {};
        observed[phase] = live;
        await assertCancelDeployLive(actor, phase, live);
      });
    });
  }, 900_000);

  it('detiene un agente lanzado con la release anterior y lo arranca con el bundle vigente, dos despliegues seguidos', async () => {
    await runCase('fresh-stop-deployment', async (fixture, observed) => {
      await runFreshStopDeployScenario(fixture, observed, async (actor, phase) => {
        const live: Record<string, unknown> = {};
        observed[phase] = live;
        await assertCancelDeployLive(actor, phase, live);
      });
    });
  }, 1_200_000);

});
