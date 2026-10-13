import { randomUUID } from 'node:crypto';
import { normalizeAgentProfile } from '@cauce/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES,
  openRegistration, PATTERN_DEFECT_RULE, syntheticPerson, type V4Locator, type V4Page,
} from './v4-console-real-browser.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const owner = syntheticPerson('files', run);
const agentAlias = `archivos-${run}`;
const roleSummary = 'Agente de la ficha de archivos.';
const mission = { path: 'context/mission.md', content: 'Misión que permanece en el contexto.' };
const notes = { path: 'context/notes.md', content: 'Nota que la ficha retira del contexto.' };
const profilePath = 'context/profile.json';
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE]);
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let tenant = '';
let ownerId = '';

interface ContextFile { path: string; content: string }
interface StoredVersion {
  version: number; source: string; restored_from: number | null;
  actor_human_id: string; actor_alias: string; files: ContextFile[];
}
interface HistoryView {
  version: number; source: string; restored_from: number | null; actor_human_id: string; actor_alias: string;
}

const active = () => { if (!fixture) throw new Error('V4 fixture is not initialized'); return fixture; };
const pool = () => active().database.pool;
const base = () => active().baseUrl;
const contextPath = () => `/v3/console/context/agents/${tenant}/${agentAlias}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contextFiles(value: unknown): ContextFile[] {
  if (!Array.isArray(value)) throw new Error('context files are not a list');
  return value.map((item) => {
    if (!isRecord(item) || typeof item.path !== 'string' || typeof item.content !== 'string') {
      throw new Error('context file is incomplete');
    }
    return { path: item.path, content: item.content };
  });
}

function historyViews(body: Record<string, unknown>): HistoryView[] {
  if (!Array.isArray(body.entries)) throw new Error('history has no entries');
  return body.entries.map((item) => {
    if (!isRecord(item) || typeof item.version !== 'number' || typeof item.source !== 'string'
      || typeof item.actor_human_id !== 'string' || typeof item.actor_alias !== 'string'
      || !(item.restored_from === null || typeof item.restored_from === 'number')) {
      throw new Error('history entry is incomplete');
    }
    return {
      version: item.version, source: item.source, restored_from: item.restored_from,
      actor_human_id: item.actor_human_id, actor_alias: item.actor_alias,
    };
  });
}

function profileFile(): ContextFile {
  const input: Record<string, unknown> = {
    tenant_id: tenant, alias: agentAlias, purpose: null, role_summary: roleSummary,
    human_brief: null, responsibilities: [], restrictions: [], tools: [], operating_rules: [],
  };
  return { path: profilePath, content: JSON.stringify(normalizeAgentProfile(input)) };
}

function sortedFiles(files: ContextFile[]): ContextFile[] {
  return [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

async function freshPage(label: string): Promise<V4Page> {
  const page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 1000 }));
  errors.watch(page, label);
  return page;
}

async function step<T>(page: V4Page, name: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (cause) {
    throw new Error(`${name} failed at ${page.url()}: ${await bodySnippet(page)} || console=${JSON.stringify(errors.trace.slice(-12))}`, { cause });
  }
}

async function register(page: V4Page): Promise<void> {
  const form = await openRegistration(page, base());
  await fillRegistration(form, owner);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
}

async function showVersions(page: V4Page): Promise<V4Locator> {
  await page.getByRole('heading', { name: `Perfil y contexto de ${agentAlias}`, exact: true }).waitFor({ timeout: 20_000 });
  await page.getByRole('tab', { name: 'Versiones y aplicación', exact: true }).click();
  const versions = page.getByRole('region', { name: 'Versiones de contexto', exact: true });
  await versions.getByRole('heading', { name: 'Contexto versionado', exact: true }).waitFor({ timeout: 20_000 });
  return versions;
}

async function openFromSheet(page: V4Page): Promise<V4Locator> {
  await page.goto(`${base()}/live`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Plano editable', exact: true }).click();
  await page.getByRole('region', { name: `Sala ${tenant}/office`, exact: true }).getByRole('button').first().click();
  await page.getByRole('region', { name: `Agentes de sala ${tenant}/office`, exact: true })
    .getByRole('button', { name: new RegExp(agentAlias, 'u') }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'Perfil y contexto', exact: true }).click();
  return showVersions(page);
}

function fileSelect(versions: V4Locator): V4Locator {
  return versions.locator('select');
}

async function listedFiles(versions: V4Locator): Promise<string[]> {
  return fileSelect(versions).evaluate((element) =>
    Array.from(element.querySelectorAll('option')).map((option) => option.textContent.trim()));
}

function editor(versions: V4Locator): V4Locator {
  return versions.locator('textarea');
}

async function addFile(versions: V4Locator, file: ContextFile): Promise<void> {
  await versions.getByLabel('Nuevo archivo', { exact: true }).fill(file.path);
  await versions.getByRole('button', { name: 'Añadir archivo', exact: true }).click();
  await expect.poll(() => fileSelect(versions).inputValue(), { timeout: 15_000 }).toBe(file.path);
  await editor(versions).fill(file.content);
  await expect.poll(() => editor(versions).inputValue(), { timeout: 15_000 }).toBe(file.content);
}

async function storedVersions(): Promise<StoredVersion[]> {
  const result = await pool().query<{
    version: string; source: string; restored_from: string | null;
    actor_human_id: string; actor_alias: string; files: unknown;
  }>(`SELECT version::text,source,restored_from::text,actor_human_id::text,actor_alias,files
      FROM agent_context_versions WHERE tenant_id=$1 AND alias=$2 ORDER BY version`, [tenant, agentAlias]);
  return result.rows.map((row) => ({
    version: Number(row.version), source: row.source,
    restored_from: row.restored_from === null ? null : Number(row.restored_from),
    actor_human_id: row.actor_human_id, actor_alias: row.actor_alias, files: contextFiles(row.files),
  }));
}

function stored(version: number, source: string, restoredFrom: number | null, files: ContextFile[]): StoredVersion {
  return {
    version, source, restored_from: restoredFrom, actor_human_id: ownerId, actor_alias: 'owner',
    files: sortedFiles(files),
  };
}

function history(version: number, source: string, restoredFrom: number | null): HistoryView {
  return { version, source, restored_from: restoredFrom, actor_human_id: ownerId, actor_alias: 'owner' };
}

async function readSnapshot(page: V4Page): Promise<{ version: number; files: ContextFile[] }> {
  const response = await apiGet(page, contextPath());
  if (response.status !== 200 || typeof response.body.version !== 'number') {
    throw new Error(`context snapshot returned ${String(response.status)}`);
  }
  return { version: response.body.version, files: contextFiles(response.body.files) };
}

async function readHistory(page: V4Page): Promise<HistoryView[]> {
  const response = await apiGet(page, `${contextPath()}/history`);
  if (response.status !== 200) throw new Error(`context history returned ${String(response.status)}`);
  return historyViews(response.body);
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('this E2E requires its own Testcontainers PostgreSQL');
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mocks=false is required');
  const repositoryRoot = process.env.CAUCE_CONTEXT_REPOSITORY_ROOT;
  delete process.env.CAUCE_CONTEXT_REPOSITORY_ROOT;
  try { fixture = await startConsoleFunctionalFixture(); }
  finally {
    if (repositoryRoot !== undefined) process.env.CAUCE_CONTEXT_REPOSITORY_ROOT = repositoryRoot;
  }
}, 600_000);

afterAll(async () => { await fixture?.close(); }, 180_000);

describe('archivos de contexto en navegador real contra gateway y PostgreSQL reales', () => {
  it('desde la ficha retira un archivo del contexto y lo recupera al restaurar', async () => {
    const page = await freshPage('owner');
    await step(page, 'registro de la dueña', async () => register(page));
    const identity = await pool().query<{ id: string; tenant_id: string }>(
      'SELECT id::text,tenant_id FROM console_users WHERE email=$1', [owner.email]);
    ownerId = identity.rows[0]?.id ?? '';
    tenant = identity.rows[0]?.tenant_id ?? '';
    expect(ownerId).not.toBe('');
    expect(tenant).not.toBe('');
    const withProfile = sortedFiles([mission, notes, profileFile()]);
    const withoutNotes = sortedFiles([mission, profileFile()]);

    await pool().query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory,company_id)
      VALUES($1,$2,'codex',$2,true,$3,'stev',$4,$5,$6)`,
    [tenant, agentAlias, `cauce-e2e-files-${run}`, `/srv/cauce-e2e/files/${run}`, `/srv/cauce-e2e/files/${run}/state`, owner.company.slug]);
    await pool().query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'agent')", [tenant, agentAlias]);
    await pool().query('INSERT INTO agent_profiles(tenant_id,alias,role_summary) VALUES($1,$2,$3)', [tenant, agentAlias, roleSummary]);

    const versions = await step(page, 'abrir versiones desde la ficha', () => openFromSheet(page));
    await step(page, 'guardar la versión con los dos archivos', async () => {
      await versions.getByLabel('Nuevo archivo', { exact: true }).waitFor({ timeout: 20_000 });
      await addFile(versions, mission);
      await addFile(versions, notes);
      await versions.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
      await versions.getByText(/Versión 1 · Consola · owner/u).waitFor({ timeout: 20_000 });
      await expect.poll(() => listedFiles(versions), { timeout: 15_000 }).toEqual(withProfile.map((file) => file.path));
    });
    expect(await storedVersions()).toEqual([stored(1, 'ui', null, withProfile)]);

    await step(page, 'retirar el archivo y guardar la versión nueva', async () => {
      await fileSelect(versions).selectOption(notes.path);
      await versions.getByRole('button', { name: 'Quitar este archivo del borrador', exact: true }).click();
      await versions.getByText('Borrador sin guardar, basado en la versión 1.', { exact: true }).waitFor({ timeout: 15_000 });
      await expect.poll(() => listedFiles(versions), { timeout: 15_000 }).toEqual(withoutNotes.map((file) => file.path));
      await versions.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
      await versions.getByText('Versión guardada. La aplicación y sincronización se acreditan por separado.', { exact: true })
        .waitFor({ timeout: 20_000 });
      await versions.getByText(/Versión 2 · Consola · owner/u).waitFor({ timeout: 20_000 });
      await expect.poll(() => fileSelect(versions).inputValue(), { timeout: 15_000 }).toBe(mission.path);
      expect(await editor(versions).inputValue()).toBe(mission.content);
    });
    expect(await storedVersions()).toEqual([
      stored(1, 'ui', null, withProfile),
      stored(2, 'ui', null, withoutNotes),
    ]);
    await step(page, 'el historial muestra la baja del archivo', async () => {
      await versions.getByRole('button', { name: 'Ver diferencias de versión 1', exact: true }).click();
      const diff = versions.getByRole('region', { name: 'Diferencias de contexto', exact: true });
      await diff.getByText(`${notes.path} · Eliminado`, { exact: true }).waitFor({ timeout: 15_000 });
      expect(await diff.locator('summary').count()).toBe(1);
      expect(await diff.locator('pre').nth(0).innerText()).toBe(notes.content);
      expect(await diff.locator('pre').nth(1).innerText()).toBe('Eliminado');
    });

    const reloaded = await step(page, 'la versión sin el archivo sigue tras recargar', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const again = await showVersions(page);
      await again.getByText(/Versión 2 · Consola · owner/u).waitFor({ timeout: 20_000 });
      await expect.poll(() => listedFiles(again), { timeout: 15_000 }).toEqual(withoutNotes.map((file) => file.path));
      await expect.poll(() => fileSelect(again).inputValue(), { timeout: 15_000 }).toBe(mission.path);
      expect(await editor(again).inputValue()).toBe(mission.content);
      return again;
    });
    expect(await readSnapshot(page)).toEqual({ version: 2, files: withoutNotes });
    expect(await readHistory(page)).toEqual([history(2, 'ui', null), history(1, 'ui', null)]);

    await step(page, 'restaurar la versión anterior devuelve el archivo', async () => {
      await reloaded.getByRole('button', { name: 'Restaurar versión 1', exact: true }).click();
      const confirmation = reloaded.getByRole('region', { name: 'Confirmar restauración', exact: true });
      await confirmation.getByRole('button', { name: 'Confirmar restauración', exact: true }).click();
      await reloaded.getByText('Restauración guardada como una versión nueva.', { exact: true }).waitFor({ timeout: 20_000 });
      await reloaded.getByText(/Versión 3 · Restauración · owner/u).waitFor({ timeout: 20_000 });
      await reloaded.getByText(/restaurada de 1/u).waitFor({ timeout: 15_000 });
      await expect.poll(() => listedFiles(reloaded), { timeout: 15_000 }).toEqual(withProfile.map((file) => file.path));
      await fileSelect(reloaded).selectOption(notes.path);
      await expect.poll(() => editor(reloaded).inputValue(), { timeout: 15_000 }).toBe(notes.content);
    });
    expect(await storedVersions()).toEqual([
      stored(1, 'ui', null, withProfile),
      stored(2, 'ui', null, withoutNotes),
      stored(3, 'restore', 1, withProfile),
    ]);
    expect(await readSnapshot(page)).toEqual({ version: 3, files: withProfile });
    expect(await readHistory(page)).toEqual([
      history(3, 'restore', 1), history(2, 'ui', null), history(1, 'ui', null),
    ]);
    errors.assertClean();
  }, 180_000);
});
