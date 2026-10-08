import { writeFile } from 'node:fs/promises';
import { expect } from 'vitest';
import type { BrowserPage } from './console-functional-browser.fixtures.js';

export async function assertAgentRegistryGeometry(page: BrowserPage, evidenceDirectory: string, viewportName: string, targetIdentity: string): Promise<void> {
  const geometry = await page.evaluate((identity) => {
    const rect = (element: Element | null) => {
      const box = element?.getBoundingClientRect();
      return box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height } : null;
    };
    const editors = Array.from(document.querySelectorAll('[data-open]')).filter((wrapper) =>
      ['Editar', 'Cerrar'].some((action) => wrapper.querySelector('button[aria-label]')?.getAttribute('aria-label') === `${action} registro de ${identity}`));
    const editor = editors[0] ?? null;
    const grid = editor?.closest('ul[aria-label="Agentes configurados"]');
    const card = editor?.closest('li');
    const cards = Array.from(grid?.querySelectorAll(':scope > li') ?? []);
    const region = editor?.querySelector(`section[aria-label="Registro de ${identity}"]`);
    const labels = Array.from(region?.querySelectorAll('label') ?? []);
    const controls = labels.filter((label) => !label.querySelector('input[type="checkbox"]'))
      .map((label) => {
        const control = label.querySelector<HTMLInputElement | HTMLSelectElement>('input, select');
        return { label: rect(label), control: rect(control), associated: Array.from(control?.labels ?? []).includes(label) };
      });
    const checkboxes = labels.filter((label) => label.querySelector('input[type="checkbox"]')).map((label) => {
      const input = label.querySelector<HTMLInputElement>('input[type="checkbox"]');
      const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
      });
      const textRects: { left: number; right: number }[] = [];
      while (walker.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        textRects.push(range.getBoundingClientRect());
      }
      return { label: rect(label), input: rect(input), textLeft: Math.min(...textRects.map((box) => box.left)),
        textRight: Math.max(...textRects.map((box) => box.right)), associated: Array.from(input?.labels ?? []).includes(label) };
    });
    return { viewport: window.innerWidth, document: document.documentElement.scrollWidth,
      count: editors.length, grid: rect(grid ?? null), gap: grid ? parseFloat(getComputedStyle(grid).columnGap) : 0,
      card: rect(card ?? null), cards: cards.map((item) => rect(item)), region: rect(region ?? null),
      open: editor?.getAttribute('data-open') === 'true', editor: rect(editor), controls, checkboxes };
  }, targetIdentity);
  await writeFile(`${evidenceDirectory}/geometry-${viewportName}.json`, JSON.stringify(geometry, null, 2) + '\n', { mode: 0o600 });
  expect(geometry.document).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.count).toBe(1);
  expect(geometry.editor).not.toBeNull();
  expect(geometry.card).not.toBeNull();
  expect(geometry.grid).not.toBeNull();
  if (!geometry.editor || !geometry.card || !geometry.grid) throw new Error('No se encontró la tarjeta de la identidad objetivo.');
  expect(geometry.open).toBe(viewportName !== 'desktop-closed');
  expect(geometry.region !== null).toBe(geometry.open);
  const columnWidth = geometry.viewport >= 1024 ? (geometry.grid.width - geometry.gap) / 2 : geometry.grid.width;
  for (const card of geometry.cards) {
    if (!card) throw new Error('Una tarjeta vecina no tiene medidas.');
    expect(Math.abs(card.width - columnWidth)).toBeLessThanOrEqual(1);
    expect(card.left).toBeGreaterThanOrEqual(geometry.grid.left - 0.5);
    expect(card.right).toBeLessThanOrEqual(geometry.grid.right + 0.5);
    for (const other of geometry.cards) {
      if (!other || other === card) continue;
      expect(card.right <= other.left + 0.5 || other.right <= card.left + 0.5
        || card.bottom <= other.top + 0.5 || other.bottom <= card.top + 0.5).toBe(true);
    }
  }
  if (!geometry.open) return;
  expect(geometry.controls.length).toBeGreaterThan(0);
  for (const item of geometry.controls) {
    if (!item.label || !item.control) throw new Error('Una etiqueta no contiene el control esperado.');
    expect(item.associated).toBe(true);
    expect(item.control.left).toBeGreaterThanOrEqual(item.label.left - 0.5);
    expect(item.control.right).toBeLessThanOrEqual(item.label.right + 0.5);
  }
  expect(geometry.checkboxes).toHaveLength(1);
  for (const item of geometry.checkboxes) {
    if (!item.label || !item.input) throw new Error('Una etiqueta no contiene su casilla.');
    expect(item.associated).toBe(true);
    expect(item.label.height).toBeGreaterThan(0);
    expect(item.input.width).toBeGreaterThan(0);
    expect(item.input.width).toBeLessThanOrEqual(item.input.height);
    expect(item.input.height).toBeGreaterThanOrEqual(16);
    expect(item.input.height).toBeLessThanOrEqual(24);
    expect(item.input.left).toBeGreaterThanOrEqual(item.label.left - 0.5);
    expect(item.input.right).toBeLessThanOrEqual(item.label.right + 0.5);
    expect(item.textLeft).toBeGreaterThanOrEqual(item.input.right - 1);
    expect(item.textRight).toBeLessThanOrEqual(item.label.right + 0.5);
  }
  const region = page.getByRole('region', { name: `Registro de ${targetIdentity}`, exact: true });
  const before = await page.evaluate((identity) => Array.from(document.querySelectorAll<HTMLInputElement>(
    `section[aria-label="Registro de ${identity}"] input[type="checkbox"]`,
  )).map((input) => input.checked), targetIdentity);
  for (const [index, text] of ['Sin límite (enviar null)'].entries()) {
    const label = region.locator('label').filter({ hasText: text });
    await label.click();
    const changed = await page.evaluate((identity) => Array.from(document.querySelectorAll<HTMLInputElement>(
      `section[aria-label="Registro de ${identity}"] input[type="checkbox"]`,
    )).map((input) => input.checked), targetIdentity);
    expect(changed).toEqual(before.map((value, item) => item === index ? !value : value));
    await label.click();
    const restored = await page.evaluate((identity) => Array.from(document.querySelectorAll<HTMLInputElement>(
      `section[aria-label="Registro de ${identity}"] input[type="checkbox"]`,
    )).map((input) => input.checked), targetIdentity);
    expect(restored).toEqual(before);
  }
}
