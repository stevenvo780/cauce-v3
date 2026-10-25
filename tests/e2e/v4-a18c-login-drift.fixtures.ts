import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import { docker, command, enrollComputer, FIXTURE_PROVIDER_IDENTITY, startComputerHarness,
  type ComputerHarness, type ComputerRuntimeBundle } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { HostReleaseManifestSchema, HostSetupConfigSchema } from '../../services/gateway/src/fleet/host-setup.js';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';
import { startTrustedBrowser, type TrustedBrowser } from './console-functional-browser.fixtures.js';
import { installCancelDeploySetup, type CancelDeploySetup } from './v4-fleet-cancel-deploy.setup.js';
import { reserveNamedLoopbackPorts } from './port-reservation.js';
import { apiGet, asV4Page, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, openRegistration,
  syntheticPerson, type V4Page } from './v4-console-real-browser.helpers.js';

const execute = promisify(execFile);
const consoleRequire = createRequire(join(process.cwd(), 'console/package.json'));
export const OWNER = 'a18c-recrear-guiado-1025';
export const RUN = randomUUID().replaceAll('-', '').slice(0, 8);
export const PREFIX = 'zz-canary-' + OWNER + '-' + RUN;
export const RECEIPTS = join(process.cwd(), '.delegados/v4/recibos', OWNER, RUN);
export const PROVIDER = '/usr/local/bin/cauce-a18c-provider';
const SCRIPT = '/usr/local/lib/cauce-a18c-provider.py';
const SOURCE = 'tests/e2e/v4-a18c-provider.py';

const runtime: ComputerRuntimeBundle = {
  providerCli: await readFile(SOURCE, 'utf8'),
  sharedTui: true,
  async stage(directory) {
    await cp('packages/adapter-sdk/descriptors', join(directory, 'descriptors'), { recursive: true });
    const bin = join(directory, 'src/bin');
    await mkdir(bin, { recursive: true });
    for (const name of ['codex', 'shared-session']) {
      await execute('node_modules/.bin/esbuild', ['packages/adapter-sdk/src/bin/' + name + '.ts',
        '--bundle', '--platform=node', '--format=esm', '--target=node22', '--log-level=error',
        '--outfile=' + join(bin, name + '.js'), '--alias:@cauce/protocol=' + join(process.cwd(), 'packages/protocol/src'),
        '--banner:js=import{createRequire as __cauceRequire}from"node:module";const require=__cauceRequire(import.meta.url);']);
    }
    return ['@release@/adapter/src/bin/codex.js'];
  },
};

export interface A18cOperation {
  id: string; kind: string; status: string; version: number;
  error: { code?: string } | null;
  steps: { name: string; status: string }[];
}
export interface A18cFixture {
  computer: ComputerHarness; page: V4Page; baseUrl: string; tenant: string; host: string;
  account: string; room: string; company: string; unit: string; setup: CancelDeploySetup;
  firstImage: string; firstPortableImage: string; firstRelease: string; errors: BrowserErrorLog;
  deploy(): Promise<{ image: string; portableImage: string; release: string; adapterDigest: string }>;
  close(): Promise<void>;
}

export async function capture(page: V4Page, name: string): Promise<void> {
  const original = page.viewportSize();
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.screenshot({ path: join(RECEIPTS, name + '-' + String(viewport.width) + '.png') });
    }
  } finally { if (original) await page.setViewportSize(original); }
}

export async function operations(fixture: A18cFixture, alias: string): Promise<A18cOperation[]> {
  const read = await apiGet(fixture.page, '/v3/console/fleet/operations?resource=agent&tenant_id='
    + encodeURIComponent(fixture.tenant) + '&alias=' + encodeURIComponent(alias));
  expect(read.status).toBe(200);
  return read.body.operations as A18cOperation[];
}

export async function startA18cFixture(): Promise<A18cFixture> {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.DOCKER_HOST !== 'unix:///var/run/docker.sock') {
    throw new Error('A18c requires the official isolated lab runner');
  }
  await mkdir(RECEIPTS, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(tmpdir(), 'cauce-a18c-'));
  const tls = createSelfSignedCert({ directory });
  const ports = await reserveNamedLoopbackPorts(['frontend'] as const);
  const baseUrl = 'https://localhost:' + String(ports.ports.frontend);
  const images = new Map<string, string>();
  const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES]);
  let computer: ComputerHarness | undefined;
  let browser: TrustedBrowser | undefined;
  let vite: { close(): Promise<void>; listen(): Promise<void> } | undefined;
  const close = async () => {
    const failures: unknown[] = [];
    const attempt = async (action: () => Promise<unknown>) => { try { await action(); } catch (error) { failures.push(error); } };
    await attempt(async () => browser?.close());
    await attempt(async () => vite?.close());
    await attempt(() => ports.releaseAll());
    if (computer) {
      const active = computer;
      await attempt(async () => {
        const names = await docker(['ps', '-a', '--format', '{{.Names}}', '--filter', 'name=^/' + PREFIX + '-']);
        for (const name of names.split('\n').filter(value => value && value !== active.container)) await docker(['rm', '-f', name]);
      });
      for (const [tag, image] of [...images].reverse()) await attempt(async () => {
        const observed = await command('docker', ['image', 'inspect', '--format', '{{.Id}}', tag]);
        if (observed.code === 0) {
          expect(observed.stdout.trim()).toBe(image);
          await docker(['image', 'rm', tag]);
        } else if (!/no such image|not found/iu.test(observed.stderr)) throw new Error('owned image inspection failed');
      });
      await attempt(async () => {
        const inventory = await active.close();
        await writeFile(join(RECEIPTS, 'cleanup.json'), JSON.stringify(inventory, null, 2) + '\n');
        expect(inventory).toEqual({ containers: '', volumes: '', images: '' });
      });
    }
    await attempt(() => rm(directory, { recursive: true, force: true }));
    if (failures.length) throw new AggregateError(failures, 'A18c cleanup incomplete');
  };
  try {
    computer = await startComputerHarness({ prefix: PREFIX, resourceOwner: OWNER, workRoot: '/datos',
      consoleOrigins: [baseUrl], runtimeBundle: runtime });
    vite = await (consoleRequire('vite') as { createServer(config: Record<string, unknown>): Promise<NonNullable<typeof vite>> }).createServer({
      configFile: join(process.cwd(), 'console/vite.config.ts'), root: join(process.cwd(), 'console'), envDir: directory,
      cacheDir: join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: ports.ports.frontend, strictPort: true,
        watch: null, hmr: false, https: { key: await readFile(tls.key_path), cert: await readFile(tls.cert_path) },
        proxy: { '/v3': { target: computer.gatewayUrl, changeOrigin: false, ws: true } } },
    });
    await ports.release('frontend');
    await vite.listen();
    browser = await startTrustedBrowser(tls.cert_path, directory, [ports.ports.frontend, Number(new URL(computer.gatewayUrl).port)]);
    const context = await browser.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
    const page = asV4Page(await context.newPage());
    errors.watch(page, 'a18c-owner');
    const person = syntheticPerson('a18c', RUN);
    person.company = { name: PREFIX, slug: 'zz-a18c-' + RUN };
    const form = await openRegistration(page, baseUrl);
    await fillRegistration(form, person);
    await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
    await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
    const host = person.company.slug + '-pc';
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
    const installed = await installCancelDeploySetup(computer, baseUrl, person.company.slug, host);
    computer = installed.computer;
    const active = computer;
    const work = dirname(active.installRoot);
    const imageContext = join(directory, 'provider-image');
    await mkdir(imageContext);
    await cp(SOURCE, join(imageContext, 'provider.py'));
    // The login guardian requires the pinned command's argv to remain observable until its PTY starts.
    const launcher = ['#include <errno.h>', '#include <sys/wait.h>', '#include <unistd.h>', 'int main(int argc,char **argv){',
      'if(argc>120)return 2;char *a[124]={"/usr/local/bin/python3","' + SCRIPT + '"};',
      'for(int i=1;i<argc;i++)a[i+1]=argv[i];a[argc+1]=0;',
      'pid_t child=fork();if(child<0)return 126;if(!child){execv(a[0],a);_exit(127);}',
      'int status;while(waitpid(child,&status,0)<0){if(errno!=EINTR)return 126;}',
      'return WIFEXITED(status)?WEXITSTATUS(status):128+WTERMSIG(status);}'].join('\n') + '\n';
    await writeFile(join(imageContext, 'launcher.c'), launcher);
    await execute('/usr/bin/cc', ['-static', '-O2', '-o', join(imageContext, 'provider'), join(imageContext, 'launcher.c')]);
    const buildImage = async (phase: string, from: string) => {
      const parent = await docker(['image', 'inspect', '--format', '{{.Id}}', from]);
      const tag = PREFIX + ':' + phase;
      const recipe = ['FROM ' + from, 'COPY --chmod=0555 provider ' + PROVIDER,
        'COPY --chmod=0555 provider.py ' + SCRIPT,
        'RUN printf "%s\\n" "' + phase + '" > /etc/cauce-a18c-image', ''].join('\n');
      await writeFile(join(imageContext, 'Dockerfile'), recipe);
      const built = await command('docker', ['build', '-q', '--label', 'cauce.e2e.owner=' + OWNER, '-t', tag, imageContext]);
      if (built.code !== 0) throw new Error('owned provider image build failed: ' + built.stderr);
      const image = built.stdout.trim();
      expect(await docker(['image', 'inspect', '--format', '{{.Id}}', from])).toBe(parent);
      expect(await docker(['image', 'inspect', '--format', '{{.Id}}', tag])).toBe(image);
      images.set(tag, image);
      return { tag, image };
    };
    const publish = async (phase: string, image: { tag: string; image: string }) => {
      const stage = join(work, phase + '-stage');
      await cp(join(work, 'stage'), stage, { recursive: true });
      await writeFile(join(stage, 'adapter/a18c-release.txt'), phase + '\n');
      const output = join(work, phase + '-release');
      const current = installed.setup.approvedConfiguration();
      const packed = await execute('python3', ['ops/scripts/host-release.py', 'pack', '--stage', stage, '--out', output,
        '--revision', current.release.revision, '--image', image.tag, '--provider', 'codex=' + PROVIDER], { timeout: 300_000, maxBuffer: 1024 * 1024 });
      const manifest = HostReleaseManifestSchema.parse(JSON.parse(packed.stdout));
      if (!manifest.image || !manifest.pins.adapter_digest || !manifest.pins.codex_command || !manifest.pins.codex_command_sha256) throw new Error('owned release lacks measured image/provider pins');
      expect(await docker(['image', 'inspect', '--format', '{{.Id}}', image.tag])).toBe(image.image);
      await writeFile(join(RECEIPTS, phase + '-image.json'), JSON.stringify({
        builder_id: image.image, portable_config_id: manifest.image.id, reference: image.tag,
        archive_sha256: manifest.image.sha256, archive_size: manifest.image.size,
        binding: 'canonical pack validates the saved config against the immutable builder descriptor',
        provider_command: manifest.pins.codex_command, provider_sha256: manifest.pins.codex_command_sha256,
      }, null, 2) + '\n');
      const template = current.policy.profile_templates[0];
      const bundle = current.policy.bundles.codex;
      if (!template || !bundle) throw new Error('owned signed setup lacks its profile or bundle template');
      installed.setup.publish(HostSetupConfigSchema.parse({ ...current,
        release: { name: 'release', revision: manifest.revision, path: join(output, manifest.release.file), sha256: manifest.release.sha256, size: manifest.release.size },
        image: { name: 'agent-image', path: join(output, manifest.image.file), sha256: manifest.image.sha256, size: manifest.image.size, id: manifest.image.id },
        policy: { ...current.policy, bundles: { ...current.policy.bundles, codex: { ...bundle, digest: manifest.pins.adapter_digest, shared_tui: true } },
          container_templates: current.policy.container_templates.map(value => ({ ...value, image: manifest.image?.id })),
          profile_templates: [{ ...template, command: manifest.pins.codex_command, command_sha256: manifest.pins.codex_command_sha256,
            login: { method: 'device', command: [manifest.pins.codex_command, 'login', '--device-auth'], sha256: manifest.pins.codex_command_sha256 } }] },
      }));
      const imageReference = 'cauce-host-image:' + manifest.image.id.replace(/^sha256:/u, '');
      images.set(imageReference, image.image);
      return { image: image.image, portableImage: manifest.image.id, imageReference,
        release: manifest.release.sha256, adapterDigest: manifest.pins.adapter_digest };
    };
    const first = await buildImage('initial', PREFIX + ':computer');
    const initial = await publish('initial', first);
    const authenticated = await active.app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: baseUrl },
      payload: { email: person.email, password: person.password } });
    expect(authenticated.statusCode).toBe(200);
    const header = authenticated.headers['set-cookie'];
    const cookie = (Array.isArray(header) ? header : header === undefined ? [] : [header]).map(value => value.split(';', 1)[0]).join('; ');
    let unit: string;
    try {
      unit = await enrollComputer(active, { cookie, origin: baseUrl, 'x-csrf-token': authenticated.json<{ csrf_token: string }>().csrf_token }, person.company.slug, host);
    } catch (error) {
      const installedRoot = join(active.installRoot, person.company.slug, host);
      const check = await active.onComputer(['python3', '-B', join(installedRoot, 'release', initial.release, 'ops/cli/fleet-executor.py'),
        '--policy', join(installedRoot, 'executor-policy.json'), '--capabilities']);
      await writeFile(join(RECEIPTS, 'executor-setup-failure.json'), JSON.stringify({ exit: check.code,
        stdout: check.stdout.slice(0, 2048), stderr: check.stderr.slice(0, 2048) }, null, 2) + '\n');
      throw error;
    }
    expect(await docker(['image', 'inspect', '--format', '{{.Id}}', initial.imageReference])).toBe(initial.image);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
    const tenant = (await active.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [person.email])).rows[0]?.tenant_id;
    if (!tenant) throw new Error('owned registration lacks its tenant');
    const room = (await active.pool.query<{ id: string }>('SELECT id FROM rooms WHERE tenant_id=$1 AND enabled ORDER BY id', [tenant])).rows[0]?.id;
    if (!room) throw new Error('owned registration lacks its room');
    const account = 'zz-a18c-' + RUN;
    await active.pool.query("INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled) VALUES($1,'codex',$2,$3,'env_path','CAUCE_A18C_TEST_PROFILE_PATH',true)",
      [account, FIXTURE_PROVIDER_IDENTITY, tenant]);
    return { computer: active, page, baseUrl, tenant, host, room, account, unit, company: person.company.slug,
      setup: installed.setup, firstImage: initial.image, firstPortableImage: initial.portableImage, firstRelease: initial.release, errors, close,
      deploy: async () => {
        const image = await buildImage('updated', first.tag);
        const result = await publish('updated', image);
        const applied = await active.cli(['setup', '--install-root', active.installRoot]);
        if (applied.code !== 0) throw new Error('owned signed setup failed: ' + applied.stderr);
        expect(await docker(['image', 'inspect', '--format', '{{.Id}}', result.imageReference])).toBe(result.image);
        return result;
      } };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'A18c fixture setup and cleanup failed'); }
    throw error;
  }
}
