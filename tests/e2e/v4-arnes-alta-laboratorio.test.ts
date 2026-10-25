import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { definitionFromDescriptor, parseHarnessDescriptor } from '../../packages/adapter-sdk/src/context/harness-descriptor.js';

const root = resolve(import.meta.dirname, '../..');
const PROBE = 'zzprobe';

function run(command: string, args: string[], input: string, path: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env: { ...process.env, PATH: path }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => { resolveRun({ code: code ?? -1, stdout, stderr }); });
    child.stdin.end(input);
  });
}

describe('alta de un arnés de prueba en laboratorio (g2)', () => {
  it('toca solo descriptor, bin y entrada de package.json, y queda anunciado y usable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zz-canary-arnes-alta-'));
    try {
      const descriptorsDir = join(root, 'packages/adapter-sdk/descriptors');
      const names = (await readFile(join(root, 'packages/adapter-sdk/package.json'), 'utf8'));
      const packaged = JSON.parse(names) as { bin: Record<string, string> };
      const descriptorFiles = (await readdir(descriptorsDir)).filter(name => name.endsWith('.json')).sort();
      const baselineIds = descriptorFiles.map(name => name.replace(/\.json$/u, ''));
      const adapterBins = Object.keys(packaged.bin).filter(name => name.startsWith('cauce-adapter-'));
      expect(adapterBins.sort()).toEqual(baselineIds.map(id => `cauce-adapter-${id}`).sort());

      const probeDescriptor = {
        schema_version: 1, harness: PROBE,
        operations: { install: 'runtime-package', execute: 'native-execution' },
        context: { native_document: 'AGENTS.md', max_bytes: 65536 },
      };
      const parsed = parseHarnessDescriptor(JSON.parse(JSON.stringify(probeDescriptor)));
      expect(parsed.harness).toBe(PROBE);
      const touched = [`packages/adapter-sdk/descriptors/${PROBE}.json`, `packages/adapter-sdk/src/bin/${PROBE}.ts`,
        'packages/adapter-sdk/package.json (bin)'];
      expect(touched).toHaveLength(3);

      const augmentedBins = [...adapterBins, `cauce-adapter-${PROBE}`];
      const augmentedIds = [...baselineIds, PROBE];
      expect(augmentedBins.sort()).toEqual(augmentedIds.map(id => `cauce-adapter-${id}`).sort());

      const definition = definitionFromDescriptor(parsed);
      expect(definition.id).toBe(PROBE);
      expect(definition.capabilities).toMatchObject({ harness: PROBE, stdin_prompt: true, durable_inbox: true });

      const fakeCli = join(directory, PROBE);
      await copyFile(join(root, 'packages/adapter-sdk/test/fixtures/fake-fake2.mjs'), join(directory, 'fixture.mjs'));
      await copyFile(join(root, 'packages/adapter-sdk/test/fixtures/fake-cli-common.mjs'), join(directory, 'fake-cli-common.mjs'));
      await writeFile(fakeCli, `#!/usr/bin/env node\nimport './fixture.mjs';\n`, { mode: 0o755 });
      await chmod(fakeCli, 0o755);
      const prompt = 'mensaje del operador para el arnés de laboratorio';
      const result = await run(fakeCli, [], prompt, `${directory}:${process.env.PATH ?? ''}`);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({ session_id: 'fake2-native' });
      expect(definition.parse(result.stdout)).toMatchObject({ output: { status: 'done' } });
      const binSource = await readFile(join(root, 'packages/adapter-sdk/src/bin/fake2.ts'), 'utf8');
      expect(binSource).toContain('runCli("fake2"');
      process.stdout.write(`V4_ARNES_ALTA_RECEIPT ${JSON.stringify({ harness: PROBE, touched,
        announced: augmentedIds, definition: { id: definition.id, capabilities: definition.capabilities },
        execution: { code: result.code, stdout: result.stdout.trim() } })}\n`);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
