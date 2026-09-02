#!/usr/bin/env node
/**
 * Layout ratchet for the console, measured in a real browser.
 *
 * The unit tests run in jsdom, which applies no CSS and computes no geometry, and the CSS guards
 * read the stylesheet as TEXT: neither can see the rendered box. This gate drives Chromium over
 * every declared route at every breakpoint and compares real numbers against a recorded baseline.
 * Semantics match scripts/calidad.mjs: the numbers may only improve, in both directions.
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSOLE_ROOT = resolve(HERE, '..');
const BASELINE = resolve(HERE, 'layout-baseline.json');
const VITE_ENTRY = resolve(CONSOLE_ROOT, 'node_modules/vite/bin/vite.js');
const PORT = 4188;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;

/* Opened through the deep link the console already supports, never by clicking the first row: the
   fleet table sorts by state, so the row under the cursor —and the height it measures— changes. */
const ALIAS_MEDIDO = 'Steven/jarvis';

/* The bare /messages shows the roster and no thread: the primary object of that view exists only
   with a conversation open, so it is measured through the deep link the roster itself navigates to. */
const HILO = `/messages/${ALIAS_MEDIDO}`;

const ROUTES = ['/', '/live', '/accounts', '/messages', HILO, '/queues', '/observability', '/config', '/terminal', '/ayuda'];

/** The narrow widths are the shipped breakpoints; 1440 is the laptop, 1920 and 2560 the desks. */
const VIEWPORTS = [360, 760, 1100, 1440, 1920, 2560];
const ALTO = 1000;

/** Noise floor per budget. Scroll depth is a ratio, so a pixel tolerance there would wave through
    a view that grew from one screen to three. */
const TOLERANCIA = {
  huecoMaximo: 2,
  desbordeMaximo: 0,
  recorteMaximo: 8,
  recorteSinTeclado: 8,
  enlacesSinNombre: 0,
  solapesDeRotulo: 0,
  portadoresBajos: 0,
  pantallasMaximas: 0.1,
};

/** Same ratchet, applied to each route instead of the viewport's worst case. The tops are looser
    than a pixel budget on purpose: the mock clock ages the relative-time column between runs. */
const TOLERANCIA_RUTA = {
  pantallas: 0.2,
  foldDesaprovechado: 8,
  objetoPrincipalTop: 64,
  objetoPrincipalBajoElPliegue: 0,
};

/** Drawer states, measured apart from the plain route: the fleet table is only clipped once the
    drawer takes its share of the width, and Perfil is the tab that takes the most. */
const CAJON = '/live#cajon';
const PERFIL = '/live#perfil';

const SIN_MOVIMIENTO = '*,*::before,*::after{animation:none!important;transition:none!important}';

const escribirBaseline = process.argv.includes('--update');

function esperar(ms) {
  return new Promise((cumplir) => setTimeout(cumplir, ms));
}

async function esperarServidor(salida, intentos = 60) {
  for (let i = 0; i < intentos; i += 1) {
    try {
      const respuesta = await fetch(ORIGIN);
      if (respuesta.ok) return;
    } catch { /* el servidor todavía no escucha */ }
    await esperar(500);
  }
  // Swallowing the server's own output turns "it never started" into a bare timeout on the first
  // navigation, which reads like a broken page instead of a missing server.
  throw new Error(`the console did not answer at ${ORIGIN}\n${salida() || '(the dev server printed nothing)'}`);
}

/** Runs inside the page. Returns raw geometry only: every judgement is made on this side, so the
    failure message can name the budget that broke. */
function medirEnLaPagina() {
  const raiz = document.documentElement;
  const main = document.querySelector('main');
  window.scrollTo(0, 0);
  if (main) main.scrollTop = 0;
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
  // Hidden content in a box the keyboard cannot even reach. A `div` with `overflow-x:auto` takes no
  // focus, so the arrow keys never get to it: what it cuts is lost to anyone without a pointer.
  let recorteSinTeclado = 0;
  let recorteSinTecladoSelector = '';
  for (const nodo of document.querySelectorAll('*')) {
    if (nodo === raiz || nodo === document.body) continue;
    const desbordeX = window.getComputedStyle(nodo).overflowX;
    if (desbordeX !== 'auto' && desbordeX !== 'scroll') continue;
    const oculto = Math.round(nodo.scrollWidth - nodo.clientWidth);
    if (oculto > recorte) {
      recorte = oculto;
      recorteSelector = selectorDe(nodo);
    }
    // A strip of tabs or buttons is reached through its own children —moving the focus scrolls it—
    // so only a box with nothing focusable inside actually strands what it cuts.
    const conFoco = nodo.querySelector(
      'button:not([disabled]), summary, [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (nodo.tabIndex < 0 && !conFoco && oculto > recorteSinTeclado) {
      recorteSinTeclado = oculto;
      recorteSinTecladoSelector = selectorDe(nodo);
    }
  }

  // The dead band BELOW the content, the one `hueco` never saw. A collapsed `details` still reports
  // a box for its hidden content, so only what is actually painted counts towards the bottom.
  let fondo = 0;
  const pintado = (nodo) => !nodo.checkVisibility
    || nodo.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true });
  for (const nodo of (main ? main.querySelectorAll('*') : [])) {
    if (!pintado(nodo)) continue;
    const r = nodo.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.bottom > fondo) fondo = r.bottom;
  }
  const principal = document.querySelector('[data-objeto-principal]');
  const cajaPrincipal = caja(principal);

  return {
    desborde: Math.round(raiz.scrollWidth - ancho),
    foldDesaprovechado: Math.max(0, Math.round(window.innerHeight - fondo)),
    objetoPrincipalTop: cajaPrincipal ? Math.round(cajaPrincipal.top) : null,
    objetoPrincipalBajoElPliegue: cajaPrincipal && cajaPrincipal.top >= window.innerHeight ? 1 : 0,
    hueco: Math.max(0, hueco),
    recorte,
    recorteSelector,
    recorteSinTeclado,
    recorteSinTecladoSelector,
    anchoMain: cajaMain ? Math.round(cajaMain.width) : 0,
    altoContenido: main ? Math.round(main.scrollHeight) : 0,
    pantallas: main ? Number((main.scrollHeight / window.innerHeight).toFixed(2)) : 0,
    enlacesSinNombre: nombres.filter((nombre) => nombre === '').length,
    enlacesTotales: enlaces.length,
    solapesDeRotulo: solapes,
    portadoresBajos: 0,
  };
}

/** Drives the two clicked states of /live. A state that cannot be reached is recorded and the run
    continues: losing one state must not cost the other five viewports. */
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

  const abrir = (pestana) => async () => {
    await pagina.goto(`${ORIGIN}/live?agente=${encodeURIComponent(ALIAS_MEDIDO)}&pestana=${pestana}`, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await pagina.addStyleTag({ content: SIN_MOVIMIENTO });
    await pagina.locator('.agent-drawer').waitFor({ state: 'visible', timeout: 5000 });
  };
  const abierto = await medir(CAJON, abrir('ahora'));
  if (!abierto) {
    sinMedir.push(`${String(viewport)}px ${PERFIL}: not attempted, the drawer never opened`);
    return;
  }
  await medir(PERFIL, abrir('perfil'));
}

/**
 * `networkidle` costs a second per route here and can never settle on its own: the console polls on
 * a timer, so the gate would wait for a quiet network that this page never has. The layout is
 * settled once `main` is painted and the transitions are off.
 */
async function medirRuta(pagina, ruta) {
  await pagina.goto(ORIGIN + ruta, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await pagina.locator('main').waitFor({ state: 'visible', timeout: 15000 });
  await pagina.addStyleTag({ content: SIN_MOVIMIENTO });
  await pagina.waitForTimeout(700);
  return pagina.evaluate(medirEnLaPagina);
}

async function medirPortadores(pagina) {
  const summary = pagina.locator('details.live-fold > summary').filter({ hasText: 'Roles declarados' });
  // A collapsed ancestor renders its children unreachable; the click would time out and take the
  // whole viewport's remaining budgets down with it.
  await summary.evaluate((nodo) => {
    for (let padre = nodo.parentElement; padre; padre = padre.parentElement) {
      if (padre.tagName === 'DETAILS' && padre !== nodo.parentElement) padre.open = true;
    }
  });
  await summary.click();
  return pagina.locator('.rol-portador').evaluateAll((botones) => botones.filter((boton) => {
    const caja = boton.getBoundingClientRect();
    return caja.width > 0 && caja.height > 0 && (caja.width < 24 || caja.height < 24);
  }).length);
}

async function medirViewport(navegador, viewport) {
  const contexto = await navegador.newContext({ viewport: { width: viewport, height: ALTO } });
  const pagina = await contexto.newPage();
  const medidas = [];
  const sinMedir = [];
  try {
    for (const ruta of ROUTES) {
      const t0 = Date.now();
      const medida = { ruta, viewport, ...(await medirRuta(pagina, ruta)), portadoresBajos: 0 };
      if (ruta === '/live') medida.portadoresBajos = await medirPortadores(pagina);
      medidas.push(medida);
      process.stderr.write(`  ${String(viewport)}px ${ruta} ${String(Date.now() - t0)}ms\n`);
      if (ruta === '/live') await medirEstadosDeLive(pagina, viewport, medidas, sinMedir);
    }
  } finally {
    await contexto.close();
  }
  return { medidas, sinMedir };
}

async function medirTodo() {
  const navegador = await chromium.launch();
  try {
    const pasadas = [];
    for (const viewport of VIEWPORTS) {
      pasadas.push(await medirViewport(navegador, viewport));
    }
    return {
      medidas: pasadas.flatMap((pasada) => pasada.medidas),
      sinMedir: pasadas.flatMap((pasada) => pasada.sinMedir),
    };
  } finally {
    await navegador.close();
  }
}

/** Collapses the per-route measurements into the numbers the baseline tracks. Every budget is a
    worst case; `rutas` keeps the per-route numbers a per-route objective cannot be stated without. */
function resumir(medidas) {
  const porViewport = {};
  for (const viewport of VIEWPORTS) {
    const delViewport = medidas.filter((m) => m.viewport === viewport);
    const peorHueco = delViewport.reduce((peor, m) => (m.hueco > peor.hueco ? m : peor), delViewport[0]);
    const peorRecorte = delViewport.reduce((peor, m) => (m.recorte > peor.recorte ? m : peor), delViewport[0]);
    const peorSinTeclado = delViewport.reduce(
      (peor, m) => (m.recorteSinTeclado > peor.recorteSinTeclado ? m : peor), delViewport[0]);
    const peorPantallas = delViewport.reduce((peor, m) => (m.pantallas > peor.pantallas ? m : peor), delViewport[0]);
    porViewport[String(viewport)] = {
      huecoMaximo: peorHueco.hueco,
      huecoMaximoEn: peorHueco.ruta,
      desbordeMaximo: Math.max(...delViewport.map((m) => m.desborde)),
      recorteMaximo: peorRecorte.recorte,
      recorteMaximoEn: peorRecorte.ruta,
      recorteMaximoQue: peorRecorte.recorteSelector,
      recorteSinTeclado: peorSinTeclado.recorteSinTeclado,
      recorteSinTecladoEn: peorSinTeclado.ruta,
      recorteSinTecladoQue: peorSinTeclado.recorteSinTecladoSelector,
      enlacesSinNombre: Math.max(...delViewport.map((m) => m.enlacesSinNombre)),
      solapesDeRotulo: Math.max(...delViewport.map((m) => m.solapesDeRotulo)),
      portadoresBajos: Math.max(...delViewport.map((m) => m.portadoresBajos)),
      pantallasMaximas: peorPantallas.pantallas,
      pantallasMaximasEn: peorPantallas.ruta,
      rutas: Object.fromEntries(delViewport.map((m) => [m.ruta, {
        pantallas: m.pantallas,
        foldDesaprovechado: m.foldDesaprovechado,
        objetoPrincipalTop: m.objetoPrincipalTop,
        objetoPrincipalBajoElPliegue: m.objetoPrincipalBajoElPliegue,
      }])),
    };
  }
  return porViewport;
}

const CLAVES = Object.keys(TOLERANCIA);
const CLAVES_RUTA = Object.keys(TOLERANCIA_RUTA);

const DONDE = {
  huecoMaximo: (v) => v.huecoMaximoEn,
  pantallasMaximas: (v) => v.pantallasMaximasEn,
  recorteMaximo: (v) => `${v.recorteMaximoEn} ${v.recorteMaximoQue}`,
  recorteSinTeclado: (v) => `${v.recorteSinTecladoEn} ${v.recorteSinTecladoQue}`,
};

/** The v3.1 acceptance criteria, stated per route because a per-viewport worst case cannot express
    them. PENDIENTES lists what misses them today, with the value measured when it was recorded: an
    unrecorded miss fails, and so does an entry that now passes and must therefore be deleted. */
const OBJETIVOS = {
  pantallas: { rutas: ['/live', '/accounts', CAJON, PERFIL], viewports: [1440, 1920, 2560], tope: 2, margen: 0.2 },
  foldDesaprovechado: { rutas: ['/'], viewports: VIEWPORTS, tope: Math.round(ALTO * 0.4), margen: 8 },
  objetoPrincipalBajoElPliegue: {
    rutas: ['/live', HILO, '/terminal'], viewports: VIEWPORTS, tope: 0, margen: 0,
  },
};

const PENDIENTES = {
  '1440./live.pantallas': 2.66,
  '1440./live#cajon.pantallas': 2.66,
  '1920./live#cajon.pantallas': 2.29,
  '1440./live#perfil.pantallas': 2.66,
  '1440./accounts.pantallas': 3.66,
  '1920./accounts.pantallas': 3.39,
  '2560./accounts.pantallas': 3.34,
  '360./live.objetoPrincipalBajoElPliegue': 1,
  '760./live.objetoPrincipalBajoElPliegue': 1,
};

function revisarObjetivos(resumen) {
  const nuevos = [];
  const cumplidos = [];
  const vistos = new Set();
  for (const [clave, objetivo] of Object.entries(OBJETIVOS)) {
    for (const viewport of objetivo.viewports) {
      for (const ruta of objetivo.rutas) {
        const id = `${String(viewport)}.${ruta}.${clave}`;
        const medida = resumen[String(viewport)]?.rutas?.[ruta];
        if (!medida) {
          nuevos.push(`${id}: the route was not measured, so the objective went unchecked`);
          continue;
        }
        vistos.add(id);
        const valor = medida[clave];
        const pendiente = PENDIENTES[id];
        // Without a primary object the fold measure is 0 for want of anything to measure, which
        // would read as a pass: a named route that declares none misses the objective.
        if (clave.startsWith('objetoPrincipal') && medida.objetoPrincipalTop === null) {
          nuevos.push(`${id}: the route declares no [data-objeto-principal], so nothing meets the objective`);
          continue;
        }
        if (valor <= objetivo.tope) {
          if (pendiente !== undefined) {
            cumplidos.push(`${id}: ${String(valor)} meets the objective of ${String(objetivo.tope)}`);
          }
        } else if (pendiente === undefined) {
          nuevos.push(`${id}: ${String(valor)} against the v3.1 objective of ${String(objetivo.tope)}`);
        } else if (valor > pendiente + objetivo.margen) {
          nuevos.push(`${id}: ${String(valor)}, worse than the ${String(pendiente)} recorded as pending`);
        }
      }
    }
  }
  for (const id of Object.keys(PENDIENTES)) {
    if (!vistos.has(id)) nuevos.push(`${id}: recorded as pending, but no objective measures it`);
  }
  return { nuevos, cumplidos };
}

const PERMITE_REGRESION = new Set(process.argv
  .filter((argumento) => argumento.startsWith('--allow-regression='))
  .flatMap((argumento) => argumento.slice('--allow-regression='.length).split(',')));

/** `--update` used to blanket-write every viewport, so a regression on one budget rode in beside an
    improvement on another and became the new floor. Raising a recorded value now takes naming it. */
function filtrarRegresiones(resumen, base) {
  const rechazos = [];
  for (const viewport of Object.keys(resumen)) {
    const anterior = base[viewport];
    if (!anterior) continue;
    for (const clave of CLAVES) {
      const valor = resumen[viewport][clave];
      const tope = anterior[clave];
      if (typeof tope !== 'number' || typeof valor !== 'number' || valor <= tope) continue;
      const id = `${viewport}.${clave}`;
      if (PERMITE_REGRESION.has(id)) continue;
      resumen[viewport][clave] = tope;
      rechazos.push(`${id}: kept ${String(tope)} instead of ${String(valor)}; pass --allow-regression=${id} to raise it`);
    }
    // Per route the tolerance applies here too: refusing raises inside the noise band would print a
    // wall of refusals with nothing to act on, and the compare pass waves those through anyway.
    for (const [ruta, medida] of Object.entries(resumen[viewport].rutas)) {
      const grabada = anterior.rutas?.[ruta];
      for (const clave of CLAVES_RUTA) {
        const valor = medida[clave];
        const tope = grabada?.[clave];
        if (typeof tope !== 'number' || typeof valor !== 'number' || valor <= tope + TOLERANCIA_RUTA[clave]) continue;
        const id = `${viewport}.${ruta}.${clave}`;
        if (PERMITE_REGRESION.has(id)) continue;
        medida[clave] = tope;
        rechazos.push(`${id}: kept ${String(tope)} instead of ${String(valor)}; pass --allow-regression=${id} to raise it`);
      }
    }
  }
  return rechazos;
}

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
    compararRutas(viewport, actual[viewport].rutas, esperado.rutas, peores, mejores);
  }
  return { peores, mejores };
}

/** The worst case per viewport hides a route that got worse behind another that got better, and it
    cannot see a route that lost its primary object at all. Both are ratcheted here, route by route. */
function compararRutas(viewport, rutas, grabadas, peores, mejores) {
  for (const [ruta, medida] of Object.entries(rutas)) {
    const grabada = grabadas?.[ruta];
    if (!grabada) {
      peores.push(`${viewport}px ${ruta}: the baseline does not record this route`);
      continue;
    }
    for (const clave of CLAVES_RUTA) {
      const valor = medida[clave];
      const tope = grabada[clave];
      if (valor === null || tope === null) {
        if (valor === tope) continue;
        const linea = `${viewport}px ${ruta} ${clave}: ${String(valor)} against the recorded ${String(tope)}`;
        if (valor === null) peores.push(`${linea} — the route lost its [data-objeto-principal]`);
        else mejores.push(linea);
        continue;
      }
      const margen = TOLERANCIA_RUTA[clave];
      if (valor > tope + margen) {
        peores.push(`${viewport}px ${ruta} ${clave}: ${String(valor)} against a budget of ${String(tope)}`);
      } else if (valor < tope - margen) {
        mejores.push(`${viewport}px ${ruta} ${clave}: ${String(valor)}, better than the recorded ${String(tope)}`);
      }
    }
  }
}

function imprimirTabla(medidas) {
  const cabecera = ['ruta', 'ancho', 'main', 'hueco', 'fold libre', 'desborde', 'recorte', 'recortado en', 'sin teclado', 'inalcanzable en', 'pantallas', 'objeto top', 'bajo pliegue', 'sin nombre', 'solapes', 'portadores bajos'];
  const filas = medidas.map((m) => [
    m.ruta, m.viewport, m.anchoMain, m.hueco, m.foldDesaprovechado, m.desborde, m.recorte, m.recorteSelector || '-',
    m.recorteSinTeclado, m.recorteSinTecladoSelector || '-',
    m.pantallas,
    m.objetoPrincipalTop === null ? '-' : m.objetoPrincipalTop,
    m.objetoPrincipalTop === null ? '-' : m.objetoPrincipalBajoElPliegue,
    m.enlacesSinNombre, m.solapesDeRotulo, m.portadoresBajos,
  ].map(String));
  const anchos = cabecera.map((titulo, i) => Math.max(titulo.length, ...filas.map((f) => f[i].length)));
  const esNumero = (celda) => /^-?\d+(\.\d+)?$/.test(celda);
  const texto = cabecera.map((_, i) => filas.length === 0 || !esNumero(filas[0][i]));
  const linea = (celdas) => celdas.map((c, i) => (texto[i] ? c.padEnd(anchos[i]) : c.padStart(anchos[i]))).join('  ');
  console.log(linea(cabecera));
  for (const fila of filas) console.log(linea(fila));
  // Named under the table so the `-` of a route without a primary object is not read as a zero.
  const sinObjeto = [...new Set(medidas.filter((m) => m.objetoPrincipalTop === null).map((m) => m.ruta))];
  if (sinObjeto.length > 0) console.log(`\nsin [data-objeto-principal]: ${sinObjeto.join(' ')}`);
}

async function principal() {
  const servidor = spawn(process.execPath, [VITE_ENTRY, '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: CONSOLE_ROOT,
    env: { ...process.env, VITE_USE_MOCKS: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let registro = '';
  const anotar = (trozo) => { registro = (registro + String(trozo)).slice(-2000); };
  servidor.stdout.on('data', anotar);
  servidor.stderr.on('data', anotar);
  servidor.on('error', (fallo) => { anotar(`spawn failed: ${fallo.message}\n`); });
  let medidas;
  let sinMedir;
  try {
    await esperarServidor(() => registro);
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
    let anterior = {};
    try { anterior = JSON.parse(await readFile(BASELINE, 'utf8')); } catch { /* first run */ }
    const rechazos = filtrarRegresiones(resumen, anterior);
    if (rechazos.length > 0) {
      console.error('\nlayout: --update kept the recorded value for these budgets instead of raising it:');
      for (const linea of rechazos) console.error(`  - ${linea}`);
    }
    await writeFile(BASELINE, `${JSON.stringify(resumen, null, 2)}\n`, 'utf8');
    console.log(`\nlayout: baseline written to ${BASELINE}`);
    // A refused raise means the file just written does not describe this run: exiting 0 here would
    // hand that baseline over as if it did.
    if (rechazos.length > 0) process.exit(1);
    return;
  }

  const base = JSON.parse(await readFile(BASELINE, 'utf8'));
  const { peores, mejores } = comparar(resumen, base);
  const { nuevos, cumplidos } = revisarObjetivos(resumen);

  if (mejores.length > 0) {
    console.error('\nlayout: these numbers improved and the baseline still allows the old value:');
    for (const linea of mejores) console.error(`  - ${linea}`);
    console.error('  run `pnpm qa:layout:update` so the gain is the new floor.');
  }
  if (peores.length > 0) {
    console.error('\nlayout: the rendered layout got worse:');
    for (const linea of peores) console.error(`  - ${linea}`);
  }
  if (cumplidos.length > 0) {
    console.error('\nlayout: these v3.1 objectives are met now; delete their PENDIENTES entry:');
    for (const linea of cumplidos) console.error(`  - ${linea}`);
  }
  if (nuevos.length > 0) {
    console.error('\nlayout: these v3.1 objectives are missed and not recorded in PENDIENTES:');
    for (const linea of nuevos) console.error(`  - ${linea}`);
  }
  if (peores.length + mejores.length + sinMedir.length + nuevos.length + cumplidos.length > 0) process.exit(1);
  console.log('\nlayout: every measured budget holds.');
}

await principal();
