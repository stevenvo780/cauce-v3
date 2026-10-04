interface BootstrapRequest {
  url(): string;
  failure(): { errorText: string } | null;
}

interface BootstrapResponse {
  url(): string;
  status(): number;
}

interface BootstrapConsole {
  type(): string;
  text(): string;
}

interface BootstrapPage {
  on(event: string, handler: (value: unknown) => void): void;
}

function bootstrapPath(value: string): string | undefined {
  const pathname = new URL(value).pathname;
  return pathname === '/' || pathname === '/tema.js' || pathname === '/v3/auth/session'
    || pathname.startsWith('/src/') || pathname.startsWith('/node_modules/')
    || pathname.startsWith('/@vite/') || pathname.startsWith('/@react-refresh')
    ? pathname : undefined;
}

export function observeUiBootstrap(page: BootstrapPage): void {
  const started = performance.now();
  const record = (event: string, evidence: Record<string, string | number>) => {
    process.stdout.write(`UI bootstrap ${JSON.stringify({ event, elapsedMs: Math.round(performance.now() - started), ...evidence })}\n`);
  };
  page.on('response', (value) => {
    const response = value as BootstrapResponse;
    const path = bootstrapPath(response.url());
    if (path !== undefined) record('response', { path, status: response.status() });
  });
  page.on('requestfailed', (value) => {
    const request = value as BootstrapRequest;
    const path = bootstrapPath(request.url());
    if (path !== undefined) record('requestfailed', {
      path, code: request.failure()?.errorText.match(/net::ERR_[A-Z_]+/u)?.[0] ?? 'other',
    });
  });
  page.on('console', (value) => {
    const message = value as BootstrapConsole;
    if (message.type() === 'error') record('console', {
      type: 'error',
      keywords: ['WebSocket', 'MIME', 'module', 'SyntaxError', 'CSP', 'Content Security Policy',
        'Outdated Optimize Dep', '504', '403', 'Failed to fetch', 'vite', 'preamble', 'refresh']
        .filter((keyword) => message.text().includes(keyword)).join(','),
      code: /(?:net::ERR_|ERR_)[A-Z_]+/u.exec(message.text())?.[0] ?? 'other',
    });
  });
  page.on('pageerror', (value) => {
    record('pageerror', { name: value instanceof Error ? value.name : 'Error' });
  });
}
