import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('Dockerfile runtime policy', () => {
  test('keeps the release Dockerfile portable when buildx is unavailable', async () => {
    const dockerfile = await readFile(join(repository, 'deploy/Dockerfile'), 'utf8');
    expect(dockerfile).not.toMatch(/^\s*COPY\b.*--chmod=/mu);
    expect(dockerfile).not.toContain('apk add');
    expect(dockerfile).toContain(
      'ARG CAUCE_NODE_BASE=docker.io/library/node@sha256:56a687b4d23e7a6cb49114924f5e257fcfbd33ad1f28f5c67aea9365996f2819',
    );
    expect(dockerfile).toContain(
      'ARG CAUCE_PYTHON_BASE=docker.io/library/python@sha256:53739acebd52a300f19f52d93f2a6165f63300689bdf6f8af2bff0d63780e5e6',
    );
    expect(dockerfile).toContain(
      'ARG CAUCE_NGINX_BASE=docker.io/nginxinc/nginx-unprivileged@sha256:28d91bdce70ad09025ea901458fdd149259d8e05982ade79d4ef2c0d9470eb48',
    );
    expect(dockerfile).toContain('COPY --from=python-runtime /usr/local /usr/local');
    expect(dockerfile).toContain('RUN chmod -R 0555 ./packages/adapter-sdk/dist/bridge');
    expect(dockerfile).toContain(
      'FROM console-base AS console\nUSER root\n'
      + 'COPY deploy/console/nginx-console-tls.conf /etc/nginx/conf.d/default.conf\n'
      + 'RUN chmod 0644 /etc/nginx/conf.d/default.conf\nUSER 101\n',
    );
  });
});
