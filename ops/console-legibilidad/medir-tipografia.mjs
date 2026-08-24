#!/usr/bin/env node
/*
 * MEDIR EL SUELO TIPOGRÁFICO Y LOS DESBORDES EN CHROME DE VERDAD, A 1920×1080.
 *
 * Hermano de `medir.mjs`, que mide CONTRASTE. Éste mide TAMAÑO: cuenta los elementos de texto hoja
 * dentro de `main` cuyo `font-size` calculado queda por debajo del suelo (12,5 px), y de paso los
 * desbordes horizontales, los paneles que no caben y el texto recortado con elipsis.
 *
 * Por qué hace falta un navegador y no alcanza vitest: **jsdom no calcula layout**. MEDIDO, no
 * supuesto — una caja de 100 px con un hijo de 5000 px informa `scrollWidth: 0` y `clientWidth: 0`,
 * o sea que `scrollWidth > clientWidth` es falso SIEMPRE y una prueba de desborde escrita ahí no
 * puede dar rojo. Queda como aserto ejecutable en `apps/console/src/styles.tipografia.test.ts`.
 * Lo que jsdom SÍ resuelve es la cascada (devuelve la declaración ganadora sin resolver), y eso lo
 * aprovecha `styles.tipografia-montada.test.tsx`; el layout, sólo acá.
 *
 *   Uso:
 *     node ops/console-legibilidad/medir-tipografia.mjs
 *     node ops/console-legibilidad/medir-tipografia.mjs --ancho=1280 --alto=900
 *     node ops/console-legibilidad/medir-tipografia.mjs --capturas=/tmp/shots
 *     TEMA=oscuro INFORME=/tmp/informe.json node ops/console-legibilidad/medir-tipografia.mjs
 *     BASE=http://127.0.0.1:4173 node ops/console-legibilidad/medir-tipografia.mjs
 *
 * Sin `BASE`, levanta él mismo `vite` en modo mock y lo apaga al terminar. Necesita Chrome
 * (`/usr/bin/google-chrome`); NO necesita servidor X.
 *
 * Arranca por su propio CONTROL NEGATIVO: se inyectan tres defectos de verdad en la página y se
 * exige que los encuentre los tres antes de medir nada. Una sonda que se quedó ciega da el mismo
 * cero que una pantalla perfecta, y ése es el error más caro que puede cometer un guardia.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, Cdp, Page } from './cdp.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const CONSOLA = resolve(AQUI, '../../apps/console');
const args = process.argv.slice(2);
const opcion = (n, d) => { const f = args.find((a) => a.startsWith(`--${n}=`)); return f ? f.slice(n.length + 3) : d; };
const SUELO = Number(opcion('suelo', '12.5'));
const CAPTURAS = opcion('capturas', '');
const RUTAS = opcion('rutas', '/,live,accounts,messages,queues,observability,config,terminal').split(',');
const ANCHO = Number(opcion('ancho', '1920'));
const ALTO = Number(opcion('alto', '1080'));

const SONDA = `function () {
  const SUELO = ${SUELO};
  const vis = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // Texto PROPIO del elemento: sólo nodos de texto hijos directos. Eso es «hoja»: si el texto lo
  // pone un hijo, el tamaño que manda es el del hijo y contar al padre lo duplicaría.
  const propio = (el) => {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.trim();
  };
  const cls = (el) => (typeof el.className === 'string' ? el.className : '').trim().split(/\\s+/).filter(Boolean).slice(0, 3).join('.');

  const main = document.querySelector('main') || document.body;
  const chicos = [];
  const histo = {};
  for (const el of main.querySelectorAll('*')) {
    if (el.classList && el.classList.contains('sr-only')) continue;
    const t = propio(el);
    if (!t) continue;
    if (!vis(el)) continue;
    const px = Math.round(parseFloat(getComputedStyle(el).fontSize) * 100) / 100;
    if (px + 0.001 < SUELO) {
      histo[px] = (histo[px] || 0) + 1;
      chicos.push({ tag: el.tagName.toLowerCase(), cls: cls(el), px, text: t.slice(0, 40) });
    }
  }

  // --- desbordes horizontales ---
  const de = document.documentElement;
  const doc = { clientWidth: de.clientWidth, scrollWidth: de.scrollWidth, desborda: de.scrollWidth > de.clientWidth + 1 };
  const vw = de.clientWidth;
  const enScroller = (el) => {
    let n = el.parentElement;
    while (n && n !== document.body) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true;
      n = n.parentElement;
    }
    return false;
  };
  const paneles = [];
  for (const el of main.querySelectorAll('*')) {
    if (!vis(el)) continue;
    if (el.classList && el.classList.contains('sr-only')) continue;
    const ox = getComputedStyle(el).overflowX;
    if (ox === 'auto' || ox === 'scroll') continue; // desbordar es su oficio
    const r = el.getBoundingClientRect();
    /*
     * El desborde se juzga por los HIJOS REALES, no por \`scrollWidth\`.
     *
     * MEDIDO: \`.metric\` daba 368 en 344 en cuatro vistas, y no había nada que no cupiera. Los 24 px
     * eran \`.metric::after\`, un círculo decorativo puesto a \`right: -24px\` a propósito y recortado
     * por el \`overflow: hidden\` del propio panel. \`scrollWidth\` cuenta los pseudo-elementos; el
     * operador no los lee. Contarlos daba 19 desbordes falsos que tapaban los 2 de verdad.
     */
    let hijoQueSeSale = null;
    if (el.scrollWidth > el.clientWidth + 1 && !enScroller(el)) {
      const caja = el.getBoundingClientRect();
      const cs2 = getComputedStyle(el);
      const dcha = caja.right - parseFloat(cs2.paddingRight || 0) - parseFloat(cs2.borderRightWidth || 0);
      for (const h of el.children) {
        if (!vis(h)) continue;
        if (getComputedStyle(h).position === 'absolute') continue;
        const rh = h.getBoundingClientRect();
        if (rh.right > dcha + 1) { hijoQueSeSale = { tag: h.tagName.toLowerCase(), cls: cls(h), fuera: Math.round(rh.right - dcha) }; break; }
      }
    }
    if (hijoQueSeSale) {
      paneles.push({ tag: el.tagName.toLowerCase(), cls: cls(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, hijo: hijoQueSeSale });
    }
    if (r.right > vw + 1 && !enScroller(el)) {
      paneles.push({ tag: el.tagName.toLowerCase(), cls: cls(el), fuera: Math.round(r.right - vw) });
    }
  }
  // texto recortado con elipsis: el elemento es inalcanzable aunque el panel quepa
  const truncado = [];
  for (const el of main.querySelectorAll('*')) {
    if (!vis(el)) continue;
    if (el.classList && el.classList.contains('sr-only')) continue;
    const cs = getComputedStyle(el);
    if (cs.textOverflow !== 'ellipsis') continue;
    if (!propio(el)) continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    truncado.push({ tag: el.tagName.toLowerCase(), cls: cls(el), text: propio(el).slice(0, 40), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
  }
  const porClase = {};
  for (const c of chicos) { const k = c.tag + (c.cls ? '.' + c.cls : '') + ' @' + c.px; porClase[k] = (porClase[k] || 0) + 1; }
  return { chicos, histo, porClase, doc, paneles: paneles.slice(0, 40), nPaneles: paneles.length, truncado: truncado.slice(0, 20), nTrunc: truncado.length };
}`;

async function levantarVite() {
  const puerto = 4181;
  const hijo = spawn(`${CONSOLA}/node_modules/.bin/vite`, ['--host', '127.0.0.1', '--port', String(puerto), '--strictPort'],
    { cwd: CONSOLA, env: { ...process.env, VITE_USE_MOCKS: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let salida = '';
  hijo.stdout.on('data', (d) => { salida += d; }); hijo.stderr.on('data', (d) => { salida += d; });
  const limite = Date.now() + 60000;
  while (Date.now() < limite) {
    try { const r = await fetch(`http://127.0.0.1:${puerto}/`); if (r.ok) return { base: `http://127.0.0.1:${puerto}`, apagar: () => hijo.kill('SIGKILL') }; } catch { /* aún no */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  hijo.kill('SIGKILL'); throw new Error(`vite no levantó:\n${salida.slice(-1500)}`);
}

const srv = process.env.BASE ? null : await levantarVite();
const BASE = process.env.BASE || srv.base;
if (CAPTURAS) mkdirSync(CAPTURAS, { recursive: true });
const { child, port } = await launchChrome({ port: Number(process.env.PUERTO_CDP || 9345) });
const cdp = await Cdp.connect((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
const pagina = await Page.create(cdp, port);
await pagina.setColorScheme(process.env.TEMA === 'oscuro' ? 'dark' : 'light');
await pagina.setViewport(ANCHO, ALTO, false);

/*
 * CONTROL NEGATIVO DE LA SONDA, y corre ANTES que la medición.
 *
 * Acabo de enseñarle a la sonda a NO contar los pseudo-elementos decorativos, y ése es justo el
 * cambio que puede dejarla ciega: una sonda que ya no denuncia nada da el mismo verde que una
 * pantalla perfecta. Así que se le inyectan a la página tres defectos de verdad —un hijo que se
 * sale de su panel, un texto recortado con elipsis y una letra por debajo del suelo— y se exige que
 * los encuentre los tres. Si no los encuentra, la corrida se aborta en vez de publicar un cero.
 */
async function autoprueba() {
  await pagina.goto(BASE + '/', 2200);
  const r = await pagina.eval(`function () {
    const main = document.querySelector('main') || document.body;
    const panel = document.createElement('div');
    panel.setAttribute('style', 'width: 120px; border: 1px solid red;');
    const hijo = document.createElement('div');
    hijo.setAttribute('style', 'width: 400px; font-size: 9px;');
    hijo.textContent = 'este hijo se sale de su panel y ademas es letra chica';
    panel.appendChild(hijo);
    const recorte = document.createElement('p');
    recorte.setAttribute('style', 'width: 40px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;');
    recorte.textContent = 'texto que no cabe y se corta con puntos suspensivos';
    main.appendChild(panel); main.appendChild(recorte);
    return true;
  }`);
  if (!r) throw new Error('autoprueba: no se pudieron inyectar los defectos');
  const m = await pagina.eval(SONDA);
  const fallos = [];
  if (!m.nPaneles) fallos.push('la sonda NO vio un hijo de 400px saliendose de un panel de 120px');
  if (!m.nTrunc) fallos.push('la sonda NO vio un texto recortado con elipsis');
  if (!m.chicos.some((c) => c.px === 9)) fallos.push('la sonda NO vio una letra de 9px');
  if (fallos.length) throw new Error(`CONTROL NEGATIVO FALLIDO — la sonda esta ciega:\n  ${fallos.join('\n  ')}`);
  console.log(`control negativo: la sonda ve los 3 defectos inyectados (paneles=${m.nPaneles} trunc=${m.nTrunc} chicos=${m.chicos.length})\n`);
}

const informe = {};
let totalChicos = 0; let totalDesbordes = 0;
try {
  await autoprueba();
  for (const ruta of RUTAS) {
    await pagina.goto(BASE + (ruta === '/' ? '/' : `/${ruta}`), 2200);
    const r = await pagina.eval(SONDA);
    if (CAPTURAS) await pagina.screenshot(`${CAPTURAS}/${ruta === '/' ? 'portada' : ruta}.png`, true);
    informe[ruta] = r;
    totalChicos += r.chicos.length;
    const desb = (r.doc.desborda ? 1 : 0) + r.nPaneles + r.nTrunc;
    totalDesbordes += desb;
    const min = r.chicos.length ? Math.min(...r.chicos.map((c) => c.px)) : null;
    console.log(
      `${ruta.padEnd(16)} <${SUELO}px: ${String(r.chicos.length).padStart(4)}`
      + `  min=${String(min ?? '-').padStart(6)}`
      + `  doc=${r.doc.desborda ? `DESBORDA ${r.doc.scrollWidth}>${r.doc.clientWidth}` : 'ok'.padEnd(8)}`
      + `  panelesX=${String(r.nPaneles).padStart(3)}  trunc=${String(r.nTrunc).padStart(3)}`,
    );
  }
} finally { cdp.close(); child.kill('SIGKILL'); srv?.apagar(); }

if (process.env.INFORME) writeFileSync(process.env.INFORME, JSON.stringify(informe, null, 2));
console.log(`\nTOTAL por debajo de ${SUELO}px: ${totalChicos}   ·   señales de desborde: ${totalDesbordes}`);
