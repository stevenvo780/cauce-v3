import { randomBytes } from 'node:crypto';
import type { BrowserContext, BrowserPage, Locator } from './console-functional-browser.fixtures.js';

/** The fixture types only cover what older suites used; Playwright objects expose the rest. */
export interface V4Locator extends Locator {
  first(): V4Locator;
  nth(index: number): V4Locator;
  check(): Promise<void>;
  uncheck(): Promise<void>;
  inputValue(): Promise<string>;
  isVisible(): Promise<boolean>;
  isDisabled(): Promise<boolean>;
  selectOption(value: string | { label: string }): Promise<void>;
  locator(selector: string): V4Locator;
  filter(options: { hasText: string }): V4Locator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): V4Locator;
  getByLabel(name: string, options?: { exact?: boolean }): V4Locator;
  getByText(text: string | RegExp, options?: { exact?: boolean }): V4Locator;
  evaluate<T>(callback: (element: HTMLInputElement) => T): Promise<T>;
}

export interface V4Page extends Omit<BrowserPage, 'getByRole' | 'getByLabel' | 'getByText' | 'locator' | 'context'> {
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): V4Locator;
  getByLabel(name: string, options?: { exact?: boolean }): V4Locator;
  getByText(text: string | RegExp, options?: { exact?: boolean }): V4Locator;
  locator(selector: string): V4Locator;
  context(): BrowserContext;
  waitForTimeout(ms: number): Promise<void>;
}

export const asV4Page = (page: BrowserPage): V4Page => page as unknown as V4Page;

export interface V4Person {
  email: string; name: string; password: string; company: { name: string; slug: string };
}

export function syntheticPerson(label: string, run: string): V4Person {
  return {
    email: `v4-${label}-${run}@example.test`, name: `Persona V4 ${label.toUpperCase()}`,
    password: `V4-${label}-${randomBytes(18).toString('hex')}`,
    company: { name: `Empresa V4 ${label.toUpperCase()}`, slug: `v4-${label}-${run}` },
  };
}

interface ConsoleMessage { type(): string; text(): string; location(): { url: string } }

export interface IgnoredConsoleRule {
  id: string;
  /** Why this message is tolerated; it is part of the contract of the suite. */
  reason: string;
  matches(text: string, url: string): boolean;
}

/** The hermetic gateway has no terminal relay and no MCP mount: the console probes them and gets 501/404. */
export const HERMETIC_INSTANCE_RULES: IgnoredConsoleRule[] = [
  { id: 'terminal-capability-501', reason: 'hermetic gateway without terminal relay',
    matches: (text, url) => text.includes('status of 501') && safePath(url) === '/v3/console/terminal/capability' },
  { id: 'mcp-client-delegations-404', reason: 'hermetic gateway without the optional MCP mount',
    matches: (text, url) => text.includes('status of 404') && safePath(url) === '/v3/console/mcp/client-delegations' },
];

/** Product defect found by this suite: `pattern` attributes with an unescaped hyphen are invalid under Chrome's `v` flag. */
export const PATTERN_DEFECT_RULE: IgnoredConsoleRule = {
  id: 'invalid-pattern-attribute', reason: 'pattern attribute is not a valid regular expression with the v flag',
  matches: (text) => /^Pattern attribute value .* is not a valid regular expression/u.test(text),
};

/**
 * Collects browser console errors and uncaught page errors. A 4xx the test provoked on purpose
 * must be announced with `expectHttpError`; every other tolerated message matches a named rule.
 */
export class BrowserErrorLog {
  readonly unexpected: string[] = [];
  readonly trace: string[] = [];
  readonly ignored = new Map<string, number>();
  private readonly expected: { path: string; status: number }[] = [];
  private readonly relaxed = new Set<string>();

  constructor(private readonly rules: readonly IgnoredConsoleRule[]) {}

  expectHttpError(path: string, status: number): void { this.expected.push({ path, status }); }

  /** From now on a page may log 4xx loads on its own (a retired company keeps polling and gets 403). */
  relaxForbidden(label: string): void { this.relaxed.add(label); }

  watch(page: BrowserPage, label: string): void {
    page.on('console', (value: unknown) => {
      const message = value as ConsoleMessage;
      const url = message.location().url;
      this.trace.push(`${message.type()} ${url} ${message.text().slice(0, 300)}`);
      if (message.type() !== 'error') return;
      const text = message.text();
      const rule = this.rules.find((candidate) => candidate.matches(text, url));
      if (rule) { this.ignored.set(rule.id, (this.ignored.get(rule.id) ?? 0) + 1); return; }
      const status = /status of (\d{3})/u.exec(text)?.[1];
      if (text.startsWith('Failed to load resource') && status !== undefined) {
        if (status === '403' && this.relaxed.has(label)) return;
        const path = safePath(url);
        const index = this.expected.findIndex((item) => item.path === path && item.status === Number(status));
        if (index >= 0) { this.expected.splice(index, 1); return; }
      }
      this.unexpected.push(`${label}: ${text} (${safePath(url)})`);
    });
    page.on('pageerror', (value: unknown) => {
      this.unexpected.push(`${label}: pageerror ${value instanceof Error ? value.message : String(value)}`);
    });
  }

  assertClean(): void {
    const problems = [...this.unexpected];
    if (this.expected.length > 0) problems.push(`announced HTTP errors never observed: ${JSON.stringify(this.expected)}`);
    if (problems.length > 0) throw new Error(`browser console errors:\n${problems.join('\n')}`);
  }
}

function safePath(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}

export async function apiGet(page: V4Page, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(async (target: string) => {
    const response = await fetch(target, { credentials: 'include', cache: 'no-store' });
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
  }, path);
}

export async function bodySnippet(page: V4Page): Promise<string> {
  const text = (await page.locator('body').innerText().catch(() => '')).replaceAll(/\s+/gu, ' ').slice(0, 1500);
  const labels = await page.evaluate(() => Array.from(document.querySelectorAll('[aria-label]'))
    .map((element) => element.getAttribute('aria-label') ?? '').slice(0, 60)).catch((): string[] => []);
  return `${text} || labels=${JSON.stringify(labels)}`;
}

export async function login(page: V4Page, baseUrl: string, person: V4Person): Promise<void> {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Correo', { exact: true }).fill(person.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(person.password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
}

export async function openRegistration(page: V4Page, baseUrl: string): Promise<V4Locator> {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  const form = page.getByRole('form', { name: 'Registro de persona y empresa' });
  await form.waitFor({ timeout: 15_000 });
  return form;
}

export async function fillRegistration(form: V4Locator, person: V4Person): Promise<void> {
  for (const [label, value] of [
    ['Tu nombre', person.name], ['Correo', person.email], ['Contraseña', person.password],
    ['Nombre de empresa', person.company.name], ['Identificador de empresa', person.company.slug],
  ] as const) await form.getByLabel(label, { exact: true }).fill(value);
}

/** The native constraint-validation state of a field: the message a person sees on submit. */
export async function validity(field: V4Locator): Promise<{ valid: boolean; message: string }> {
  return field.evaluate((element) => ({ valid: element.validity.valid, message: element.validationMessage }));
}
