#!/usr/bin/env node
/**
 * Layout ratchet for the console, measured in a real browser.
 *
 * The 654 unit tests run in jsdom, which applies no CSS and computes no geometry: a menu whose
 * labels overlap and a view that wastes a third of the screen both pass green. The CSS guards that
 * do exist read the stylesheet as TEXT and match strings, so they cannot see the rendered box
 * either. This gate is the missing measurement: it drives Chromium over every declared route at
 * every breakpoint and compares real numbers against a recorded baseline.
 *
 * Baseline semantics match scripts/calidad.mjs: the numbers may only improve. A regression fails
 * with the measured value next to the budget it broke; an improvement fails too, asking for the
 * baseline to be tightened, so a fix cannot silently stop being enforced.
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSOLE_ROOT = resolve(HERE, '..');
const BASELINE = resolve(HERE, 'layout-baseline.json');
const PORT = 4188;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;

/** Every declared route with a visible nav entry, plus the landing page. */
const ROUTES = ['/', '/live', '/accounts', '/messages', '/queues', '/observability', '/config', '/terminal'];

/**
 * The two narrow widths are the shipped breakpoints; 1440 is the common laptop; 1920 and 2560 are
 * the desks this console is actually operated from and the widths the layout has never answered.
 */
const VIEWPORTS = [360, 760, 1100, 1440, 1920, 2560];

/** Noise floor per budget. Scroll depth is a ratio, so a pixel tolerance there would wave through
    a view that grew from one screen to three. */
const TOLERANCIA = {
  huecoMaximo: 2,
  desbordeMaximo: 0,
  recorteMaximo: 8,
  enlacesSinNombre: 0,
  solapesDeRotulo: 0,
  pantallasMaximas: 0.1,
};

/** States reached by clicking, measured on top of the plain route: the fleet table is only clipped
    once the drawer takes half the width, and Perfil is the tab that takes the most. */
const CAJON = '/live#cajon';
const PERFIL = '/live#perfil';

const escribirBaseline = process.argv.includes('--update');

function esperar(ms) {
  return new Promise((cumplir) => setTimeout(cumplir, ms));
}

async function esperarServidor(intentos = 60) {
  for (let i = 0; i < intentos; i += 1) {
    try {
      const respuesta = await fetch(ORIGIN);
      if (respuesta.ok) return;
    } catch { /* el servidor todavía no escucha */ }
    await esperar(500);
  }
  throw new Error(`the console did not answer at ${ORIGIN}`);
}

/**
 * Runs inside the page. Returns raw geometry only: every judgement is made on this side, so the
 * failure message can name the budget that broke.
 */
function medirEnLaPagina() {
  const raiz = document.documentElement;
  const main = document.querySelector('main');
  const barra = document.querySelector('.sidebar');
  const ancho = window.innerWidth;
  const caja = (nodo) => (nodo ? nodo.getBoundingClientRect() : null);
  const cajaMain = caja(main);
  const cajaBarra = caja(barra);

  // A link whose label is display:none contributes no innerText, which is exactly what a screen
  // reader gets: the icon is aria-hidden and title is undefined for every enabled entry.
  const enlaces = Array.from(document.querySelectorAll('.sidebar nav a'));
  const nombres = enlaces.map((enlace) => {
    const etiqueta = enlace.getAttribute('aria-label') ?? '';
    const visible = enlace.innerText ?? '';
    const titulo = enlace.getAttribute('title') ?? '';
    return (etiqueta || visible || titulo).trim();
  });

  // Overlapping nav labels are the defect that shipped once and no jsdom test could see.
  const rotulos = enlaces
    .map((enlace) => enlace.querySelector('span'))
    .filter((span) => span && span.getClientRects().length > 0)
    .map((span) => span.getBoundingClientRect());
  let solapes = 0;
  for (let i = 0; i < rotulos.length; i += 1) {
    for (let j = i + 1; j < rotulos.length; j += 1) {
      const a = rotulos[i];
      const b = rotulos[j];
      const cruzaX = a.left < b.right - 1 && b.left < a.right - 1;
      const cruzaY = a.top < b.bottom - 1 && b.top < a.bottom - 1;
      if (cruzaX && cruzaY) solapes += 1;
    }
  }

  // The dead band beside the content: what a wider monitor buys and the layout throws away.
  const anchoBarraHorizontal = cajaBarra && cajaBarra.width < ancho ? cajaBarra.width : 0;
  const hueco = cajaMain ? Math.round(ancho - anchoBarraHorizontal - cajaMain.width) : 0;

  // A box with `overflow-x:auto` hides its content instead of widening the document, so the root
  // scrollWidth stays clean while the columns are cut mid-word. The document-level overflow has its
  // own budget below, so the scrolling root is skipped here rather than counted twice.
  const selectorDe = (nodo) => {
    const clases = Array.from(nodo.classList).slice(0, 3).map((clase) => `.${clase}`).join('');
    return `${nodo.tagName.toLowerCase()}${nodo.id ? `#${nodo.id}` : ''}${clases}`;
  };
  let recorte = 0;
  let recorteSelector = '';
  for (const nodo of document.querySelectorAll('*')) {
    if (nodo === raiz || nodo === document.body) continue;
    const desbordeX = window.getComputedStyle(nodo).overflowX;
    if (desbordeX !== 'auto' && desbordeX !== 'scroll') continue;
    const oculto = Math.round(nodo.scrollWidth - nodo.clientWidth);
    if (oculto <= recorte) continue;
    recorte = oculto;
    recorteSelector = selectorDe(nodo);
  }

  return {
    desborde: Math.round(raiz.scrollWidth - ancho),
    hueco: Math.max(0, hueco),
    recorte,
    recorteSelector,
    anchoMain: cajaMain ? Math.round(cajaMain.width) : 0,
    altoContenido: main ? Math.round(main.scrollHeight) : 0,
    pantallas: main ? Number((main.scrollHeight / window.innerHeight).toFixed(2)) : 0,
    enlacesSinNombre: nombres.filter((nombre) => nombre === '').length,
    enlacesTotales: enlaces.length,
    solapesDeRotulo: solapes,
  };
}

/**
 * Drives the two clicked states of /live. A state that cannot be reached is recorded and the run
 * continues: losing one state must not cost the other five viewports.
 */
async function medirEstadosDeLive(pagina, viewport, medidas, sinMedir) {
  const medir = async (etiqueta, accion) => {
    try {
      await accion();
      await pagina.waitForTimeout(700);
      medidas.push({ ruta: etiqueta, viewport, ...(await pagina.evaluate(medirEnLaPagina)) });
      return true;
    } catch (error) {
      sinMedir.push(`${String(viewport)}px ${etiqueta}: ${String(error.message).split('\n')[0]}`);
      return false;
    }
  };

  const abierto = await medir(CAJON, () => pagina.locator('table tbody tr').first().click({ timeout: 5000 }));
  if (!abierto) {
    sinMedir.push(`${String(viewport)}px ${PERFIL}: not attempted, the drawer never opened`);
    return;
  }
  await medir(PERFIL, () => pagina.locator('.agent-drawer-tab', { hasText: /perfil/i }).first().click({ timeout: 5000 }));
}

async function medirTodo() {
  const navegador = await chromium.launch();
  const medidas = [];
  const sinMedir = [];
  try {
    for (const viewport of VIEWPORTS) {
      const contexto = await navegador.newContext({ viewport: { width: viewport, height: 1000 } });
      const pagina = await contexto.newPage();
      for (const ruta of ROUTES) {
        await pagina.goto(ORIGIN + ruta, { waitUntil: 'networkidle', timeout: 30000 });
        // Transitions in flight report boxes that are still moving.
        await pagina.addStyleTag({
          content: '*,*::before,*::after{animation:none!important;transition:none!important}',
        });
        await pagina.waitForTimeout(700);
        const medida = await pagina.evaluate(medirEnLaPagina);
        medidas.push({ ruta, viewport, ...medida });
        if (ruta === '/live') await medirEstadosDeLive(pagina, viewport, medidas, sinMedir);
      }
      await contexto.close();
    }
  } finally {
    await navegador.close();
  }
  return { medidas, sinMedir };
}

/**
 * Collapses the per-route measurements into the numbers the baseline tracks. Everything here is a
 * worst case: a budget that only records the best route would let the worst one rot.
 */
function resumir(medidas) {
  const porViewport = {};
  for (const viewport of VIEWPORTS) {
    const delViewport = medidas.filter((m) => m.viewport === viewport);
    const peorHueco = delViewport.reduce((peor, m) => (m.hueco > peor.hueco ? m : peor), delViewport[0]);
    const peorRecorte = delViewport.reduce((peor, m) => (m.recorte > peor.recorte ? m : peor), delViewport[0]);
    porViewport[String(viewport)] = {
      huecoMaximo: peorHueco.hueco,
      huecoMaximoEn: peorHueco.ruta,
      desbordeMaximo: Math.max(...delViewport.map((m) => m.desborde)),
      recorteMaximo: peorRecorte.recorte,
      recorteMaximoEn: peorRecorte.ruta,
      recorteMaximoQue: peorRecorte.recorteSelector,
      enlacesSinNombre: Math.max(...delViewport.map((m) => m.enlacesSinNombre)),
      solapesDeRotulo: Math.max(...delViewport.map((m) => m.solapesDeRotulo)),
      pantallasMaximas: Math.max(...delViewport.map((m) => m.pantallas)),
    };
  }
  return porViewport;
}

/** Every tracked number is one where lower is better, so one comparison covers them all. */
const CLAVES = Object.keys(TOLERANCIA);

/** Where to look, for the budgets whose number alone does not say it. */
const DONDE = {
  huecoMaximo: (v) => v.huecoMaximoEn,
  recorteMaximo: (v) => `${v.recorteMaximoEn} ${v.recorteMaximoQue}`,
};

function comparar(actual, base) {
  const peores = [];
  const mejores = [];
  for (const viewport of Object.keys(actual)) {
    const esperado = base[viewport];
    if (!esperado) {
      peores.push(`${viewport}px: the baseline does not record this viewport`);
      continue;
    }
    for (const clave of CLAVES) {
      const valor = actual[viewport][clave];
      const tope = esperado[clave];
      if (typeof tope !== 'number') {
        peores.push(`${viewport}px ${clave}: the baseline does not record this budget`);
        continue;
      }
      const margen = TOLERANCIA[clave];
      if (valor > tope + margen) {
        const donde = DONDE[clave] ? ` (${DONDE[clave](actual[viewport])})` : '';
        peores.push(`${viewport}px ${clave}: ${String(valor)} against a budget of ${String(tope)}${donde}`);
      } else if (valor < tope - margen) {
        mejores.push(`${viewport}px ${clave}: ${String(valor)}, better than the recorded ${String(tope)}`);
      }
    }
  }
  return { peores, mejores };
}

function imprimirTabla(medidas) {
  const cabecera = ['ruta', 'ancho', 'main', 'hueco', 'desborde', 'recorte', 'recortado en', 'pantallas', 'sin nombre', 'solapes'];
  const filas = medidas.map((m) => [
    m.ruta, m.viewport, m.anchoMain, m.hueco, m.desborde, m.recorte, m.recorteSelector || '-',
    m.pantallas, m.enlacesSinNombre, m.solapesDeRotulo,
  ].map(String));
  const anchos = cabecera.map((titulo, i) => Math.max(titulo.length, ...filas.map((f) => f[i].length)));
  const esNumero = (celda) => /^-?\d+(\.\d+)?$/.test(celda);
  const texto = cabecera.map((_, i) => filas.length === 0 || !esNumero(filas[0][i]));
  const linea = (celdas) => celdas.map((c, i) => (texto[i] ? c.padEnd(anchos[i]) : c.padStart(anchos[i]))).join('  ');
  console.log(linea(cabecera));
  for (const fila of filas) console.log(linea(fila));
}

async function principal() {
  const servidor = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: CONSOLE_ROOT,
    env: { ...process.env, VITE_USE_MOCKS: 'true' },
    stdio: 'ignore',
  });
  let medidas;
  let sinMedir;
  try {
    await esperarServidor();
    ({ medidas, sinMedir } = await medirTodo());
  } finally {
    servidor.kill('SIGTERM');
  }

  imprimirTabla(medidas);
  const resumen = resumir(medidas);

  if (sinMedir.length > 0) {
    console.error('\nlayout: these states could not be reached, so their budgets went unmeasured:');
    for (const linea of sinMedir) console.error(`  - ${linea}`);
  }

  if (escribirBaseline) {
    await writeFile(BASELINE, `${JSON.stringify(resumen, null, 2)}\n`, 'utf8');
    console.log(`\nlayout: baseline written to ${BASELINE}`);
    return;
  }

  const base = JSON.parse(await readFile(BASELINE, 'utf8'));
  const { peores, mejores } = comparar(resumen, base);

  if (mejores.length > 0) {
    console.error('\nlayout: these numbers improved and the baseline still allows the old value:');
    for (const linea of mejores) console.error(`  - ${linea}`);
    console.error('  run `pnpm qa:layout:update` so the gain is the new floor.');
  }
  if (peores.length > 0) {
    console.error('\nlayout: the rendered layout got worse:');
    for (const linea of peores) console.error(`  - ${linea}`);
  }
  if (peores.length > 0 || mejores.length > 0 || sinMedir.length > 0) process.exit(1);
  console.log('\nlayout: every measured budget holds.');
}

await principal();
