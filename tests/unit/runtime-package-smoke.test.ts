import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface RuntimePackageSmokeModule {
  validateRuntimeBridges: (options: { hermesBridge: string; openClawBridge: string }) => Promise<void>;
}

const smokeModuleUrl = new URL('../../deploy/runtime-package-smoke.mjs', import.meta.url).href;
const { validateRuntimeBridges } = await import(/* @vite-ignore */ smokeModuleUrl) as unknown as RuntimePackageSmokeModule;

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const dockerfilePath = join(repositoryRoot, 'deploy', 'Dockerfile');
const composePath = join(repositoryRoot, 'deploy', 'compose.yaml');
const sourceBridgeDirectory = join(repositoryRoot, 'packages', 'adapter-sdk', 'bridge');

describe('runtime bridge packaging smoke', () => {
  let directory: string;
  let hermesBridge: string;
  let openClawBridge: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cauce-runtime-bridge-test-'));
    const bridgeDirectory = join(directory, 'dist', 'bridge');
    await mkdir(bridgeDirectory, { recursive: true });
    hermesBridge = join(bridgeDirectory, 'hermes-stdin-bridge.py');
    openClawBridge = join(bridgeDirectory, 'openclaw-stdin-bridge.mjs');
    const [hermesSource, openClawSource] = await Promise.all([
      readFile(join(sourceBridgeDirectory, 'hermes-stdin-bridge.py')),
      readFile(join(sourceBridgeDirectory, 'openclaw-stdin-bridge.mjs')),
    ]);
    await Promise.all([
      writeFile(hermesBridge, hermesSource),
      writeFile(openClawBridge, openClawSource),
    ]);
    await Promise.all([chmod(hermesBridge, 0o555), chmod(openClawBridge, 0o555)]);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('launches both executable bridges against isolated fixtures', async () => {
    await expect(validateRuntimeBridges({ hermesBridge, openClawBridge })).resolves.toBeUndefined();
  });

  it('rejects bridge stderr beyond the single effect-boundary marker', async () => {
    await chmod(hermesBridge, 0o755);
    const source = await readFile(hermesBridge, 'utf8');
    await writeFile(
      hermesBridge,
      source.replace(
        '    sys.stderr.write("<<cauce:harness-started>>\\n")\n',
        '    sys.stderr.write("<<cauce:harness-started>>\\n")\n    sys.stderr.write("unexpected diagnostic\\n")\n',
      ),
    );
    await chmod(hermesBridge, 0o555);

    await expect(validateRuntimeBridges({ hermesBridge, openClawBridge }))
      .rejects.toThrow(/did not emit exactly one harness-start marker/u);
  });

  it('fails when either packaged bridge is missing', async () => {
    await rm(openClawBridge);
    await expect(validateRuntimeBridges({ hermesBridge, openClawBridge }))
      .rejects.toThrow(/OpenClaw runtime bridge is missing or not executable/u);
  });

  it('fails when a packaged bridge does not have runtime mode 0555', async () => {
    await chmod(hermesBridge, 0o755);
    await expect(validateRuntimeBridges({ hermesBridge, openClawBridge }))
      .rejects.toThrow(/Hermes runtime bridge must have mode 0555/u);
  });

  it('copies and locks down the built bridge directory before the build-time smoke', async () => {
    const dockerfile = await readFile(dockerfilePath, 'utf8');
    const bridgeCopy = 'COPY --from=build --chown=node:node /app/packages/adapter-sdk/dist/bridge ./packages/adapter-sdk/dist/bridge';
    const bridgeMode = 'RUN chmod -R 0555 ./packages/adapter-sdk/dist/bridge';
    const pythonCopy = 'COPY --from=python-runtime /usr/local /usr/local';
    const pythonSmoke = "RUN python3 -c 'import asyncio, json; assert asyncio and json'";
    const copyIndex = dockerfile.indexOf(bridgeCopy);
    const modeIndex = dockerfile.indexOf(bridgeMode);
    const pythonCopyIndex = dockerfile.indexOf(pythonCopy);
    const pythonSmokeIndex = dockerfile.indexOf(pythonSmoke);
    const userIndex = dockerfile.indexOf('USER node');
    const smokeIndex = dockerfile.indexOf('RUN node deploy/runtime-package-smoke.mjs');

    expect(dockerfile).toMatch(/^ARG CAUCE_PYTHON_BASE=docker\.io\/library\/python@sha256:[a-f0-9]{64}$/mu);
    expect(dockerfile).not.toContain('apk add --no-cache python3');
    expect(pythonCopyIndex).toBeGreaterThan(-1);
    expect(pythonSmokeIndex).toBeGreaterThan(pythonCopyIndex);
    expect(dockerfile).toContain('mkdir -p /var/lib/cauce-adapter /var/lib/cauce-terminal');
    expect(copyIndex).toBeGreaterThan(-1);
    expect(modeIndex).toBeGreaterThan(copyIndex);
    expect(userIndex).toBeGreaterThan(modeIndex);
    expect(smokeIndex).toBeGreaterThan(userIndex);
  });

  it('persists terminal close reports across container replacement', async () => {
    const compose = await readFile(composePath, 'utf8');
    expect(compose).toContain(
      'CAUCE_TERMINAL_CLOSE_SPOOL_FILE: /var/lib/cauce-terminal/close-reports.json',
    );
    expect(compose).toContain('- terminal_close_spool:/var/lib/cauce-terminal');
    expect(compose.match(/terminal_close_spool/gu)).toHaveLength(2);
  });
});
