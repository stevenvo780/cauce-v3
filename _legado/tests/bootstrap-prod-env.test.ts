import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bootstrap = join(repository, 'ops/scripts/bootstrap-prod-env.py');
const scratch: string[] = [];
const image = `registry.invalid/cauce@sha256:${'a'.repeat(64)}`;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-prod-env-'));
  scratch.push(directory);
  const manifest = join(directory, 'active.manifest');
  await writeFile(manifest, '# authenticated fixture\n', { mode: 0o600 });
  const manifestSha = `sha256:${createHash('sha256').update('# authenticated fixture\n').digest('hex')}`;
  const baseline = join(directory, 'rollback-baseline.json');
  const baselineContent = '{}\n';
  const baselineSha = `sha256:${createHash('sha256').update(baselineContent).digest('hex')}`;
  await writeFile(baseline, baselineContent, { mode: 0o600 });
  const writerSnapshot = join(directory, 'writer-snapshot.json');
  const writerSnapshotContent = '{"kind":"writer-snapshot","schemaVersion":1}\n';
  const writerSnapshotSha = `sha256:${createHash('sha256').update(writerSnapshotContent).digest('hex')}`;
  await writeFile(writerSnapshot, writerSnapshotContent, { mode: 0o600 });
  await writeFile(`${writerSnapshot}.state.json`, '{}\n', { mode: 0o444 });
  const references = join(directory, 'references.env');
  await writeFile(references, [
    `CAUCE_COMPOSE_OVERRIDE_MANIFEST=${manifest}`,
    `CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=${manifestSha}`,
    `CAUCE_ROLLBACK_BASELINE_FILE=${baseline}`,
    `CAUCE_ROLLBACK_BASELINE_SHA256=${baselineSha}`,
    `CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${writerSnapshot}`,
    `CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=${writerSnapshotSha}`,
    'CAUCE_LOCAL_POSTGRES=0',
    'COMPOSE_PROFILES=terminal',
    `CAUCE_RUNTIME_IMAGE=${image}`,
    `CAUCE_CONSOLE_IMAGE=${image}`,
    'CAUCE_TERMINAL_ENABLED=1',
    'CAUCE_TERMINAL_CONFIG_DIR=/private/terminal',
    'CAUCE_TERMINAL_TICKET_KEY_PATH=/private/ticket.key',
    'CAUCE_TERMINAL_RELAY_TOKEN_PATH=/private/relay.token',
    'CAUCE_TERMINAL_RELAY_URL=https://terminal-relay:8446',
    'CAUCE_GATEWAY_RELAY_CLIENT_CERT_PATH=/private/gateway-relay-client.crt',
    'CAUCE_GATEWAY_RELAY_CLIENT_KEY_PATH=/private/gateway-relay-client.key',
    'CAUCE_TERMINAL_GATEWAY_CLIENT_CERT_PATH=/private/terminal-relay-client.crt',
    'CAUCE_TERMINAL_GATEWAY_CLIENT_KEY_PATH=/private/terminal-relay-client.key',
    'CAUCE_TERMINAL_RELAY_TLS_CERT_PATH=/private/relay-server.crt',
    'CAUCE_TERMINAL_RELAY_TLS_KEY_PATH=/private/relay-server.key',
  ].join('\n') + '\n');
  await chmod(references, 0o600);
  return { directory, references, output: join(directory, 'prod.env'), manifest };
}

function run(references: string, output: string) {
  return spawnSync('python3', [bootstrap, '--authorized-references', references, '--output', output], {
    encoding: 'utf8',
  });
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('private production env bootstrap', () => {
  test('publishes only the template key set with mode 0600 and no values in output', async () => {
    const { references, output } = await fixture();
    const result = run(references, output);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('/private/');
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    const content = await readFile(output, 'utf8');
    expect(content).toContain(`CAUCE_RUNTIME_IMAGE=${image}`);
    expect(content).toMatch(/CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=sha256:[a-f0-9]{64}/u);
    expect(content).toContain('CAUCE_TERMINAL_ENABLED=1');
  });

  test('rejects manifest bytes that differ from the authorized durable selector', async () => {
    const { references, output, manifest } = await fixture();
    await writeFile(manifest, '# changed after authorization\n');
    const result = run(references, output);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match the manifest');
    await expect(stat(output)).rejects.toThrow();
  });

  test('rejects a mutable image and never publishes the output', async () => {
    const { references, output } = await fixture();
    const content = (await readFile(references, 'utf8')).replace(image, 'registry.invalid/cauce:latest');
    await writeFile(references, content, { mode: 0o600 });
    const result = run(references, output);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CAUCE_RUNTIME_IMAGE');
    await expect(stat(output)).rejects.toThrow();
  });

  test('rejects loose input permissions and refuses to overwrite an existing output', async () => {
    const { references, output } = await fixture();
    await chmod(references, 0o644);
    expect(run(references, output).stderr).toContain('group or other users');
    await chmod(references, 0o600);
    await writeFile(output, 'sentinel\n', { mode: 0o600 });
    const result = run(references, output);
    expect(result.status).toBe(1);
    expect(await readFile(output, 'utf8')).toBe('sentinel\n');
  });
});
