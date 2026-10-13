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

test('detects a control covering text in its own label', async () => {
  const metrics = await measure('<label style="position:relative">Name<input style="position:absolute;left:0;top:0"></label>');
  assert.ok(metrics.overlaps.length > 0);
});

test('detects overlapping controls without labels', async () => {
  const metrics = await measure('<h1>Controls</h1><div style="position:relative"><input style="position:absolute;left:0;top:0"><input style="position:absolute;left:0;top:0"></div>');
  assert.ok(metrics.overlaps.length > 0);
});

test('rejects disabled field clipping', () => {
  const metrics = { overflow: 0, clipped: [], overlaps: [], scrolls: [], theme: 'light', textFragments: 1,
    fields: [{ hiddenWidth: 20, keyboard: false }] };
  assert.match(absoluteFailures(metrics, 'light').join(), /Clipped field/);
});

test('a scroller fully outside its clipping parent is not reachable', async () => {
  const metrics = await measure('<h1>Heading</h1><div style="height:30px;overflow:hidden"><div style="height:30px;margin-top:50px;overflow:auto"><p>Inaccessible text</p></div></div>');
  assert.ok(metrics.clipped.length > 0);
});

test('redundant agent heading ellipsis retains its complete visible identity', async () => {
  const metrics = await measure('<section aria-label="Perfil y contexto de jarvis"><h2 style="width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Perfil y contexto de jarvis</h2><p>Steven / jarvis</p></section>');
  assert.equal(metrics.clipped.length, 0);
  assert.ok(metrics.ellipses.length > 0);
});

test('agent heading ellipsis fails when its identity is also clipped', async () => {
  const metrics = await measure('<section aria-label="Perfil y contexto de jarvis"><h2 style="width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Perfil y contexto de jarvis</h2><p style="width:30px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Steven / jarvis</p></section>');
  assert.ok(metrics.clipped.length > 0);
});

test('a sticky control without a shared scroll container cannot hide an overlap', async () => {
  const metrics = await measure('<div style="position:relative"><p style="position:absolute;top:0">Text</p><button style="position:sticky;top:0;background:white">Sticky control</button></div>');
  assert.ok(metrics.overlaps.length > 0);
});

test('records opaque sticky chrome over reachable scroll content separately', async () => {
  const metrics = await measure('<div style="height:100px;overflow:auto"><p style="margin:0;height:400px;padding-top:70px;box-sizing:border-box">Scrollable text</p><footer style="position:sticky;bottom:0;height:50px;background:white"><button>Action</button></footer></div>');
  assert.ok(metrics.occlusions.length > 0);
  assert.deepEqual(absoluteFailures(metrics, 'light'), []);
});

test('rejects content still covered by a sticky footer at scroll end', async () => {
  const metrics = await measure('<h1>Heading</h1><div id="scroll" style="height:100px;overflow:auto"><div style="height:400px;position:relative"><span style="position:absolute;bottom:5px">Last row</span></div><footer style="position:sticky;bottom:0;height:50px;margin-top:-50px;background:white"><button>Action</button></footer></div><script>document.querySelector("#scroll").scrollTop=1000</script>');
  assert.match(absoluteFailures(metrics, 'light').join(), /unreachable under sticky/);
});

test('translucent sticky chrome cannot exempt overlapping text', async () => {
  const metrics = await measure('<div style="height:100px;overflow:auto"><p style="margin:0;height:400px;padding-top:58px;box-sizing:border-box">Scrollable text</p><footer style="position:sticky;bottom:0;height:50px;background:rgba(255,0,0,0.01)"><button>Action</button></footer></div>');
  assert.ok(metrics.overlaps.length > 0);
});

test('ancestor opacity prevents opaque sticky exemption', async () => {
  const metrics = await measure('<div style="height:100px;overflow:auto;opacity:0.5"><p style="margin:0;height:400px;padding-top:58px;box-sizing:border-box">Scrollable text</p><footer style="position:sticky;bottom:0;height:50px;background:white"><button>Action</button></footer></div>');
  assert.ok(metrics.overlaps.length > 0);
});
