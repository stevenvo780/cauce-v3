#!/usr/bin/env node
/*
 * MEDIR LA GEOMETRÍA DE LA TERMINAL EN UN CHROME DE VERDAD.
 *
 * 🔴 Por qué existe, y por qué no puede ser una prueba de vitest. Los tres defectos que este
 * arnés vigila son de MAQUETACIÓN, y jsdom no tiene maquetación: `getBoundingClientRect()`
 * devuelve ceros, `proposeDimensions()` de xterm no devuelve nada y `fit()` no mueve un píxel. Una
 * prueba de vitest sobre esto daría verde dijera lo que dijera el código —y eso ya pasó: la suite
 * entera de la consola estaba en verde mientras la PTY nacía de 20 filas fijas—.
 *
 * Lo que mide, con la vista REAL y con una sesión PTY REALMENTE abierta (el banco de mocks de
 * `apps/console/src/mocks/terminal-demo.ts` es lo que permite llegar hasta ahí sin backend):
 *
 *   1. Que la página CABE en la ventana. Medido antes del arreglo a 1920x1080: el documento medía
 *      1.188 px de alto en una pantalla de 1.080, o sea que el borde de abajo del terminal quedaba
 *      debajo del pliegue. La causa era `height: clamp(430px, calc(100dvh - 190px), 1180px)`: ese
 *      190 pretendía ser todo lo que hay encima de la caja y son 228.
 *   2. Cuánto ancho de pantalla llega al terminal. Medido antes: `main` se quedaba en los 1.500 px
 *      de anchura de LECTURA de la consola, el hueco del terminal medía 804 px de una pantalla de
 *      1.920 —el 41,9 %— y la PTY salía de 99 columnas.
 *   3. Que el tamaño SE PROPAGA: que cambiar la ventana cambia las columnas y filas que se le
 *      declaran al agente por el socket. Es lo único que acredita que el `ResizeObserver`, el
 *      `fit()` y la trama `resize` están enganchados de punta a punta.
 *   4. Cuánto ALTO de pantalla llega al terminal, y cuántas FILAS quedan. Medido antes del arreglo
 *      del 2026-08-24, con esta misma rama: a 1920x1080 el hueco del terminal medía 599 px de
 *      1.080 —el 55,5 %— y a 1280x720, 169 px: **9 filas**, que no alcanzan para leer una TUI. El
 *      alto se iba en cromo que no cambia mientras mirás una terminal (el título de la página, los
 *      seis contadores, el pie de doctrina, la identidad del alias repetida bajo su propia
 *      pestaña). El reparto vertical completo se imprime debajo de cada medida para que el
 *      siguiente que lo mire no tenga que volver a instrumentar la página.
 *
 *   Uso:
 *     node ops/console-legibilidad/medir-terminal.mjs              # informe, siempre sale 0
 *     node ops/console-legibilidad/medir-terminal.mjs --exigir     # sale 1 si algo está mal
 *     BASE=http://127.0.0.1:4188 node ops/console-legibilidad/medir-terminal.mjs
 *
 * Sin `BASE` levanta él mismo `vite` en modo mock y lo apaga al terminar. Necesita Chrome
 * (`/usr/bin/google-chrome`); no necesita servidor X, ni puppeteer, ni backend.
 *
 * Lo que este arnés NO mide: la CSP. El servidor de desarrollo no manda la cabecera, así que las
 * violaciones de `style-src` se cuentan aparte, sobre un `dist` servido con
 * `ops/console-legibilidad/servir-con-csp.mjs`.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp, launchChrome, Page } from './cdp.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..', '..');
const EXIGIR = process.argv.includes('--exigir');

/* Umbrales. Salen de lo MEDIDO después del arreglo, con holgura para el ruido de un píxel. */
const MINIMO_ANCHO_UTIL = 0.5; // el hueco del terminal, sobre el ancho de la ventana
/*
 * El alto útil es el encargo, con número: «a 1920x1080 el terminal usa al menos el 60 % del alto
 * de la ventana». No se pide a 1280x720 porque ahí la barra superior de la consola (58 px fijos)
 * pesa el doble en proporción; lo que se exige en la ventana chica son FILAS, que es lo que de
 * verdad decide si una TUI se puede leer.
 */
const MINIMO_ALTO_UTIL = 0.6;
/*
 * 18 filas. Una TUI de agente pinta su cabecera, su caja de entrada y su pie: por debajo de ~18
 * filas no queda conversación a la vista y la ventana sirve para saber que el agente existe, no
 * para leer lo que está haciendo. Medido antes del arreglo: 9.
 */
const MINIMO_FILAS = 18;
const ANCHA = { w: 1920, h: 1080 };
const ESTRECHA = { w: 1280, h: 720 };

const dormir = (ms) => new Promise((seguir) => setTimeout(seguir, ms));

/**
 * Un puerto LIBRE, pedido al núcleo, y `--strictPort` para que vite no se corra solo a otro.
 *
 * 🔴 **Esto no es higiene: es la diferencia entre medir tu árbol y medir el de otro.** El puerto
 * estaba escrito a mano (4188) y el arranque se daba por bueno en cuanto ALGO contestaba ahí. El
 * 2026-08-24 había un `vite` de otro worktree —`/workspace/wt-terminal`, de otro agente, levantado
 * hacía una hora— ocupando ese puerto: el arnés lo adoptó sin decir palabra y devolvió, dos veces
 * seguidas y hasta el píxel, las medidas de una rama ajena. Un cambio real en esta rama salía
 * «sin efecto», que es la forma más cara de equivocarse: te hace desandar un arreglo que estaba
 * bien. Con puerto efímero no hay a quién adoptar, y si aun así el puerto se ocupara,
 * `--strictPort` hace que vite muera en vez de mudarse.
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
 * Abre la vista, engancha una sesión PTY y deja la página lista para medir.
 *
 * Se pide primero el modo **TUI en solo lectura**, que es para lo que esta vista existe («mirar la
 * pantalla que el agente ya tiene pintada») y el que usa Steven; su barra de sesión lleva una
 * pastilla más que la de una shell nueva, así que medir sólo la shell mide una barra más estrecha
 * que la real. Abre de un clic y sin diálogo, a propósito: no se está creando una shell.
 *
 * Si el destino no publica el modo harness, el botón «TUI» está deshabilitado y se cae al camino de
 * la shell, con su diálogo de motivo. Los dos caminos acaban en un `.pty-mount`, que es lo que se
 * mide. (Hasta el 2026-08-24 SIEMPRE se caía al segundo: el banco publicaba el modo con otro
 * nombre y el botón «TUI» nunca llegaba a estar habilitado. Ver `mocks/terminal-demo.ts`.)
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
