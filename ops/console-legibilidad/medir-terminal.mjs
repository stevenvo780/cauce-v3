#!/usr/bin/env node
/*
 * Medición de geometría y maquetación de la terminal en Chrome headless.
 *
 * Evalúa:
 *   1. Que la página se ajuste a la ventana sin desbordamiento.
 *   2. Proporción de ancho de pantalla disponible para el terminal.
 *   3. Propagación del cambio de tamaño (resize events y filas/columnas PTY).
 *   4. Proporción de alto de pantalla y número mínimo de filas disponibles.
 *
 * Uso:
 *   node ops/console-legibilidad/medir-terminal.mjs              # informe
 *   node ops/console-legibilidad/medir-terminal.mjs --exigir     # falla con código 1 si incumple
 *   BASE=http://127.0.0.1:4188 node ops/console-legibilidad/medir-terminal.mjs
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp, launchChrome, Page } from './cdp.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..', '..');
const EXIGIR = process.argv.includes('--exigir');

/* Umbrales de maquetación y legibilidad. */
const MINIMO_ANCHO_UTIL = 0.5; // proporción mínima de ancho
const MINIMO_ALTO_UTIL = 0.6;  // proporción mínima de alto útil en 1920x1080
const MINIMO_FILAS = 18;       // mínimo de filas requeridas para legibilidad
const ANCHA = { w: 1920, h: 1080 };
const ESTRECHA = { w: 1280, h: 720 };

const dormir = (ms) => new Promise((seguir) => setTimeout(seguir, ms));

/**
 * Obtiene un puerto libre efímero para arrancar Vite con `--strictPort`.
 */
async function puertoLibre() {
  const { createServer } = await import('node:net');
  return new Promise((ok, mal) => {
    const s = createServer();
    s.on('error', mal);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

async function levantarVite() {
  const puerto = await puertoLibre();
  const base = `http://127.0.0.1:${puerto}`;
  const hijo = spawn(resolve(RAIZ, 'node_modules/.bin/vite'), ['--host', '127.0.0.1', '--port', String(puerto), '--strictPort'], {
    cwd: resolve(RAIZ, 'apps/console'),
    env: { ...process.env, NODE_ENV: 'development', VITE_USE_MOCKS: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let muerto = false;
  hijo.on('exit', () => { muerto = true; });
  const limite = Date.now() + 30_000;
  while (Date.now() < limite) {
    if (muerto) throw new Error(`vite murió al arrancar en ${base} (¿puerto ocupado?)`);
    try {
      const r = await fetch(`${base}/`);
      if (r.ok) {
        console.log(`vite propio en ${base} · árbol ${resolve(RAIZ, 'apps/console')}`);
        return { hijo, base };
      }
    } catch { /* todavía no */ }
    await dormir(200);
  }
  hijo.kill('SIGKILL');
  throw new Error('vite no levantó en 30 s');
}

/**
 * Abre la vista, conecta una sesión PTY y deja la página lista para medir.
 */
async function abrirSesion(page, base) {
  await page.goto(`${base}/terminal`, 3000);
  await page.eval(`() => {
    const b = [...document.querySelectorAll('button')].find((x) => /kant/i.test(x.textContent || ''));
    if (b) b.click();
  }`);
  await dormir(1200);
  for (let intento = 0; intento < 3; intento += 1) {
    await page.eval(`() => {
      const b = [...document.querySelectorAll('button')]
        .filter((x) => !x.disabled)
        .find((x) => /^TUI$/.test((x.textContent || '').trim()));
      if (b) b.click();
    }`);
    await dormir(900);
    if (await page.eval(`() => !!document.querySelector('.pty-mount')`)) return true;
  }
  for (let intento = 0; intento < 6; intento += 1) {
    await page.eval(`() => {
      const ta = document.getElementById('pty-dialog-reason');
      if (ta) {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
          .call(ta, 'medicion de geometria del panel');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const dlg = document.querySelector('.pty-dialog-actions');
      const vivos = [...document.querySelectorAll('button')].filter((x) => !x.disabled);
      const boton = dlg
        ? [...dlg.querySelectorAll('button')].find((x) => !x.disabled && /abrir sesi/i.test(x.textContent || ''))
        : vivos.find((x) => /^PTY$/.test((x.textContent || '').trim()));
      if (boton) boton.click();
    }`);
    await dormir(900);
    if (await page.eval(`() => !!document.querySelector('.pty-mount')`)) return true;
  }
  return false;
}

/*
 * El reparto vertical, de arriba a abajo. No es decorativo: cuando el terminal se queda corto, el
 * alto se lo llevó ALGO, y sin esta lista hay que volver a instrumentar la página a mano para
 * saber qué. Se imprime siempre, salga verde o rojo.
 */
const REPARTO = [
  '.topbar', '.page-header', '.terminal-overview', '.terminal-relay-notice', '.terminal-degraded',
  '.ultimate-terminal-shell', '.terminal-session-tabs', '.terminal-grid-container',
  '.terminal-session-head', '.terminal-channel-state', '.terminal-connection-bar',
  '.pty-session-bar', '.pty-status', '.pty-estrecho', '.pty-mount', '.terminal-doctrine',
];

const leer = `() => {
  const caja = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top) };
  };
  const reparto = {};
  for (const sel of ${JSON.stringify(REPARTO)}) reparto[sel] = caja(sel);
  const falsa = globalThis.__ptyFalsa;
  return {
    ventana: { w: innerWidth, h: innerHeight },
    documento: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
    hueco: caja('.pty-mount'),
    reparto,
    geometria: falsa ? falsa.ultimaGeometria : null,
    estilosInyectados: document.querySelectorAll('.pty-host style').length,
  };
}`;

const fallos = [];
const { hijo, base } = process.env.BASE ? { hijo: null, base: process.env.BASE } : await levantarVite();
/* Efímero por el mismo motivo que el de vite: con el puerto escrito a mano se podía atacar el
   Chrome que otro agente dejó abierto, y medir su pestaña en vez de la nuestra. */
const PUERTO_CDP = await puertoLibre();
const chrome = await launchChrome({ port: PUERTO_CDP });
const cdp = await Cdp.connect(chrome.wsUrl);
try {
  const page = await Page.create(cdp, PUERTO_CDP);
  await page.setViewport(ANCHA.w, ANCHA.h);
  if (!await abrirSesion(page, base)) throw new Error('no se llegó a montar una PTY: el banco de mocks no está enchufado');
  await dormir(1500);

  const ancha = await page.eval(leer);
  await page.setViewport(ESTRECHA.w, ESTRECHA.h);
  await dormir(1800);
  const estrecha = await page.eval(leer);

  for (const [nombre, m] of [['1920x1080', ancha], ['1280x720', estrecha]]) {
    const util = m.hueco ? m.hueco.w / m.ventana.w : 0;
    const utilAlto = m.hueco ? m.hueco.h / m.ventana.h : 0;
    console.log(`\n${nombre}  documento=${m.documento.w}x${m.documento.h}  hueco=${m.hueco?.w}x${m.hueco?.h}`
      + `  PTY=${m.geometria?.cols}x${m.geometria?.rows}`
      + `  ancho util=${(util * 100).toFixed(1)}%  alto util=${(utilAlto * 100).toFixed(1)}%`
      + `  <style> inyectados=${m.estilosInyectados}`);
    console.log('  reparto vertical (y · alto):');
    for (const sel of REPARTO) {
      const c = m.reparto[sel];
      console.log(c
        ? `    ${sel.padEnd(28)} y=${String(c.y).padStart(5)}  ${String(c.h).padStart(4)} px`
        : `    ${sel.padEnd(28)} (no está en pantalla)`);
    }

    if (m.documento.h > m.ventana.h) {
      fallos.push(`${nombre}: la página no cabe en la ventana (documento ${m.documento.h} px, ventana ${m.ventana.h} px)`);
    }
    if (util < MINIMO_ANCHO_UTIL) {
      fallos.push(`${nombre}: al terminal sólo le llega el ${(util * 100).toFixed(1)} % del ancho de la ventana`);
    }
    /*
     * El encargo, con número. Sólo en la ventana grande: ver `MINIMO_ALTO_UTIL`.
     */
    if (nombre === '1920x1080' && utilAlto < MINIMO_ALTO_UTIL) {
      fallos.push(`${nombre}: al terminal sólo le llega el ${(utilAlto * 100).toFixed(1)} % del alto de la ventana`
        + ` (${m.hueco?.h} px de ${m.ventana.h}); el mínimo es ${(MINIMO_ALTO_UTIL * 100).toFixed(0)} %`);
    }
    if (m.geometria && m.geometria.rows < MINIMO_FILAS) {
      fallos.push(`${nombre}: la PTY se queda en ${m.geometria.rows} filas; por debajo de ${MINIMO_FILAS} no hay TUI que leer`);
    }
    if (m.estilosInyectados > 0) {
      fallos.push(`${nombre}: xterm dejó ${m.estilosInyectados} <style> en el DOM; con la CSP de producción son otras tantas violaciones`);
    }
    if (!m.geometria) fallos.push(`${nombre}: al agente no se le declaró ninguna geometría`);
  }

  /*
   * El contrato de propagación. Es la mitad que puede dar ROJO de verdad: si el observador de
   * tamaño se desengancha, si `fit()` deja de correr o si la trama `resize` se pierde, las dos
   * medidas salen idénticas y esto lo dice. Antes del arreglo el defecto no era éste —la trama sí
   * viajaba— sino que la caja que se mide no crecía nunca; el síntoma habría sido el mismo.
   */
  const a = ancha.geometria;
  const b = estrecha.geometria;
  if (a && b && a.cols === b.cols && a.rows === b.rows) {
    fallos.push(`el tamaño NO se propaga: la PTY declara ${a.cols}x${a.rows} en las dos ventanas`);
  }
} finally {
  cdp.close();
  chrome.child.kill('SIGKILL');
  hijo?.kill('SIGKILL');
}

if (fallos.length === 0) {
  console.log('\nOK: la página cabe, el terminal usa la pantalla a lo ancho y a lo alto, quedan filas'
    + ' suficientes para leer una TUI y el tamaño se propaga.');
  process.exit(0);
}
console.log(`\n${fallos.length} problema(s):`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(EXIGIR ? 1 : 0);
