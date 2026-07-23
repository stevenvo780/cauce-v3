import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const collectorImage = 'otel/opentelemetry-collector-contrib:0.130.1';
const collectorDigest = 'sha256:9c247564e65ca19f97d891cca19a1a8d291ce631b890885b44e3503c5fdb3895';
const probeImage = 'curlimages/curl:8.14.1';
const collectorConfigPath = fileURLToPath(new URL('../../ops/observability/otel-collector.yaml', import.meta.url));
const prometheusConfigPath = fileURLToPath(new URL('../../ops/observability/prometheus.yaml', import.meta.url));

async function docker(arguments_: string[], timeout = 60_000) {
  return execFileAsync('docker', arguments_, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout,
  });
}

async function removeContainer(name: string): Promise<void> {
  await docker(['rm', '--force', name]).catch(() => undefined);
}

async function copyConfig(name: string): Promise<void> {
  await docker(['cp', collectorConfigPath, `${name}:/config.yaml`]);
}

async function probe(name: string, url: string): Promise<string> {
  const { stdout } = await docker([
    'run', '--rm', '--network', `container:${name}`,
    probeImage,
    '--fail', '--silent', '--show-error',
    '--retry', '20', '--retry-all-errors', '--retry-delay', '1',
    '--max-time', '30', url,
  ], 45_000);
  return stdout;
}

describe('OpenTelemetry Collector 0.130.1 compatibility', () => {
  beforeAll(async () => {
    await docker(['pull', collectorImage], 120_000);
    await docker(['pull', probeImage], 120_000);
  }, 250_000);

  it('pins the tested release and validates its supported internal metrics schema', async () => {
    const { stdout: imageMetadata } = await docker([
      'image', 'inspect', collectorImage,
      '--format', '{{index .Config.Labels "org.opencontainers.image.version"}} {{json .RepoDigests}}',
    ]);
    expect(imageMetadata).toContain('0.130.1');
    expect(imageMetadata).toContain(`opentelemetry-collector-contrib@${collectorDigest}`);

    const name = `cauce-otel-validate-${randomUUID()}`;
    try {
      await docker(['create', '--name', name, collectorImage, 'validate', '--config=/config.yaml']);
      await copyConfig(name);
      await expect(docker(['start', '--attach', name])).resolves.toBeDefined();
    } finally {
      await removeContainer(name);
    }
  }, 90_000);

  it('serves health, internal metrics, and pipeline metrics without dead Prometheus targets', async () => {
    const prometheusConfig = await readFile(prometheusConfigPath, 'utf8');
    expect(prometheusConfig).toContain('otel-collector:8888');
    expect(prometheusConfig).toContain('otel-collector:9464');

    const name = `cauce-otel-runtime-${randomUUID()}`;
    try {
      await docker(['create', '--name', name, collectorImage, '--config=/config.yaml']);
      await copyConfig(name);
      await docker(['start', name]);

      await expect(probe(name, 'http://127.0.0.1:13133/')).resolves.toBeDefined();
      const internalMetrics = await probe(name, 'http://127.0.0.1:8888/metrics');
      expect(internalMetrics).toContain('otelcol_');
      await expect(probe(name, 'http://127.0.0.1:9464/metrics')).resolves.toBeDefined();
    } catch (error) {
      const logs = await docker(['logs', name]).then(({ stdout, stderr }) => `${stdout}${stderr}`).catch(() => '');
      throw new Error(`collector compatibility check failed: ${String(error)}\n${logs}`);
    } finally {
      await removeContainer(name);
    }
  }, 120_000);
});
