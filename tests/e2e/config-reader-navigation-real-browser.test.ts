import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isaTenant, newTrustedPage, startConsoleFunctionalFixture,
  type BrowserPage, type FunctionalTenant,
} from './console-functional-browser.fixtures.js';

const execute = promisify(execFile);
const artifactDirectory = process.env.CAUCE_E2E_ARTIFACT_DIR;
type Fixture = Awaited<ReturnType<typeof startConsoleFunctionalFixture>>;
interface ResourceEvidence {
  id: string;
  name: string;
  mounts: { Type?: string; Name?: string; Source?: string; Destination?: string; RW?: boolean }[];
  networks: Record<string, { NetworkID?: string }>;
  binds: unknown;
  ports: unknown;
  networkMode: string;
  owner: string;
}

let fixture: Fixture | undefined;
let reader: FunctionalTenant | undefined;

async function inspectField(reference: string, format: string): Promise<string> {
  const { stdout } = await execute('docker', ['inspect', '--format', format, reference], {
    timeout: 15_000, maxBuffer: 64 * 1024,
  });
  return stdout.trim();
}

async function inspectContainer(reference: string): Promise<ResourceEvidence> {
  const [id, name, mounts, networks, binds, ports, networkMode, owner] = await Promise.all([
    inspectField(reference, '{{.Id}}'),
    inspectField(reference, '{{.Name}}'),
    inspectField(reference, '{{json .Mounts}}'),
    inspectField(reference, '{{json .NetworkSettings.Networks}}'),
    inspectField(reference, '{{json .HostConfig.Binds}}'),
    inspectField(reference, '{{json .HostConfig.PortBindings}}'),
    inspectField(reference, '{{.HostConfig.NetworkMode}}'),
    inspectField(reference, '{{index .Config.Labels "cauce.e2e.owner"}}'),
  ]);
  if (!id || !name) throw new Error('owned container identity was not available');
  return {
    id, name, mounts: JSON.parse(mounts) as ResourceEvidence['mounts'],
    networks: JSON.parse(networks) as ResourceEvidence['networks'],
    binds: JSON.parse(binds) as unknown, ports: JSON.parse(ports) as unknown,
    networkMode, owner,
  };
}

async function assertAbsent(kind: 'container' | 'network' | 'volume' | 'image', reference: string): Promise<void> {
  const [command, format] = kind === 'container' || kind === 'image'
    ? ['inspect', '--format'] as const
    : ['inspect', '--format'] as const;
  const target = kind === 'container' ? 'docker' : 'docker';
  const args = kind === 'network' ? ['network', command, format, '{{.Id}}', reference]
    : kind === 'volume' ? ['volume', command, format, '{{.Name}}', reference]
      : kind === 'image' ? ['image', command, format, '{{.Id}}', reference]
        : [command, format, '{{.Id}}', reference];
  try {
    await execute(target, args, { timeout: 15_000, maxBuffer: 4 * 1024 });
  } catch (error) {
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error
      ? String(error.stderr)
      : error instanceof Error ? error.message : String(error);
    if (/no such (?:object|container|image|network|volume)|not found/iu.test(stderr)) return;
    throw new Error(`could not verify owned ${kind} removal`);
  }
  throw new Error(`owned ${kind} remains after fixture cleanup`);
}

beforeAll(async () => {
  for (const name of ['CAUCE_TEST_DATABASE_URL', 'CAUCE_TEST_DOCKER_NETWORK', 'CAUCE_TEST_DOCKER_NETWORK_OWNER', 'CAUCE_UI_FUNCTIONAL_BROWSER_IMAGE']) {
    if (process.env[name] !== undefined) throw new Error(`this E2E requires its own disposable resources (${name} must be unset)`);
  }
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mock mode is not accepted by this real-browser test');
  fixture = await startConsoleFunctionalFixture();
  const active = fixture;
  const password = randomBytes(24).toString('base64url');
  const email = 'config-reader-navigation@cauce.test';
  const { stdout } = await execute(join(process.cwd(), 'node_modules/.bin/tsx'), [
    'services/gateway/src/console-user-cli.ts', '--email', email, '--name', 'Configuration read-only browser',
    '--role', 'reader', '--tenant', isaTenant.tenant, '--alias', isaTenant.operator,
  ], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test',
      DATABASE_URL: active.database.url, CAUCE_CONSOLE_USER_PASSWORD: password,
    },
    timeout: 15_000, maxBuffer: 64 * 1024,
  });
  if (!stdout.includes('cuenta guardada') || stdout.includes(password)) {
    throw new Error('reader account setup was not confirmed safely');
  }
  reader = { ...isaTenant, email, password };
  process.stdout.write(`config-reader owned resources postgres=${active.database.container.getId()} browser=${active.browserContainer} image=${active.browserRuntime.imageId}\n`);
}, 10 * 60_000);

afterAll(async () => {
  if (!fixture) return;
  const active = fixture;
  const references = [active.database.container.getId(), active.browserContainer];
  const errors: unknown[] = [];
  const inspected = await Promise.allSettled(references.map((reference) => inspectContainer(reference)));
  const resources: ResourceEvidence[] = [];
  for (const result of inspected) {
    if (result.status === 'fulfilled') resources.push(result.value);
    else errors.push(result.reason);
  }
  const networks = resources.flatMap((resource) => Object.entries(resource.networks)
    .filter(([name]) => name.startsWith('cauce-ui-network-'))
    .map(([name, value]) => ({ name, id: value.NetworkID })));
  const volumes = resources.flatMap((resource) => resource.mounts.flatMap((mount) =>
    mount.Type === 'volume' && typeof mount.Name === 'string' ? [mount.Name] : []));
  process.stdout.write(`config-reader resources-before-cleanup ${JSON.stringify({ containers: resources, networks, volumes })}\n`);

  try {
    await active.close();
  } catch (error) {
    errors.push(error);
  }
  const checks = [
    ...references.map((reference) => assertAbsent('container', reference)),
    ...networks.flatMap((network) => network.id ? [assertAbsent('network', network.id)] : []),
    ...volumes.map((volume) => assertAbsent('volume', volume)),
    ...(active.browserRuntime.owned ? [assertAbsent('image', active.browserRuntime.imageId)] : []),
  ];
  const outcomes = await Promise.allSettled(checks);
  for (const outcome of outcomes) if (outcome.status === 'rejected') errors.push(outcome.reason);
  process.stdout.write(`config-reader resources-after-cleanup ${JSON.stringify({
    containers: references, networkIds: networks.flatMap((item) => item.id ? [item.id] : []), volumes,
    absentChecksPassed: outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
    absentChecksFailed: outcomes.filter((outcome) => outcome.status === 'rejected').length,
  })}\n`);
  if (errors.length > 0) throw new AggregateError(errors, 'configuration reader browser fixture cleanup failed');
}, 60_000);

async function login(page: BrowserPage, user: FunctionalTenant): Promise<void> {
  if (!fixture) throw new Error('browser fixture was not initialized');
  const response = await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await page.getByLabel('Correo').waitFor({ timeout: 15_000 });
  await page.getByLabel('Correo').fill(user.email);
  await page.getByLabel('Contraseña').fill(user.password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).locator('a[href="/messages"], a[href^="/messages/"]').waitFor({ state: 'visible', timeout: 20_000 });
}

async function saveScreenshot(page: BrowserPage, name: string): Promise<void> {
  if (!artifactDirectory) return;
  await mkdir(artifactDirectory, { recursive: true });
  await page.screenshot({ path: join(artifactDirectory, name), fullPage: false });
}

describe('navegación de Configuración para lectores', () => {
  it('abre la vista de lectura en desktop y móvil sin habilitar cambios', async () => {
    if (!fixture || !reader) throw new Error('configuration reader fixture was not initialized');
    const active = fixture;
    const outcomes: { width: number; access: number; snapshot: number; deniedWrite: number; revisionBefore: number; revisionAfter: number }[] = [];

    for (const viewport of [{ width: 1440, height: 900 }, { width: 360, height: 800 }]) {
      const page = await newTrustedPage(active, viewport);
      const configReads: number[] = [];
      const changePosts: number[] = [];
      page.on('response', (response) => {
        const path = new URL(response.url()).pathname;
        if (path === '/v3/console/config' && response.request().method() === 'GET') configReads.push(response.status());
        if (path === '/v3/console/config/changes' && response.request().method() === 'POST') changePosts.push(response.status());
      });
      await login(page, reader);
      await page.getByRole('button', { name: 'Herramientas' }).click();
      const tools = page.getByRole('region', { name: 'Herramientas de Cauce' });
      const configLink = tools.getByRole('link', { name: 'Ajustes y altas' });
      await configLink.waitFor({ state: 'visible', timeout: 10_000 });
      const configLinkDisabled = await page.evaluate(() => document.querySelector('a[href="/config"]')?.getAttribute('aria-disabled'));
      expect(configLinkDisabled).not.toBe('true');
      await configLink.click();
      await page.getByRole('heading', { name: 'Ajustes y altas', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await page.getByRole('tab', { name: 'Avanzado', exact: true }).click();
      await page.getByText(/Solo lectura:/u).waitFor({ state: 'visible', timeout: 20_000 });

      const snapshot = await page.evaluate(async () => {
        const [accessResponse, configResponse, sessionResponse] = await Promise.all([
          fetch('/v3/console/access', { credentials: 'include' }),
          fetch('/v3/console/config', { credentials: 'include' }),
          fetch('/v3/auth/session', { credentials: 'include' }),
        ]);
        const access = await accessResponse.json() as { permissions?: string[] };
        const configuration = await configResponse.json() as { revision?: number };
        const session = await sessionResponse.json() as { authenticated?: boolean; csrf_token?: string };
        return {
          accessStatus: accessResponse.status, configStatus: configResponse.status,
          sessionStatus: sessionResponse.status, authenticated: session.authenticated,
          csrfToken: session.csrf_token, permissions: access.permissions ?? [], revision: configuration.revision,
        };
      });
      expect(snapshot.accessStatus).toBe(200);
      expect(snapshot.configStatus).toBe(200);
      expect(snapshot.sessionStatus).toBe(200);
      expect(snapshot.authenticated).toBe(true);
      expect(snapshot.permissions).not.toContain('config.write');
      if (typeof snapshot.revision !== 'number') throw new Error('configuration snapshot omitted its revision');
      if (typeof snapshot.csrfToken !== 'string' || snapshot.csrfToken.length < 32) {
        throw new Error('authenticated session omitted its CSRF token');
      }

      const writeButtons = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>('.config-pagina button'))
        .filter((button) => /previsualizar|preview|aplicar|crear|eliminar|rollback|deshacer/iu.test(button.innerText))
        .map((button) => ({ label: button.innerText.trim(), disabled: button.disabled })));
      expect(writeButtons.length).toBeGreaterThan(0);
      expect(writeButtons.every((button) => button.disabled), JSON.stringify(writeButtons)).toBe(true);

      const spacesTab = page.getByRole('tab', { name: 'Espacios y miembros' });
      await spacesTab.click();
      await page.getByRole('heading', { name: 'Tenants', exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
      await page.getByRole('button', { name: 'Espacio completo, paso a paso' }).click();
      await page.getByRole('heading', { name: 'Wizard de espacios', exact: true }).waitFor({ state: 'visible' });

      const wizardInputs = [
        { step: '1. Tenant', label: 'Tenant id' },
        { step: '2. Room', label: 'Room id' },
        { step: '3. Membership', label: 'Alias' },
        { step: '4. Harness', label: 'Harness id' },
      ];
      const wizardControls: { step: string; label: string; disabled: boolean }[] = [];
      for (const input of wizardInputs) {
        const step = page.getByRole('group', { name: 'Pasos del wizard' }).getByRole('button', { name: input.step });
        await step.click();
        await page.getByLabel(input.label).waitFor({ state: 'visible' });
        const disabled = await page.evaluate((label) => {
          const fieldLabel = Array.from(document.querySelectorAll('label'))
            .find((element) => element.textContent.trim().startsWith(label));
          return fieldLabel?.querySelector('input')?.disabled ?? null;
        }, input.label);
        wizardControls.push({ step: input.step, label: input.label, disabled: disabled === true });
      }
      expect(wizardControls).toEqual(wizardInputs.map((input) => ({ ...input, disabled: true })));

      await page.getByRole('group', { name: 'Pasos del wizard' }).getByRole('button', { name: '5. Dry-run y aplicar' }).click();
      const reviewActions = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const disabled = (label: string) => buttons.find((button) => button.textContent.includes(label))?.disabled ?? null;
        return {
          previewDisabled: disabled('Previsualizar paso'),
          applyDisabled: disabled('Aplicar paso'),
          resetDisabled: disabled('Reiniciar wizard'),
        };
      });
      expect(reviewActions).toEqual({ previewDisabled: true, applyDisabled: true, resetDisabled: false });
      await page.getByRole('button', { name: 'Reiniciar wizard' }).click();
      await page.getByLabel('Tenant id').waitFor({ state: 'visible' });
      const resetValue = await page.evaluate(() => {
        const fieldLabel = Array.from(document.querySelectorAll('label'))
          .find((element) => element.textContent.trim().startsWith('Tenant id'));
        return fieldLabel?.querySelector('input')?.value ?? null;
      });
      expect(resetValue).toBe('Acme');

      expect(changePosts).toEqual([]);

      const deniedWrite = await page.evaluate(async ({ revision, csrfToken }) => {
        const response = await fetch('/v3/console/config/changes', {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
          body: JSON.stringify({
            dry_run: true, expected_revision: revision,
            mutation: { resource: 'tenant', action: 'update', id: 'Isa', value: { display_name: 'Reader probe', enabled: true } },
          }),
        });
        return { status: response.status, body: await response.json() as { error?: string; message?: string } };
      }, { revision: snapshot.revision, csrfToken: snapshot.csrfToken });
      expect(deniedWrite.status).toBe(403);
      expect(deniedWrite.body).toEqual({ error: 'forbidden', message: 'operator role is required' });
      expect(changePosts).toEqual([403]);

      const after = await page.evaluate(async () => {
        const response = await fetch('/v3/console/config', { credentials: 'include' });
        const body = await response.json() as { revision?: number };
        return { status: response.status, revision: body.revision };
      });
      expect(after.status).toBe(200);
      if (typeof after.revision !== 'number') throw new Error('configuration reread omitted its revision');
      expect(after.revision).toBe(snapshot.revision);
      expect(configReads).toContain(200);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow, `configuration reader overflow at ${String(viewport.width)}px`).toBe(false);
      await saveScreenshot(page, `config-reader-${String(viewport.width)}.png`);
      outcomes.push({ width: viewport.width, access: snapshot.accessStatus, snapshot: snapshot.configStatus,
        deniedWrite: deniedWrite.status, revisionBefore: snapshot.revision, revisionAfter: after.revision });
    }
    process.stdout.write(`config-reader navigation evidence ${JSON.stringify(outcomes)}\n`);
  }, 180_000);
});
