import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { companyCatalog, loadCatalog } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { DecisionService } from '../src/decide.js';
import { Limits } from '../src/limits.js';

const CATALOG = fileURLToPath(new URL('../catalogo/', import.meta.url));
const directories: string[] = [];
async function temporaryCatalog(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-decision-catalog-'));
  directories.push(directory);
  await cp(CATALOG, directory, { recursive: true });
  return directory;
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('company catalog boundaries', () => {
  it('does not resolve private templates for an unknown company or allow a scoped catalog to be reused', async () => {
    const root = await loadCatalog(CATALOG);
    const own = companyCatalog(root, 'humanizar');
    expect(own.plantillas.size).toBe(11);
    expect(companyCatalog(root, 'unknown').plantillas.size).toBe(5);
    expect(companyCatalog(root, '../humanizar').plantillas.size).toBe(5);
    expect(() => companyCatalog(own, 'praxis')).toThrow(/otra empresa/u);
  });

  it('refuses private definitions that replace common templates', async () => {
    const directory = await temporaryCatalog();
    await cp(join(directory, 'plantillas', 'requiere_respuesta.json'), join(directory, 'empresas', 'humanizar', 'plantillas', 'requiere_respuesta.json'));
    await expect(loadCatalog(directory)).rejects.toThrow(/no reemplaza una común/u);
  });

  it('refuses symlink companies and template files and does not ignore incomplete company directories', async () => {
    const directory = await temporaryCatalog();
    await symlink(join(directory, 'empresas', 'humanizar'), join(directory, 'empresas', 'foreign'));
    await expect(loadCatalog(directory)).rejects.toThrow(/empresa inválido/u);
    await rm(join(directory, 'empresas', 'foreign'));
    const original = join(directory, 'empresas', 'humanizar', 'plantillas', 'ruteo_alias.json');
    const copy = join(directory, 'private-copy.json');
    await cp(original, copy);
    await rm(original);
    await symlink(copy, original);
    await expect(loadCatalog(directory)).rejects.toThrow(/fichero regular/u);
    await rm(original);
    await cp(copy, original);
    await mkdir(join(directory, 'empresas', 'unfinished'));
    await expect(loadCatalog(directory)).rejects.toThrow();
  });

  it('requires enablement scoped by company even for same-named private templates', async () => {
    const directory = await temporaryCatalog();
    await mkdir(join(directory, 'empresas', 'praxis', 'plantillas'), { recursive: true });
    await cp(join(directory, 'empresas', 'humanizar', 'plantillas', 'guardia_privacidad_jarvis.json'), join(directory, 'empresas', 'praxis', 'plantillas', 'guardia_privacidad_jarvis.json'));
    const service = new DecisionService({
      catalog: await loadCatalog(directory), redact: true,
      enabledTemplates: new Set(['humanizar/guardia_privacidad_jarvis']),
      jev: { maxRequests: 1, credentialPresent: async () => true, evaluate: async () => { throw new Error('unexpected provider call'); } },
      audit: { write: async () => undefined },
      limits: new Limits({ perMinute: 60, burst: 20, dailyInputTokens: 1_000, dailyInputTokensTotal: 10_000, concurrency: 4, concurrencyPerAlias: 1 }),
    });
    const enabled = (company: string) => (service.listing({ company, tenant: 'Fixture', alias: 'jarvis' }).plantillas as { id: string; habilitada: boolean }[]).find((entry) => entry.id === 'guardia_privacidad_jarvis')?.habilitada;
    expect(enabled('humanizar')).toBe(true);
    expect(enabled('praxis')).toBe(false);
    await expect(service.decide({ company: 'praxis', tenant: 'Fixture', alias: 'jarvis' }, { plantilla: 'guardia_privacidad_jarvis', state: { texto_saliente: 'fixture' } })).rejects.toMatchObject({ code: 'plantilla_deshabilitada' });
  });
});

describe('database configuration', () => {
  const base = { CAUCE_DECISIONES_TLS_CERT_FILE: 'c', CAUCE_DECISIONES_TLS_KEY_FILE: 'k', CAUCE_DECISIONES_CLIENT_CA_FILE: 'a', CAUCE_DECISIONES_IDENTITY_FILE: 'i' };
  it('reads a mounted secret in memory and refuses ambiguous or missing settings without printing the value', async () => {
    const directory = await temporaryCatalog();
    const file = join(directory, 'fixture-dsn');
    await writeFile(file, 'postgresql://fixture:fixture-private@localhost/cauce_test_fixture\n', { mode: 0o600 });
    expect(loadConfig({ ...base, CAUCE_DECISIONES_DATABASE_URL_FILE: file }).databaseUrl).toBe((await readFile(file, 'utf8')).trim());
    expect(() => loadConfig({ ...base, CAUCE_DECISIONES_DATABASE_URL: 'postgresql://fixture', CAUCE_DECISIONES_HABILITAR_PLANTILLAS: 'guardia_privacidad_jarvis' })).toThrow(/empresa\/id/u);
    expect(() => loadConfig(base)).toThrow(/falta.*DATABASE_URL/u);
    expect(() => loadConfig({ ...base, CAUCE_DECISIONES_DATABASE_URL_FILE: file, CAUCE_DECISIONES_DATABASE_URL: 'postgresql://fixture' })).toThrow(/excluyentes/u);
    expect(() => loadConfig({ ...base, CAUCE_DECISIONES_DATABASE_URL_FILE: 'relative' })).toThrow(/absoluta/u);
    expect(() => loadConfig({ ...base, CAUCE_DECISIONES_DATABASE_URL_FILE: join(directory, 'missing') })).toThrow(/no está disponible/u);
    expect(() => loadConfig({ ...base, CAUCE_DECISIONES_DATABASE_URL: 'fixture-private' })).toThrow('la conexión PostgreSQL no es una URL válida');
  });
});
