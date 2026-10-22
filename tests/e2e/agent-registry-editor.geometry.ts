import { writeFile } from 'node:fs/promises';
import { expect } from 'vitest';
import type { BrowserPage } from './console-functional-browser.fixtures.js';

export async function assertAgentRegistryGeometry(page: BrowserPage, evidenceDirectory: string, viewportName: string, targetIdentity: string): Promise<void> {
  const geometry = await page.evaluate((identity) => {
    const rect = (element: Element | null) => {
      const box = element?.getBoundingClientRect();
      return box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height } : null;
    };
    const regions = Array.from(document.querySelectorAll('section[aria-label]')).filter((section) =>
      section.getAttribute('aria-label') === `Registro de ${identity}`);
    const region = regions[0] ?? null;
    const editor = region?.closest('[data-open]') ?? null;
    const dialog = region?.closest('[role="dialog"]') ?? null;
    const tiles = Array.from(document.querySelectorAll('[data-agent-tile]')).filter((tile) => tile.getAttribute('data-agent-tile') === identity);
    const card = tiles[0]?.closest('li');
    const grid = card?.closest('ul[aria-label="Agentes configurados"]');
    const cards = Array.from(grid?.querySelectorAll(':scope > li') ?? []);
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
    return { viewport: window.innerWidth, height: window.innerHeight, document: document.documentElement.scrollWidth,
      count: regions.length, tiles: tiles.length, grid: rect(grid ?? null), gap: grid ? parseFloat(getComputedStyle(grid).columnGap) : 0,
      columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').map(parseFloat) : [], dialog: rect(dialog),
      card: rect(card ?? null), cards: cards.map((item) => rect(item)), region: rect(region ?? null),
      open: editor?.getAttribute('data-open') === 'true', editor: rect(editor), controls, checkboxes };
  }, targetIdentity);
  await writeFile(`${evidenceDirectory}/geometry-${viewportName}.json`, JSON.stringify(geometry, null, 2) + '\n', { mode: 0o600 });
  expect(geometry.document).toBeLessThanOrEqual(geometry.viewport);
  const expectedOpen = viewportName !== 'desktop-closed';
  expect(geometry.count).toBe(expectedOpen ? 1 : 0);
  expect(geometry.tiles).toBe(1);
  expect(geometry.card).not.toBeNull();
  expect(geometry.grid).not.toBeNull();
  if (!geometry.card || !geometry.grid) throw new Error('No se encontró la tarjeta de la identidad objetivo.');
  expect(geometry.open).toBe(expectedOpen);
  expect(geometry.region !== null).toBe(geometry.open);
  expect(geometry.columns.length).toBeGreaterThan(0);
  expect(geometry.columns.every((width) => Number.isFinite(width) && width > 0)).toBe(true);
  const columnWidth = (geometry.grid.width - geometry.gap * (geometry.columns.length - 1)) / geometry.columns.length;
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
  if (!geometry.open) { expect(geometry.editor).toBeNull(); expect(geometry.dialog).toBeNull(); return; }
  if (!geometry.editor || !geometry.dialog || !geometry.region) throw new Error('No se encontró el diálogo con su editor.');
  expect(geometry.dialog.left).toBeGreaterThanOrEqual(-0.5);
  expect(geometry.dialog.right).toBeLessThanOrEqual(geometry.viewport + 0.5);
  expect(geometry.dialog.top).toBeGreaterThanOrEqual(-0.5);
  expect(geometry.dialog.bottom).toBeLessThanOrEqual(geometry.height + 0.5);
  expect(geometry.editor.left).toBeGreaterThanOrEqual(geometry.dialog.left - 0.5);
  expect(geometry.editor.right).toBeLessThanOrEqual(geometry.dialog.right + 0.5);
  expect(geometry.region.left).toBeGreaterThanOrEqual(geometry.editor.left - 0.5);
  expect(geometry.region.right).toBeLessThanOrEqual(geometry.editor.right + 0.5);
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
  for (const [index, text] of ['Sin límite'].entries()) {
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
