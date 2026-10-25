import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { join } from 'node:path';
import type { startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';

export type DeviceFixture = Awaited<ReturnType<typeof startConsoleFunctionalFixture>>;
export interface CliResult { code: number | null; stdout: string; stderr: string }
export interface DeviceGrant {
  device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string;
  expires_in: number; interval: number;
}
export interface DeviceResponse { status: number; body: Record<string, unknown>; cookies: string[] }

export function startDeviceCli(fixture: DeviceFixture, sessionFile: string, flag = '--dispositivo') {
  const running = startCli(fixture, ['login', flag], sessionFile);
  return {
    ...running,
    prompt: async (): Promise<{ code: string; url: string }> => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const output = running.output();
        const code = /\b[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}\b/u.exec(output)?.[0];
        const url = /https:\/\/localhost:\d+\/dispositivo(?:\?code=[A-Z2-9-]+)?/u.exec(output)?.[0];
        if (code && url) return { code, url };
        if (running.child.exitCode !== null || running.child.signalCode !== null) {
          throw new Error('Device CLI exited before printing its verification URL and code');
        }
        await new Promise<void>(resolve => { setTimeout(resolve, 50); });
      }
      throw new Error('Device CLI did not print its verification URL and code before its deadline');
    },
  };
}

export function startCli(fixture: DeviceFixture, args: string[], sessionFile: string) {
  const child = spawn('bash', [join(process.cwd(), 'ops/cli/cauce'), ...args,
    '--gateway', fixture.baseUrl, '--origin', fixture.baseUrl, '--ca-file', fixture.pki.ca.cert,
    '--session-file', sessionFile], {
    cwd: process.cwd(), env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  fixture.adapters.push(child);
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-64 * 1024); });
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-64 * 1024); });
  const result = new Promise<CliResult>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Device login CLI exceeded its deadline')); }, 45_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  void result.catch(() => undefined);
  return { child, result, output: () => stdout + stderr };
}

export async function deviceRequest(fixture: DeviceFixture, path: string, body?: unknown,
  headers: Record<string, string> = {}): Promise<DeviceResponse> {
  const ca = await readFile(fixture.pki.ca.cert);
  return new Promise((resolve, reject) => {
    const req = request(fixture.baseUrl + path, {
      method: body === undefined ? 'GET' : 'POST', ca,
      headers: { Origin: fixture.baseUrl, 'Content-Type': 'application/json', ...headers },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      response.once('error', reject);
      response.once('end', () => {
        try {
          resolve({ status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
            cookies: response.headers['set-cookie'] ?? [] });
        } catch { reject(new Error('Device endpoint returned a non-JSON response')); }
      });
    });
    req.setTimeout(15_000, () => { req.destroy(new Error('Device endpoint timed out')); });
    req.once('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export function sessionCookie(cookies: string[]): string {
  return cookies.map(cookie => cookie.split(';')[0] ?? '').join('; ');
}

export async function stopDeviceCli(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 2_000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}
