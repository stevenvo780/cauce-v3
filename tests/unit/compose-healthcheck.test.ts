import { readFile } from 'node:fs/promises';

const composeUrl = new URL('../../deploy/compose.yaml', import.meta.url);
const dockerfileUrl = new URL('../../deploy/Dockerfile', import.meta.url);
const stackHealthUrl = new URL('../../ops/scripts/stack-health.sh', import.meta.url);
const caPath = '/run/secrets/console_tls_ca';
const wgetCommand = `SSL_CERT_FILE=${caPath} wget -q -O /dev/null https://console:8444/`;

describe('production console TLS healthchecks', () => {
  it('uses the mounted CA with BusyBox wget and keeps certificate verification enabled', async () => {
    const [compose, dockerfile, stackHealth] = await Promise.all([
      readFile(composeUrl, 'utf8'),
      readFile(dockerfileUrl, 'utf8'),
      readFile(stackHealthUrl, 'utf8'),
    ]);

    expect(compose).toContain(`test: ["CMD-SHELL", "${wgetCommand} || exit 1"]`);
    expect(dockerfile).toContain(`CMD test -r ${caPath} && ${wgetCommand} || exit 1`);
    expect(stackHealth).toContain(`sh -c 'test -r ${caPath} && ${wgetCommand}'`);

    for (const source of [compose, dockerfile, stackHealth]) {
      expect(source).not.toContain('--ca-certificate');
      expect(source).not.toContain('--no-check-certificate');
    }
  });
});
