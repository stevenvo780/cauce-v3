import { writeFile } from 'node:fs/promises';
import { expect } from 'vitest';
import type { BrowserPage } from './console-functional-browser.fixtures.js';

export async function assertAgentRegistryGeometry(page: BrowserPage, evidenceDirectory: string, viewportName: string, targetIdentity: string): Promise<void> {
  const geometry = await page.evaluate((identity) => {
    const rect = (element: Element | null) => {
      const box = element?.getBoundingClientRect();
      return box ? { left: box.left, right: box.right, width: box.width, height: box.height } : null;
    };
    const editor = Array.from(document.querySelectorAll('.agent-registry-editor')).find((wrapper) =>
      wrapper.querySelector('button[aria-label]')?.getAttribute('aria-label')?.endsWith(identity)) ?? null;
    const grid = editor?.closest('.settings-agents');
    const card = editor?.closest('.settings-agent');
    const cards = Array.from(grid?.querySelectorAll(':scope > .settings-agent') ?? []);
    const controls = Array.from(document.querySelectorAll('.agent-registry-form > label:not(.agent-registry-checkbox)'))
      .map((label) => ({ label: rect(label), control: rect(label.querySelector('input, select')) }));
    const checkboxes = Array.from(document.querySelectorAll('.agent-registry-checkbox')).map((label) => {
      const input = label.querySelector('input[type="checkbox"]');
      const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
      });
      const textLefts: number[] = [];
      while (walker.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        textLefts.push(range.getBoundingClientRect().left);
      }
      return { label: rect(label), input: rect(input), textLeft: Math.min(...textLefts) };
    });
    return { viewport: window.innerWidth, document: document.documentElement.scrollWidth,
      grid: rect(grid ?? null), card: rect(card ?? null), cards: cards.map((item) => rect(item)),
      cardIndex: cards.findIndex((item) => item === card),
      open: editor?.getAttribute('data-open') === 'true', editor: rect(editor), controls, checkboxes };
  }, targetIdentity);
  await writeFile(`${evidenceDirectory}/geometry-${viewportName}.json`, JSON.stringify(geometry, null, 2) + '\n', { mode: 0o600 });
  expect(geometry.document).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.editor).not.toBeNull();
  if (geometry.editor === null) throw new Error('No se encontró el editor de la identidad objetivo.');
  expect(geometry.card).not.toBeNull();
  if (geometry.card === null) throw new Error('No se encontró la tarjeta de la identidad objetivo.');
  if (viewportName === 'desktop' || viewportName === 'desktop-closed') {
    expect(geometry.grid).not.toBeNull();
    if (geometry.grid === null) throw new Error('No se encontró la cuadrícula de agentes.');
    expect(geometry.card).not.toBeNull();
    expect(geometry.open).toBe(viewportName === 'desktop');
    if (viewportName === 'desktop') {
      expect(geometry.card.width).toBeGreaterThan(geometry.grid.width * 0.65);
      const siblings = geometry.cards.filter((item, index) => item && index !== geometry.cardIndex);
      expect(siblings.length).toBeGreaterThan(0);
      for (const sibling of siblings) {
        if (sibling === null) throw new Error('Una tarjeta vecina no tiene medidas.');
        expect(sibling.width).toBeLessThan(geometry.grid.width * 0.65);
      }
    } else {
      expect(geometry.card.width).toBeLessThan(geometry.grid.width * 0.65);
    }
  }
  if (geometry.open) {
    expect(geometry.controls.length).toBeGreaterThan(0);
    for (const item of geometry.controls) {
      expect(item.label).not.toBeNull();
      if (item.label === null) throw new Error('Un control no tiene etiqueta contenedora.');
      expect(item.control).not.toBeNull();
      if (item.control === null) throw new Error('Una etiqueta no contiene el control esperado.');
      expect(item.control.left).toBeGreaterThanOrEqual(item.label.left - 0.5);
      expect(item.control.right).toBeLessThanOrEqual(item.label.right + 0.5);
    }
    expect(geometry.checkboxes).toHaveLength(3);
    for (const item of geometry.checkboxes) {
      expect(item.label).not.toBeNull();
      if (item.label === null) throw new Error('Una casilla no tiene etiqueta contenedora.');
      expect(item.input).not.toBeNull();
      if (item.input === null) throw new Error('Una etiqueta no contiene su casilla.');
      expect(item.label.height).toBeGreaterThanOrEqual(44);
      expect(item.input.width).toBeGreaterThanOrEqual(18);
      expect(item.input.width).toBeLessThanOrEqual(24);
      expect(item.input.height).toBeGreaterThanOrEqual(18);
      expect(item.input.height).toBeLessThanOrEqual(24);
      expect(item.textLeft).toBeGreaterThanOrEqual(item.input.right - 1);
    }
  }
}
