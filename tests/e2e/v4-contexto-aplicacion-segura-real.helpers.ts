import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { browserDocker } from './browser-owned-lifecycle.js';
import { isaTenant, type startContextFixture } from './context-multiuser-continuity.fixtures.js';

type Fixture = Awaited<ReturnType<typeof startContextFixture>>;
export interface ModelWitness { version: number; model: string; memory_sha256: string; native_memory_in_prompt: boolean }
export const memoryDigest = (content: string) => createHash('sha256').update(content).digest('hex');

export async function startLocalContextModel(space: string) {
  const witnesses: ModelWitness[] = [];
  const errors: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end(); return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; messages: unknown[]; stream?: boolean };
      const prompt = JSON.stringify(body.messages.filter(message => message !== null && typeof message === 'object'
        && 'role' in message && message.role === 'system'));
      const state = JSON.parse(await readFile(join(space, 'config/context-state.json'), 'utf8')) as { version: number };
      const memory = await readFile(join(space, 'workspace/MEMORY.md'), 'utf8');
      const witness = { version: state.version, model: body.model, memory_sha256: memoryDigest(memory),
        native_memory_in_prompt: prompt.includes(JSON.stringify(memory.trim()).slice(1, -1)) };
      witnesses.push(witness);
      if (!witness.native_memory_in_prompt) throw new Error('OpenClaw did not read current native MEMORY.md');
      const text = JSON.stringify({ reply: `OPENCLAW ${String(witness.version)} ${witness.memory_sha256}`,
        messages: [], notify: [], status: 'done', retryable: false, artifacts: [] });
      const id = `chatcmpl-${randomUUID()}`;
      const common = { id, created: Math.floor(Date.now() / 1000), model: body.model };
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`);
        response.end(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } })}\n\ndata: [DONE]\n\n`);
      } else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...common,
        object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } }));
    })().catch((error: unknown) => {
      errors.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: errors.at(-1) } }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local context model did not listen');
  return { endpoint: `http://127.0.0.1:${String(address.port)}/v1`, witnesses, errors,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections(); server.close(error => { if (error) reject(error); else resolve(); });
    }) };
}

export async function startRealOpenClaw(fixture: Fixture, space: string, endpoint: string, run: string) {
  const image = process.env.CAUCE_C7_OPENCLAW_IMAGE ?? 'cauce-c7-openclaw-real:2026.7.1-2';
  const imageId = (await browserDocker(['image', 'inspect', '--format', '{{.Id}}', image])).stdout.trim();
  const name = `zz-canary-c7-openclaw-${run}`;
  const home = join(fixture.directory, 'oc-home');
  const state = join(fixture.directory, 'oc');
  const tls = fixture.pki.adapterCerts[0];
  if (!tls) throw new Error('owned adapter TLS missing');
  await Promise.all([join(home, '.openclaw'), state].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  await writeFile(join(home, '.openclaw/openclaw.json'), JSON.stringify({
    agents: { defaults: { workspace: join(space, 'workspace'), skipBootstrap: true,
      model: { primary: 'c7-local/c7-model' }, thinkingDefault: 'off' } },
    models: { mode: 'replace', providers: { 'c7-local': { baseUrl: endpoint, api: 'openai-completions', apiKey: 'fixture-local-only',
      models: [{ id: 'c7-model', name: 'Owned deterministic context fixture', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 1024 }] } } },
    tools: { deny: ['*'] },
  }), { mode: 0o600 });
  const environment: Record<string, string> = {
    NODE_ENV: 'test', HOME: home, OPENCLAW_STATE_DIR: join(home, '.openclaw'),
    CAUCE_OPENCLAW_WORKSPACE: join(space, 'workspace'), CAUCE_OPENCLAW_LOCAL: '1',
    CAUCE_OPENCLAW_DIST_DIR: '/usr/local/lib/node_modules/openclaw/dist',
    CAUCE_TENANT: isaTenant.tenant, CAUCE_ROOM: isaTenant.room, CAUCE_ALIAS: isaTenant.target,
    CAUCE_INSTANCE_ID: `c7-${run}`, CAUCE_STATE_DIR: state, CAUCE_SPACE_ROOT: space,
    CAUCE_RELAY_URL: `${fixture.gatewayUrl.replace('https:', 'wss:')}/v3/ws`, CAUCE_ENVIRONMENT: 'test',
    CAUCE_HEARTBEAT_MS: '250', CAUCE_NO_PROGRESS_TIMEOUT_MS: '120000', CAUCE_OPENCLAW_RUN_DEADLINE_MS: '90000',
    CAUCE_TLS_CERT_FILE: tls.cert, CAUCE_TLS_KEY_FILE: tls.key, CAUCE_TLS_CA_FILE: fixture.pki.ca.cert,
  };
  const child: ChildProcess = spawn('docker', ['run', '--pull=never', '--rm', '--init', '--name', name, '--label', `cauce.e2e.owner=${run}`,
    '--network', 'host', '--read-only', '--tmpfs', '/tmp', '--user', `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`,
    '--mount', `type=bind,src=${process.cwd()},dst=${process.cwd()},readonly`,
    '--mount', `type=bind,src=${fixture.directory},dst=${fixture.directory}`,
    ...Object.entries(environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    '--workdir', process.cwd(), '--entrypoint', 'node', image, 'packages/adapter-sdk/dist/src/bin/openclaw.js'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  fixture.adapters.push(child);
  let diagnostics = '';
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-64 * 1024); });
  return { name, image, imageId, home, diagnostics: () => diagnostics, close: async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ownership = (await browserDocker(['inspect', '--format', '{{index .Config.Labels "cauce.e2e.owner"}}', name])).stdout.trim();
    if (ownership !== run) throw new Error('OpenClaw canary ownership changed');
    await browserDocker(['rm', '-f', name]);
  } };
}
