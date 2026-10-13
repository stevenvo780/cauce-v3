import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { absoluteFailures, measureV4Layout } from './layout-v4-measure.mjs';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function measure(html) {
  const page = await browser.newPage({ viewport: { width: 390, height: 1000 } });
  try {
    await page.setContent(`<style>:root{color-scheme:light}body{margin:0}main{width:100%}</style><main>${html}</main>`);
    return await page.evaluate(measureV4Layout);
  } finally { await page.close(); }
}

test('rejects a document that overflows horizontally', async () => {
  const metrics = await measure('<p style="width:700px">Visible content</p>');
  assert.equal(metrics.overflow, 310);
  assert.match(absoluteFailures(metrics, 'light').join(), /Horizontal overflow/);
});

test('detects hidden text without document overflow', async () => {
  const metrics = await measure('<p style="width:70px;overflow:hidden;white-space:nowrap">A long clipped heading</p>');
  assert.equal(metrics.overflow, 0);
  assert.ok(metrics.clipped.length > 0);
});

test('wrapped lines do not overlap each other', async () => {
  const metrics = await measure('<p style="width:90px">Several ordinary words wrap over many lines without clipping.</p>');
  assert.deepEqual(absoluteFailures(metrics, 'light'), []);
});

test('rejects two independent text labels at the same location', async () => {
  const metrics = await measure('<div style="position:relative"><span style="position:absolute">First label</span><span style="position:absolute">Second label</span></div>');
  assert.ok(metrics.overlaps.length > 0);
});

test('rejects a text label covered by an unrelated input', async () => {
  const metrics = await measure('<div style="position:relative"><span>Heading</span><input style="position:absolute;left:0;top:0" aria-label="Name"></div>');
  assert.ok(metrics.overlaps.length > 0);
});

test('a keyboard reachable horizontal scroller remains usable', async () => {
  const metrics = await measure('<div tabindex="0" style="width:90px;overflow:auto"><p style="white-space:nowrap">Long scrollable content</p></div>');
  assert.deepEqual(absoluteFailures(metrics, 'light'), []);
  assert.ok(metrics.scrolls.some(scroll => scroll.hiddenWidth > 0 && scroll.keyboard));
});

test('rejects an unreachable horizontal scroller', async () => {
  const metrics = await measure('<div style="width:90px;overflow:auto"><p style="white-space:nowrap">Long scrollable content</p></div>');
  assert.match(absoluteFailures(metrics, 'light').join(), /without keyboard/);
});

test('ignores content inside closed disclosure and hidden panels', async () => {
  const metrics = await measure('<details><summary>Details</summary><p style="width:900px">Hidden long content</p></details><section hidden>Hidden panel</section>');
  assert.deepEqual(absoluteFailures(metrics, 'light'), []);
});

test('records intentional ellipsis only with a full accessible name', async () => {
  const metrics = await measure('<p title="A long accessible heading" style="width:70px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">A long accessible heading</p>');
  assert.equal(metrics.clipped.length, 0);
  assert.ok(metrics.ellipses.length > 0);
});

test('rejects a wrong effective theme', async () => {
  const metrics = await measure('<h1>Visible content</h1>');
  assert.match(absoluteFailures(metrics, 'dark').join(), /Expected dark theme/);
});

test('screen reader text does not participate in painted overlaps', async () => {
  const metrics = await measure('<h1>Heading</h1><p style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">Accessible description</p>');
  assert.deepEqual(absoluteFailures(metrics, 'light'), []);
});

test('offscreen scroll content does not overlap adjacent controls', async () => {
  const metrics = await measure('<div style="height:30px;overflow:auto"><div style="height:300px"><p>Scrollable description</p><p>Offscreen text</p></div></div><input aria-label="Adjacent field">');
  assert.deepEqual(absoluteFailures(metrics, 'light'), []);
});
