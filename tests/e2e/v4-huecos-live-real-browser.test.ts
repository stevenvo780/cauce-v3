import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES,
  type IgnoredConsoleRule, openRegistration, PATTERN_DEFECT_RULE, syntheticPerson, type V4Page,
} from './v4-console-real-browser.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const owner = syntheticPerson('live', run);
const agentAlias = `hueco-live-${run}`;
const artifactDirectory = join(process.cwd(), '.delegados/v4/recibos/e2e-huecos-a2-1025/live');
const LIVE_HUECOS_RULES: IgnoredConsoleRule[] = [
  ...HERMETIC_INSTANCE_RULES,
  PATTERN_DEFECT_RULE,
  {
    id: 'backups-404',
    reason: 'hermetic test without space backups',
    matches: (text, url) => text.includes('status of 404') && url.includes('/backups'),
  },
  {
    id: 'directive-404',
    reason: 'hermetic test without active directive for test agent',
    matches: (text, url) => text.includes('status of 404') && url.includes('/directive'),
  },
  {
    id: 'native-skill-501',
    reason: 'unsupported native editing on test agent harness',
    matches: (text, url) => text.includes('status of 501') && url.includes('/native/skill'),
  },
];
const errors = new BrowserErrorLog(LIVE_HUECOS_RULES);
const originalDeadlineFactor = process.env.CAUCE_PLAZOS_FACTOR;
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let tenant = '';
let pageA: V4Page | undefined;

const active = () => {
  if (!fixture) throw new Error('Live huecos fixture is not initialized');
  return fixture;
};
const pool = () => active().database.pool;
const base = () => active().baseUrl;

async function freshPage(label: string): Promise<V4Page> {
  const page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
  errors.watch(page, label);
  return page;
}

async function step<T>(page: V4Page, name: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (cause) {
    throw new Error(`${name} failed at ${page.url()}: ${await bodySnippet(page)} || console=${JSON.stringify(errors.trace.slice(-12))}`, { cause });
  }
}

async function shot(page: V4Page, name: string): Promise<void> {
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  await page.screenshot({ path: join(artifactDirectory, `${name}.png`), fullPage: true });
}

async function register(page: V4Page, person: typeof owner): Promise<void> {
  const form = await openRegistration(page, base());
  await fillRegistration(form, person);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
}

beforeAll(async () => {
  process.env.CAUCE_PLAZOS_FACTOR ??= '3';
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('this E2E requires its own Testcontainers PostgreSQL');
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mocks=false is required');
  const repositoryRoot = process.env.CAUCE_CONTEXT_REPOSITORY_ROOT;
  delete process.env.CAUCE_CONTEXT_REPOSITORY_ROOT;
  try {
    fixture = await startConsoleFunctionalFixture();
    await mkdir(artifactDirectory, { recursive: true });
  } finally {
    if (repositoryRoot !== undefined) process.env.CAUCE_CONTEXT_REPOSITORY_ROOT = repositoryRoot;
  }
}, 600_000);

afterAll(async () => {
  try {
    await fixture?.close();
  } finally {
    if (originalDeadlineFactor === undefined) delete process.env.CAUCE_PLAZOS_FACTOR;
    else process.env.CAUCE_PLAZOS_FACTOR = originalDeadlineFactor;
  }
}, 180_000);

describe('huecos de live y contexto en navegador real contra gateway y PostgreSQL reales', () => {
  it('registra empresa, siembra agente y valida aviso de agente ausente en la oficina', async () => {
    pageA = await freshPage('owner');
    const page = pageA;
    await step(page, 'registro de empresa', async () => register(page, owner));

    const identity = await pool().query<{ id: string; tenant_id: string }>(
      'SELECT id::text,tenant_id FROM console_users WHERE email=$1', [owner.email],
    );
    tenant = identity.rows[0]?.tenant_id ?? '';
    expect(tenant).not.toBe('');

    await pool().query(
      `INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory,company_id)
       VALUES($1,$2,'codex',$2,false,$3,'stev',$4,$5,$6)`,
      [tenant, agentAlias, `cauce-e2e-${run}`, `/srv/cauce-e2e/${run}`, `/srv/cauce-e2e/${run}/state`, owner.company.slug],
    );
    await pool().query(
      "INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'agent')",
      [tenant, agentAlias],
    );
    await pool().query(
      'INSERT INTO agent_profiles(tenant_id,alias,role_summary) VALUES($1,$2,$3)',
      [tenant, agentAlias, 'Agente canario para probar directiva, recarga y reconciliación.'],
    );

    await step(page, 'aviso de agente faltante en oficina', async () => {
      await page.goto(`${base()}/live?agente=agente-inexistente`, { waitUntil: 'domcontentloaded' });
      const notice = page.getByRole('status').filter({ hasText: 'No se encontró el agente «agente-inexistente»' });
      await notice.waitFor({ timeout: 20_000 });
      await shot(page, 'live-agente-faltante-1440');

      const volver = page.getByRole('button', { name: 'Ver la oficina', exact: true });
      await volver.click();
      await page.getByRole('heading', { name: 'Oficina', exact: true }).waitFor({ timeout: 20_000 });
      expect(page.url()).not.toContain('agente-inexistente');
    });
  });

  it('directiva: recorre capas del rol, manual y memoria, y navega a perfil y ficheros', async () => {
    const page = pageA ?? await freshPage('owner');
    const contextUrl = `${base()}/messages/${tenant}/${agentAlias}?view=context`;

    await step(page, 'abrir contexto y pestaña directiva', async () => {
      await page.goto(contextUrl, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: `Perfil y contexto de ${agentAlias}`, exact: true }).waitFor({ timeout: 20_000 });

      const tabDirectiva = page.getByRole('tab', { name: 'Directiva', exact: true });
      await tabDirectiva.click();
      await page.getByRole('heading', { name: 'Capa 1 · Rol declarado', exact: true }).waitFor({ timeout: 20_000 });
      await page.getByRole('heading', { name: 'Capa 2 · Manual del sitio', exact: true }).waitFor({ timeout: 20_000 });
      await page.getByRole('heading', { name: 'Capa 3 · Memoria', exact: true }).waitFor({ timeout: 20_000 });

      await shot(page, 'directiva-capas-1440');
      await page.setViewportSize({ width: 390, height: 844 });
      await shot(page, 'directiva-capas-390');
      await page.setViewportSize({ width: 1440, height: 900 });

      const botonEditarPerfil = page.getByRole('button', { name: 'Editar los campos canónicos', exact: true });
      await botonEditarPerfil.click();
      await page.getByText('Campos canónicos de', { exact: false }).waitFor({ timeout: 20_000 });

      await page.getByRole('tab', { name: 'Directiva', exact: true }).click();
      const botonEditarFicheros = page.getByRole('button', { name: 'Editar el manual en Ficheros', exact: true });
      await botonEditarFicheros.click();
      await page.getByRole('tab', { name: /Ficheros/u }).waitFor({ timeout: 20_000 });
    });
  });

  it('piezas nativas: despliega editor, consulta inventario nativo con fallo tipado y valida controles', async () => {
    const page = pageA ?? await freshPage('owner');
    await step(page, 'editor de piezas nativas', async () => {
      await page.getByRole('tab', { name: /Perfil/u }).click();
      const detallesNativas = page.locator('details.native-context-repository');
      await detallesNativas.getByText('Piezas nativas · MCP, skills y subagentes', { exact: true }).click();

      const editor = page.getByRole('region', { name: 'Editor de piezas nativas', exact: true });
      await editor.waitFor({ timeout: 20_000 });

      await editor.getByRole('button', { name: 'Leer inventario nativo', exact: true }).click();

      await editor.getByRole('alert').waitFor({ timeout: 20_000 });
      expect(await editor.getByRole('alert').innerText()).toContain('no publica edición nativa');

      const botonGuardar = editor.getByRole('button', { name: 'Guardar pieza nativa', exact: true });
      expect(await botonGuardar.isDisabled()).toBe(true);

      await shot(page, 'piezas-nativas-panel-1440');
    });
  });

  it('perfil canónico: prepara borrador persistente en PostgreSQL para el inicio', async () => {
    const page = pageA ?? await freshPage('owner');
    await step(page, 'preparar campos canónicos', async () => {
      const campoProposito = page.getByLabel('Identidad y propósito', { exact: false });
      await campoProposito.fill('Coordinador canario de pruebas E2E');

      const campoMotivo = page.getByLabel('Motivo de este cambio de perfil', { exact: false });
      await campoMotivo.fill('Actualizando perfil canónico para prueba E2E');

      const botonPreparar = page.getByRole('button', { name: 'Preparar perfil para el inicio', exact: true });
      await expect.poll(async () => botonPreparar.isDisabled(), { timeout: 10_000 }).toBe(false);

      await botonPreparar.click();
      await page.getByText('Borrador sin guardar.', { exact: false }).waitFor({ state: 'hidden', timeout: 20_000 });

      const dbProfile = (await pool().query<{ purpose: string }>(
        'SELECT purpose FROM agent_profiles WHERE tenant_id=$1 AND alias=$2',
        [tenant, agentAlias],
      )).rows[0];
      expect(dbProfile?.purpose).toBe('Coordinador canario de pruebas E2E');

      await shot(page, 'perfil-canonico-preparado-1440');
    });
  });

  it('sin errores inesperados en el registro del navegador', () => {
    errors.assertClean();
  });
});
