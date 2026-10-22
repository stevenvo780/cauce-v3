import { expect } from 'vitest';
import { apiGet, type V4Page } from './v4-console-real-browser.helpers.js';

/** Page-level steps of the office E2E that do not depend on its fixture state. */
export async function apiMutation(page: V4Page, path: string, payload: unknown, method = 'POST'): Promise<number> {
  return page.evaluate(async ({ target, body, method }: { target: string; body: string; method: string }) => {
    const session = await (await fetch('/v3/auth/session', { credentials: 'include', cache: 'no-store' })).json() as { csrf_token?: string };
    const response = await fetch(target, { method, credentials: 'include', body,
      headers: { 'Content-Type': 'application/json', 'X-Cauce-Console': '1', 'X-CSRF-Token': session.csrf_token ?? '' } });
    return response.status;
  }, { target: path, body: JSON.stringify(payload), method });
}

export function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }

export async function expectCampusRoom(page: V4Page, label: string, agents: number): Promise<void> {
  const accessibleCount = () => page.evaluate((target: string) => {
    const toolbar = document.querySelector('[role="toolbar"][aria-label="Edificios del campus"]');
    const button = Array.from(toolbar?.querySelectorAll('button[aria-label]') ?? [])
      .find((candidate) => candidate.getAttribute('aria-label')?.startsWith(target));
    if (!(button instanceof HTMLElement) || button.getClientRects().length === 0) return null;
    const description = button.getAttribute('aria-label')?.split(': ').at(-1);
    return description?.split(',')[0]?.trim() ?? null;
  }, label);
  const expected = `${String(agents)} ${agents === 1 ? 'agente' : 'agentes'}`;
  await expect.poll(accessibleCount, { timeout: 30_000 }).toBe(expected);
}

export async function configChange(page: V4Page, mutation: Record<string, unknown>): Promise<number> {
  const snapshot = await apiGet(page, '/v3/console/config');
  const revision = snapshot.body.revision;
  if (typeof revision !== 'number') throw new Error('configuration snapshot has no numeric revision');
  return apiMutation(page, '/v3/console/config/changes', { expected_revision: revision, dry_run: false, mutation });
}

export async function openRegistry(page: V4Page, baseUrl: string, tenant: string, alias: string) {
  await page.goto(`${baseUrl}/config?seccion=agentes&agente=${encodeURIComponent(`${tenant}/${alias}`)}`, { waitUntil: 'domcontentloaded' });
  const sheet = page.getByRole('dialog');
  await sheet.waitFor({ timeout: 20_000 });
  await sheet.getByRole('tab', { name: 'Ajustes', exact: true }).click();
  const editor = sheet.getByRole('region', { name: `Registro de ${tenant}/${alias}`, exact: true });
  await editor.waitFor({ timeout: 20_000 });
  return { sheet, editor };
}

export async function applyRegistryChange(page: V4Page): Promise<void> {
  await page.getByRole('button', { name: 'Previsualizar cambio', exact: true }).click();
  const apply = page.getByRole('button', { name: 'Aplicar cambio', exact: true });
  await expect.poll(() => apply.isDisabled(), { timeout: 20_000 }).toBe(false);
  await apply.click();
  await page.getByRole('status').filter({ hasText: 'Aplicado en revisión' }).waitFor({ timeout: 20_000 });
}

export async function topologyMember(page: V4Page, tenant: string, alias: string): Promise<Record<string, unknown> | undefined> {
  const topology = await apiGet(page, '/v3/console/topology');
  expect(topology.status).toBe(200);
  const tenants = (topology.body.tenants ?? []) as { id?: string; rooms?: { id?: string; members?: Record<string, unknown>[] }[] }[];
  for (const room of tenants.find(row => row.id === tenant)?.rooms ?? []) {
    const member = (room.members ?? []).find(value => value.alias === alias);
    if (member) return { ...member, room_id: room.id };
  }
  return undefined;
}
