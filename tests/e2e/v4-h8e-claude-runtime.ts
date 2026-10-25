import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { build } from 'esbuild';
import { browserDocker, browserErrorStderr, browserExec } from './browser-owned-lifecycle.js';

export const H8E_OWNER = 'h8e-login-caducado-claude-real-1025';
export const H8E_RUN = randomUUID();
export const H8E_PREFIX = `zz-canary-${H8E_OWNER}-${H8E_RUN}`;
export const H8E_EVIDENCE = join(process.cwd(), '.delegados/v4/recibos', H8E_OWNER, H8E_RUN);
const labels = ['--label', `cauce.e2e.owner=${H8E_OWNER}`, '--label', `cauce.e2e.run=${H8E_RUN}`];

export async function h8eReceipt(name: string, value: unknown): Promise<void> {
  await mkdir(H8E_EVIDENCE, { recursive: true, mode: 0o700 });
  await writeFile(join(H8E_EVIDENCE, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

export function redactH8ePane(raw: string): string {
  const lines = stripVTControlCharacters(raw).split('\n');
  const safe: string[] = [];
  for (const line of lines) {
    const plain = line.trim();
    const expired = /^([●⏺])\s+Login expired\s*·\s*Please run \/login[.!]?$/u.exec(plain);
    if (expired) safe.push(`${expired[1] ?? ''} Login expired · Please run /login`);
    else if (/^[●⏺]\s+Please run \/login\s*·\s*API Error: 401\b/u.test(plain)) safe.push('● Please run /login · API Error: 401 [detail omitted]');
    else if (/^Paste code here if prompted\s*>\s*$/u.test(plain)) safe.push('   Paste code here if prompted >');
    else if (plain === 'Esc to cancel') safe.push('   Esc to cancel');
    else if (plain === 'Login') safe.push('   Login');
    else if (plain === 'Select login method:') safe.push('   Select login method:');
    else if (/^Browser didn't open\? Use the url below to sign in \(c to copy\)$/u.test(plain)) safe.push('   [OAuth display omitted]');
    else if (/^[❯›»](?:\s+(?:H8E_LOCAL_AUTHENTICATION_PROBE|\/login))?\s*$/u.test(plain)) safe.push(plain);
    else if (plain === '') safe.push('');
    else safe.push('[native content omitted]');
  }
  return safe.join('\n');
}

async function packageH8eSdk(directory: string) {
  const oldModule = (await browserExec('git', ['show', '4ab952cb6e3de7192e428d65831ca0873b25597c:packages/adapter-sdk/src/shared-session/provider-login.ts'])).stdout;
  const oldDigest = createHash('sha256').update(oldModule).digest('hex');
  if (oldDigest !== '6e58c7e09b2a08ba28f9aa2595e77213a6e1e57566acf33c1949e25abea5334e') throw new Error('the pinned old login module differs');
  const providerPath = join(process.cwd(), 'packages/adapter-sdk/src/shared-session/provider-login.ts');
  const cache = new Map<string, Promise<Buffer>>();
  const gatewaySource = await readFile('services/gateway/src/routes/core.ts');
  const snapshots: Record<string, Record<string, string>> = { before: {}, fixed: {} };
  const snapshot = join(directory, 'package-inputs');
  await cp('packages/adapter-sdk/descriptors', join(snapshot, 'descriptors'), { recursive: true });
  await cp(await realpath('node_modules/ws'), join(snapshot, 'vendor/ws'), { recursive: true });
  const fileHashes = async (root: string): Promise<Record<string, string>> => {
    const result: Record<string, string> = {};
    const visit = async (path: string): Promise<void> => {
      for (const row of await readdir(path, { withFileTypes: true })) {
        const child = join(path, row.name);
        if (row.isDirectory()) await visit(child);
        else if (row.isFile()) result[relative(root, child)] = createHash('sha256').update(await readFile(child)).digest('hex');
      }
    };
    await visit(root);
    return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
  };
  const observer = join(directory, 'observe.ts');
  const tlsReader = join(directory, 'tls-reader.ts');
  await writeFile(tlsReader, `import {readOwnerOnlyFile} from ${JSON.stringify(join(process.cwd(), 'packages/adapter-sdk/src/sdk/secure-files.ts'))};
import {createSecureContext} from 'node:tls';
const rows=[];const material=[];
for(const key of ['CAUCE_TLS_CERT_FILE','CAUCE_TLS_KEY_FILE','CAUCE_TLS_CA_FILE']){
try{material.push(await readOwnerOnlyFile(process.env[key],key));rows.push({kind:key,read:true});}
catch(error){rows.push({kind:key,read:false,error_name:error.name==='SecureFileError'?'SecureFileError':'unclassified',code:error.code==='SECURE_FILE_INVALID'?error.code:'unclassified',cause_code:['EBADF','EACCES','ENOENT','ELOOP'].includes(error.cause?.code)?error.cause.code:null,message_kind:error.message.includes('exactly 0600')?'permissions':error.message.includes('could not be loaded')?'load_failed':'unclassified'});}}
let context=false;if(material.length===3)try{createSecureContext({cert:material[0],key:material[1],ca:material[2]});context=true;}catch{}
console.log(JSON.stringify({reads:rows,secure_context_created:context}));\n`);
  await writeFile(observer, `import {CliTmux} from ${JSON.stringify(join(process.cwd(), 'packages/adapter-sdk/src/shared-session/tmux.ts'))};
import {ensureSharedSession} from ${JSON.stringify(join(process.cwd(), 'packages/adapter-sdk/src/shared-session/session.ts'))};
import {cliSharedSessionSpec} from ${JSON.stringify(join(process.cwd(), 'packages/adapter-sdk/src/shared-session/config.ts'))};
import {waitForTui} from ${JSON.stringify(join(process.cwd(), 'packages/adapter-sdk/src/shared-session/session/readiness.ts'))};
const tmux=new CliTmux(undefined,process.env,10000);
const spec=cliSharedSessionSpec('claude',process.env.CAUCE_ALIAS,'/home/node/projects','/home/node',process.env,'/home/node/.cauce');
const options={sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),readyTimeoutMs:5000};
const result=await ensureSharedSession(tmux,spec,options);
const readiness=await waitForTui(tmux,'cauce-'+spec.alias+':agente',options,undefined,'claude');
console.log(JSON.stringify({ready:result.ready,failure:result.failure??null,created:result.created,pid:result.pane?.panePid??null,readiness}));\n`);
  const digests: Record<string, string> = {};
  for (const mode of ['before', 'fixed'] as const) {
    const root = join(directory, 'sdk', mode);
    await cp(snapshot, root, { recursive: true });
    for (const [name, entry] of [['claude', 'packages/adapter-sdk/src/bin/claude.ts'], ['observe', observer], ['tls-reader', tlsReader]] as const) {
      const output = join(root, 'src/bin', `${name}.js`);
      await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', outfile: output,
        alias: { '@cauce/protocol': join(process.cwd(), 'packages/protocol/src/index.ts') },
        banner: { js: 'import{createRequire as __cauceRequire}from"node:module";const require=__cauceRequire(import.meta.url);' },
        plugins: [{ name: 'shared-immutable-inputs', setup(builder) {
          builder.onLoad({ filter: /\.(?:[cm]?[jt]sx?|json)$/ }, async args => {
            if (args.namespace !== 'file') return undefined;
            let pending = cache.get(args.path);
            if (!pending) { pending = readFile(args.path); cache.set(args.path, pending); }
            const contents = mode === 'before' && args.path === providerPath ? Buffer.from(oldModule) : await pending;
            const inputs = snapshots[mode];
            if (!inputs) throw new Error('missing H8e immutable input map');
            inputs[args.path] = createHash('sha256').update(contents).digest('hex');
            const extension = extname(args.path);
            const loader = extension === '.json' ? 'json' : extension === '.tsx' ? 'tsx' : extension === '.jsx' ? 'jsx'
              : ['.ts', '.mts', '.cts'].includes(extension) ? 'ts' : 'js';
            return { contents, loader, resolveDir: join(args.path, '..') };
          });
        } }],
      });
      digests[`${mode}/${name}`] = createHash('sha256').update(await readFile(output)).digest('hex');
    }
  }
  const shared = (mode: 'before' | 'fixed') => Object.fromEntries(Object.entries(snapshots[mode] ?? {})
    .filter(([path]) => path !== providerPath).sort(([left], [right]) => left.localeCompare(right)));
  if (JSON.stringify(shared('before')) !== JSON.stringify(shared('fixed'))) throw new Error('the H8e SDK comparison has unrelated input differences');
  const assetHashes = await fileHashes(snapshot);
  for (const mode of ['before', 'fixed']) {
    const root = join(directory, 'sdk', mode);
    const observed = { ...await fileHashes(join(root, 'descriptors')), ...Object.fromEntries(Object.entries(await fileHashes(join(root, 'vendor'))).map(([path, hash]) => [`vendor/${path}`, hash])) };
    const expected = Object.fromEntries(Object.entries(assetHashes).map(([path, hash]) => [path.replace(/^descriptors\//u, ''), hash]));
    if (JSON.stringify(Object.fromEntries(Object.entries(observed).sort())) !== JSON.stringify(Object.fromEntries(Object.entries(expected).sort()))) {
      throw new Error('the H8e copied descriptor or vendor assets differ');
    }
  }
  await h8eReceipt('sdk-snapshot.json', { old_provider_login_sha256: oldDigest,
    fixed_provider_login_sha256: snapshots.fixed?.[providerPath], compiled_sdk_sha256: digests, effective_inputs_sha256: snapshots,
    shared_inputs_equal: true, copied_assets_equal: true, copied_assets_sha256: assetHashes });
  const diagnosticCodes = new Set<string>();
  const staticSources = [gatewaySource.toString('utf8')];
  for (const [path, pending] of cache) if (path.startsWith(join(process.cwd(), 'packages/adapter-sdk/src/'))
    || path.startsWith(join(process.cwd(), 'packages/protocol/src/'))) staticSources.push((await pending).toString('utf8'));
  const errorNames = new Set(['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'AggregateError']);
  for (const text of staticSources) {
    for (const match of text.matchAll(/['"]([A-Z][A-Z0-9_]{1,127})['"]/gu)) if (match[1]) diagnosticCodes.add(match[1]);
    for (const match of text.matchAll(/class\s+([A-Z][A-Za-z0-9]+)\s+extends\s+(?:Error|AdapterError)\b/gu)) if (match[1]) errorNames.add(match[1]);
  }
  for (const name of errorNames) diagnosticCodes.add(`CONNECTION_${name.toUpperCase()}`);
  const diagnosticAllowlist = [...diagnosticCodes].sort();
  await h8eReceipt('diagnostic-code-allowlist.json', { codes: diagnosticAllowlist,
    gateway_source_sha256: createHash('sha256').update(gatewaySource).digest('hex'), source: 'static literals from frozen SDK/protocol inputs and observed gateway source' });
  return diagnosticAllowlist;
}

export async function startH8eClaudeRuntime(options: { tlsFiles?: string[]; packageSdk?: boolean } = {}) {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.DOCKER_HOST !== 'unix:///var/run/docker.sock') {
    throw new Error('H8e requires scripts/e2e-lab.sh');
  }
  console.info('H8E_RUN ' + JSON.stringify({ run: H8E_RUN, directory: H8E_EVIDENCE }));
  const directory = await mkdtemp(join(tmpdir(), `${H8E_PREFIX}-`));
  const name = `${H8E_PREFIX}-runtime`;
  const image = `${H8E_PREFIX}:local`;
  const requests: { path: string; status: number; at_ms: number }[] = [];
  const provider = createServer((incoming, outgoing) => {
    incoming.resume();
    requests.push({ path: new URL(incoming.url ?? '/', 'http://localhost').pathname, status: 401, at_ms: Date.now() });
    outgoing.writeHead(401, { 'content-type': 'application/json', 'request-id': `zz-canary-${H8E_RUN}` });
    outgoing.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error',
      message: 'OAuth token has expired. Please obtain a new token or refresh your existing token.' } }));
  });
  const close = async () => {
    const filters = ['--filter', `label=cauce.e2e.owner=${H8E_OWNER}`, '--filter', `label=cauce.e2e.run=${H8E_RUN}`];
    const resources = [
      { key: 'containers', list: ['container', 'ls', '-aq', '--no-trunc'], remove: ['rm', '-f'] },
      { key: 'volumes', list: ['volume', 'ls', '-q'], remove: ['volume', 'rm'] },
      { key: 'networks', list: ['network', 'ls', '-q', '--no-trunc'], remove: ['network', 'rm'] },
      { key: 'images', list: ['image', 'ls', '-q', '--no-trunc'], remove: ['image', 'rm', '-f'] },
    ];
    const failures: string[] = [];
    const remaining: Record<string, string[]> = {};
    try {
      for (const resource of resources) {
        try {
          const ids = [...new Set((await browserDocker([...resource.list, ...filters])).stdout.split(/\s+/u).filter(Boolean))];
          if (ids.length) await browserDocker([...resource.remove, ...ids]);
          remaining[resource.key] = (await browserDocker([...resource.list, ...filters])).stdout.split(/\s+/u).filter(Boolean);
        } catch { failures.push(resource.key); }
      }
    } finally {
      if (provider.listening) await new Promise<void>(resolve => { provider.close(() => { resolve(); }); provider.closeAllConnections(); });
      await rm(directory, { recursive: true, force: true });
      await h8eReceipt('cleanup.json', { run: H8E_RUN, remaining, failures, clean: !failures.length && Object.values(remaining).every(rows => !rows.length) });
    }
    if (failures.length || Object.values(remaining).some(rows => rows.length)) throw new Error('owned H8e cleanup failed');
  };
  try {
    await chmod(directory, 0o755);
    const diagnosticAllowlist = options.packageSdk ? await packageH8eSdk(directory) : [];
    await new Promise<void>(resolve => { provider.listen(0, '127.0.0.1', resolve); });
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('local H8e provider has no TCP address');
    const recipe = await readFile('tests/e2e/lab-runner/Dockerfile');
    const base = `cauce-e2e-lab-runner:${createHash('sha256').update(recipe).digest('hex').slice(0, 12)}`;
    await writeFile(join(directory, 'Dockerfile'), `FROM ${base}\nRUN npm install --global --no-audit --no-fund @anthropic-ai/claude-code@2.1.310 && install -m 0755 "$(readlink -f /usr/local/bin/claude)" /usr/local/bin/h8e-claude-native && npm cache clean --force\n`);
    await browserDocker(['build', '-q', ...labels, '-t', image, directory], { timeout: 300_000, maxBuffer: 1024 * 1024 });
    const imageId = (await browserDocker(['image', 'inspect', '--format', '{{.Id}}', image])).stdout.trim();
    await browserDocker(['run', '-d', '--init', '--name', name, ...labels, '--network', 'host', '--user', 'node', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256',
      '--tmpfs', '/tmp:rw,nosuid,size=128m,mode=1777', '--tmpfs', '/home/node:rw,exec,nosuid,size=256m,uid=1000,gid=1000,mode=0700',
      ...(options.packageSdk ? ['--mount', `type=bind,src=${join(directory, 'sdk')},dst=/cauce-sdk,readonly`] : []),
      ...(options.tlsFiles ?? []).flatMap(path => ['--mount', `type=bind,src=${path},dst=/fixture-tls/${basename(path)},readonly`]),
      '--workdir', '/home/node', '--env', 'HOME=/home/node', '--env', 'TERM=xterm-256color', '--entrypoint', '/bin/sleep', imageId, 'infinity']);
    const exec = async (args: string[], timeout = 30_000) => {
      try { return await browserDocker(['exec', '--user', 'node', name, ...args], { timeout, maxBuffer: 1024 * 1024 }); }
      catch (error) {
        const text = browserErrorStderr(error);
        await h8eReceipt(`exec-failure-${randomUUID()}.json`, { kind: ['ENOENT', 'EACCES', 'ELOOP', 'ENOTDIR', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND',
          'ERR_UNSUPPORTED_DIR_IMPORT', 'ReferenceError', 'SyntaxError', 'pinned harness file ownership or mode changed', 'Cannot find package', 'Cannot find module',
          'invalid model', 'unsupported model', 'invalid pinned command path', 'harness command differs from its pinned binding', 'no server running', 'no such session', 'permission denied']
          .find(code => text.includes(code)) ?? 'unclassified', private_output_omitted: true });
        throw new Error('owned H8e runtime command failed; private output omitted');
      }
    };
    const tmux = (args: string[]) => exec(['tmux', '-L', 'cauce', ...args]);
    await exec(['python3', '-I', '-B', '-c', `import json,pathlib
home=pathlib.Path('/home/node')
for suffix in ['.local/bin','.claude','projects','.cauce']: (home/suffix).mkdir(parents=True,exist_ok=True)
configuration={'hasCompletedOnboarding':True,'bypassPermissionsModeAccepted':True,'theme':'dark','projects':{'/home/node/projects':{'hasTrustDialogAccepted':True,'hasCompletedProjectOnboarding':True}}}
for suffix in ['.claude.json','.claude/.claude.json']:(home/suffix).write_text(json.dumps(configuration))
(home/'.claude/.credentials.json').write_text(json.dumps({'claudeAiOauth':{'accessToken':'','refreshToken':'','expiresAt':0,'scopes':['user:inference'],'subscriptionType':'pro','rateLimitTier':'default_claude_pro'}}));(home/'.claude/.credentials.json').chmod(0o600)
(home/'.local/bin/browser-disabled').write_text('#!/bin/sh\\nexit 0\\n');(home/'.local/bin/browser-disabled').chmod(0o700)
(home/'.local/bin/claude').write_text('#!/bin/sh\\nexport ANTHROPIC_BASE_URL=http://127.0.0.1:${String(address.port)}\\nexport DISABLE_AUTOUPDATER=1\\nexport CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\\nexport DISABLE_TELEMETRY=1\\nexport BROWSER=/home/node/.local/bin/browser-disabled\\nexec /usr/local/bin/h8e-claude-native "$@"\\n')
(home/'.local/bin/claude').chmod(0o700)
(home/'.bash_profile').write_text('export PATH="$HOME/.local/bin:$PATH"\\n')`]);
    const version = (await exec(['/usr/local/bin/h8e-claude-native', '--version'])).stdout.trim();
    const nativeBinary = JSON.parse((await exec(['python3', '-I', '-B', '-c', `import hashlib,json,pathlib
original=pathlib.Path('/usr/local/bin/claude').resolve();copied=pathlib.Path('/usr/local/bin/h8e-claude-native')
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
original_hash=digest(original);copied_hash=digest(copied)
with copied.open('rb') as stream:elf=stream.read(4)==bytes([127,69,76,70])
if original_hash!=copied_hash or copied.stat().st_nlink!=1 or not elf:raise SystemExit('the owned native CLI copy differs')
print(json.dumps({'npm_original_sha256':original_hash,'copied_sha256':copied_hash,'npm_original_nlink':original.stat().st_nlink,'copied_nlink':copied.stat().st_nlink,'copied_elf':elf}))`])).stdout) as unknown;
    const sourceHead = (await browserExec('git', ['rev-parse', 'HEAD'])).stdout.trim();
    await h8eReceipt('runtime.json', { run: H8E_RUN, name, image: imageId, version, native_binary: nativeBinary, repository_claude_pin: '2.1.296', source_head_observed: sourceHead,
      provider: 'local HTTP 401', authentication_fixture: 'fresh synthetic expired OAuth store in owned tmpfs', real_claude_cli: true, real_credentials: false });
    return { directory, name, imageId, exec, tmux, requests, version, diagnosticAllowlist, close };
  } catch (error) { await close(); throw error; }
}
