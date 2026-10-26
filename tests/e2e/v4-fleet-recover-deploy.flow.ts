import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import { docker, type ComputerRuntimeBundle } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { cancelOperations, type CancelOperation } from './v4-fleet-cancel.helpers.js';
import { createCancelDeployActor, observeCancelDeployActor, waitCancelDeployEnabled, waitCancelDeployOperation,
  type CancelDeployActor, type CancelDeployObservation } from './v4-fleet-cancel-deploy.flow.js';
import { cancelDeployCapture, type CancelDeployFixture } from './v4-fleet-cancel-deploy.helpers.js';
import type { IgnoredConsoleRule } from './v4-console-real-browser.helpers.js';
import { deployCancelRelease } from './v4-fleet-cancel-deploy.release.js';
import { cancelDeployTuiRuntime, observeNativeTurn } from './v4-fleet-cancel-deploy.tui.js';
import { currentBundleCheck } from './v4-fleet-stop-deploy.flow.js';

const execute = promisify(execFile);
const root = process.cwd();

/** The shared TUI double plus the SDK resume entry the executor runs to prove the exact conversation. */
export const recoverDeployRuntime: ComputerRuntimeBundle = {
  ...cancelDeployTuiRuntime,
  async stage(directory) {
    const entries = await cancelDeployTuiRuntime.stage(directory);
    await execute(join(root, 'node_modules/.bin/esbuild'), [join(root, 'packages/adapter-sdk/src/bin/shared-session.ts'),
      '--bundle', '--platform=node', '--format=esm', '--target=node22', '--log-level=error',
      `--outfile=${join(directory, 'src/bin/shared-session.js')}`, `--alias:@cauce/protocol=${join(root, 'packages/protocol/src')}`,
      '--banner:js=import{createRequire as __cauceRequire}from"node:module";const require=__cauceRequire(import.meta.url);'],
    { maxBuffer: 1024 * 1024 });
    return entries;
  },
};

export const RECOVER_TERMINAL_RULES: readonly IgnoredConsoleRule[] = [
  { id: 'terminal-targets-unavailable', reason: 'hermetic gateway without the optional terminal relay',
    matches: (text, url) => text.includes('status of 501') && new URL(url).pathname === '/v3/console/terminal/targets' },
  { id: 'terminal-routes-unmounted', reason: 'hermetic gateway omits the optional terminal relay routes',
    matches: (text, url) => text.includes('status of 404')
      && ['/v3/console/terminal/targets', '/v3/console/terminal/sessions'].includes(new URL(url).pathname) }];

type LiveTurn = (actor: CancelDeployActor, phase: string) => Promise<string>;

function relaunchText(state: 'present' | 'absent', recreates: boolean): string {
  return `${state === 'present'
    ? 'El adaptador corre con una versión anterior: se detendrá y se relanzará con la versión vigente.'
    : 'El adaptador está detenido: se relanzará con la versión vigente.'}${recreates
    ? ' Su contenedor se recreará con la versión vigente y conservará sus volúmenes.' : ''} La TUI compartida reanudará la conversación exacta.`;
}

async function sameConversation(actor: CancelDeployActor, phase: string, native: string, assertLive: LiveTurn): Promise<unknown> {
  const turn = await observeNativeTurn(actor, await assertLive(actor, phase)) as { witness: { native_session_id: string } };
  expect(turn.witness.native_session_id).toBe(native);
  return turn;
}

async function restartFromTerminal(actor: CancelDeployActor, phase: string, state: 'present' | 'absent',
  recreates: boolean): Promise<CancelOperation> {
  const { page, baseUrl, tenantId } = actor.fixture;
  const known = new Set((await cancelOperations(actor.fixture, actor.alias)).map(row => row.id));
  await page.goto(`${baseUrl}/terminal/${tenantId}/${actor.alias}?modo=tui`, { waitUntil: 'domcontentloaded' });
  const region = page.getByRole('region', { name: `Recuperación de ${actor.alias}`, exact: true });
  await region.getByRole('button', { name: 'Reiniciar agente', exact: true }).click();
  await region.getByText(relaunchText(state, recreates), { exact: true }).waitFor({ timeout: 90_000 });
  const confirm = region.getByRole('button', { name: 'Confirmar reinicio y reanudar', exact: true });
  await waitCancelDeployEnabled(confirm);
  await cancelDeployCapture(page, `${phase}-confirmation`);
  await confirm.click();
  const recovered = await waitCancelDeployOperation(actor, 'recover', ['succeeded'], known);
  for (const name of ['runtime', 'verify']) {
    expect(recovered.steps.find(step => step.name === name)?.evidence?.recovery).toMatchObject({ strategy: 'relaunch',
      preserves_conversation: true, recreates_container: recreates,
      session: { state: state === 'present' ? 'resumed' : 'recreated', resumable: true } });
  }
  await cancelDeployCapture(page, `${phase}-recovered`);
  return recovered;
}

async function interruptAdapter(actor: CancelDeployActor, observed: CancelDeployObservation): Promise<CancelDeployObservation> {
  if (observed.pid === null || !observed.adapterAlive) throw new Error('the adapter to interrupt is not running');
  const owner = await docker(['exec', '--user', '0', actor.container, 'stat', '-c', '%u:%g', `/proc/${String(observed.pid)}`]);
  await docker(['exec', '--user', owner, actor.container, 'python3', '-I', '-c',
    'import os,signal,sys;os.kill(int(sys.argv[1]),signal.SIGINT)', String(observed.pid)]);
  await expect.poll(async () => (await observeCancelDeployActor(actor)).adapterAlive, { timeout: 30_000 }).toBe(false);
  const interrupted = await observeCancelDeployActor(actor);
  expect(interrupted).toMatchObject({ id: observed.id, running: true, adapterAlive: false, volumes: observed.volumes });
  return interrupted;
}

export async function runRecoverDeployScenario(fixture: CancelDeployFixture, evidence: Record<string, unknown>,
  assertLive: LiveTurn): Promise<void> {
  const { actor, operation, observed: before } = await createCancelDeployActor(fixture, 'r');
  evidence.created = operation; evidence.before = before;
  expect(before.adapterAlive).toBe(true);
  const initial = await observeNativeTurn(actor, await assertLive(actor, 'recover-initial')) as { witness: { native_session_id: string } };
  evidence.initialTurn = initial;
  const native = initial.witness.native_session_id;

  const bundle = await deployCancelRelease(fixture, fixture.setup, 'recover-bundle-deployment', { image: before.image, newImage: false });
  const stale = await observeCancelDeployActor(actor);
  const check = await currentBundleCheck(actor, bundle);
  evidence.bundle = { deployment: bundle, stale, check };
  expect(stale).toMatchObject({ id: before.id, release: before.release, bundleDigest: before.bundleDigest, adapterAlive: true });
  expect(bundle.release).not.toBe(before.release); expect(bundle.bundleDigest).not.toBe(before.bundleDigest);
  expect(check).toEqual({ code: 78, stderr: 'active bundle digest differs from lifecycle metadata' });
  const resumed = await restartFromTerminal(actor, 'recover-bundle', 'present', true);
  const afterBundle = await observeCancelDeployActor(actor);
  Object.assign(evidence.bundle as object, { recovered: resumed, after: afterBundle });
  expect(afterBundle).toMatchObject({ image: before.image, release: bundle.release, bundleDigest: bundle.bundleDigest,
    volumes: before.volumes, running: true, adapterAlive: true });
  expect(afterBundle.id).not.toBe(before.id); expect(afterBundle.credentialGeneration).not.toBeNull();
  (evidence.bundle as Record<string, unknown>).turn = await sameConversation(actor, 'recover-bundle-relaunched', native, assertLive);

  const image = await deployCancelRelease(fixture, fixture.setup, 'recover-image-deployment',
    { image: afterBundle.image, newImage: true, sourceStage: bundle.stage });
  expect(image.image).not.toBe(afterBundle.image);
  const interrupted = await interruptAdapter(actor, afterBundle);
  evidence.image = { deployment: image, interrupted };
  const recreated = await restartFromTerminal(actor, 'recover-image-interrupted', 'absent', true);
  const afterImage = await observeCancelDeployActor(actor);
  Object.assign(evidence.image as object, { recovered: recreated, after: afterImage });
  expect(afterImage).toMatchObject({ image: image.image, release: image.release, bundleDigest: image.bundleDigest,
    volumes: before.volumes, running: true, adapterAlive: true });
  expect(afterImage.id).not.toBe(afterBundle.id);
  (evidence.image as Record<string, unknown>).turn = await sameConversation(actor, 'recover-image-relaunched', native, assertLive);

  const stopped = await interruptAdapter(actor, afterImage);
  evidence.interrupted = { interrupted: stopped };
  const relaunched = await restartFromTerminal(actor, 'recover-interrupted', 'absent', false);
  const afterInterrupt = await observeCancelDeployActor(actor);
  Object.assign(evidence.interrupted as object, { recovered: relaunched, after: afterInterrupt });
  expect(afterInterrupt).toMatchObject({ id: afterImage.id, image: image.image, release: image.release, bundleDigest: image.bundleDigest,
    volumes: before.volumes, running: true, adapterAlive: true });
  expect(afterInterrupt.pid).not.toBe(afterImage.pid);
  (evidence.interrupted as Record<string, unknown>).turn = await sameConversation(actor, 'recover-interrupted-relaunched', native, assertLive);
  expect((await cancelOperations(fixture, actor.alias)).filter(row => row.kind === 'recover').map(row => row.status))
    .toEqual(['succeeded', 'succeeded', 'succeeded']);
}
