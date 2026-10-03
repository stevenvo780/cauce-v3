import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { NativeContextHarness } from './native-model.js';

export const NATIVE_SCOPE = { instance_id: 'fixture', tenant_id: 'Steven', alias: 'helper' };
export const NATIVE_ROOT = 'tenants/Steven/agents/helper';
export const NATIVE_PROFILE = { purpose: 'Synthetic manual review', role_summary: null, human_brief: null,
  responsibilities: [], restrictions: [], tools: [], operating_rules: [] };
export const nativeManifest = (harness: NativeContextHarness = 'claude') => ({ schema_version: 3,
  instance_id: 'fixture', agents: [{ tenant_id: 'Steven', alias: 'helper', source_journal: null, native_manual: { harness } }] });
export const nativeFiles = (harness: NativeContextHarness = 'claude', content = '# Synthetic manual\n') => ({
  'context.json': JSON.stringify(nativeManifest(harness)),
  [`${NATIVE_ROOT}/profile.json`]: JSON.stringify(NATIVE_PROFILE),
  [`${NATIVE_ROOT}/native/${harness}/${harness === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'}`]: content,
});

export async function writeLooseObject(root: string, type: string, body: Buffer): Promise<string> {
  const raw = Buffer.concat([Buffer.from(`${type} ${String(body.length)}\0`), body]);
  const oid = createHash('sha1').update(raw).digest('hex');
  const directory = join(root, '.git', 'objects', oid.slice(0, 2));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, oid.slice(2)), deflateSync(raw));
  return oid;
}

interface Tree { [name: string]: Tree | { body: string | Buffer; mode: string } }
export async function writeNativeFixture(
  root: string, files: Record<string, string | Buffer> = nativeFiles(), modes: Record<string, string> = {},
): Promise<string> {
  await mkdir(join(root, '.git/objects/info'), { recursive: true });
  await mkdir(join(root, '.git/objects/pack'), { recursive: true });
  const nodes: Tree = {};
  for (const [path, body] of Object.entries(files)) {
    const parts = path.split('/');
    const name = parts.pop();
    if (name === undefined) throw new Error('Missing fixture name');
    let node = nodes;
    for (const part of parts) node = (node[part] ??= {}) as Tree;
    node[name] = { body, mode: modes[path] ?? '100644' };
  }
  async function tree(node: Tree): Promise<string> {
    const chunks: Buffer[] = [];
    for (const [name, value] of Object.entries(node).sort(([a], [b]) => a.localeCompare(b))) {
      const leaf = typeof value.mode === 'string' && (typeof value.body === 'string' || Buffer.isBuffer(value.body));
      const mode = leaf ? value.mode as string : '40000';
      const oid = leaf ? await writeLooseObject(root, 'blob', Buffer.from(value.body as string | Buffer)) : await tree(value as Tree);
      chunks.push(Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex'));
    }
    return writeLooseObject(root, 'tree', Buffer.concat(chunks));
  }
  return writeLooseObject(root, 'commit', Buffer.from(`tree ${await tree(nodes)}\n\nSynthetic fixture\n`));
}

export async function fixtureDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(path: string): Promise<void> {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name);
      hash.update(full.slice(root.length));
      if (entry.isDirectory()) await visit(full);
      else hash.update(await readFile(full));
    }
  }
  await visit(root);
  return hash.digest('hex');
}
