#!/usr/bin/env node
/*
 * MEDIR LA CONSOLA EN UN NAVEGADOR DE VERDAD.
 *
 * Por qué existe: los 646 tests de `console` pasan HOY con la consola ilegible, porque jsdom
 * NO TIENE LAYOUT. Un rótulo que se pisa con el de al lado, una cabecera renderizando una letra
 * por línea, un panel 324 px más ancho que el teléfono y un botón a 1,53:1 de contraste son, para
 * jsdom, exactamente lo mismo que si no estuvieran. Este arnés abre Chrome, espera a que la
 * pantalla se asiente y MIDE sobre el DOM: contraste calculado (con los degradados compuestos y
 * la opacidad heredada), `scrollWidth` contra `clientWidth`, y qué texto queda recortado.
 *
 *   Uso:
 *     node ops/console-legibilidad/medir.mjs                    # informe, siempre sale 0
 *     node ops/console-legibilidad/medir.mjs --exigir           # sale 1 si algo está mal
 *     node ops/console-legibilidad/medir.mjs --tema=oscuro
 *     node ops/console-legibilidad/medir.mjs --capturas=/ruta   # guarda PNG por vista
 *     BASE=http://127.0.0.1:4173 node ops/console-legibilidad/medir.mjs   # servidor ya levantado
 *
 * Sin `BASE`, levanta él mismo `vite` en modo mock sobre `console` y lo apaga al terminar.
 * Necesita Chrome (`/usr/bin/google-chrome`); NO necesita servidor X ni puppeteer.
 *
 * Lo que cuenta como fallo:
 *   · cualquier texto ACTIVO por debajo de 4,5:1 (3,0 si es texto grande). Los controles
 *     inactivos se cuentan aparte: WCAG 1.4.3 los exime, y meterlos en el total sube el umbral
 *     y ciega al resto.
 *   · que el documento sea más ancho que la ventana a cualquiera de los dos anchos.
 *   · un panel que no cabe en sí mismo, o un texto recortado con elipsis.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, Cdp, Page } from './cdp.mjs';
import { PROBE } from './probe.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const CONSOLA = resolve(AQUI, '../../console');

const args = process.argv.slice(2);
const bandera = (nombre) => args.some((a) => a === `--${nombre}` || a.startsWith(`--${nombre}=`));
const opcion = (nombre, porDefecto) => {
  const encontrado = args.find((a) => a.startsWith(`--${nombre}=`));
  return encontrado ? encontrado.slice(nombre.length + 3) : porDefecto;
};

const EXIGIR = bandera('exigir');
const TEMA = opcion('tema', 'claro') === 'oscuro' ? 'dark' : 'light';
const CAPTURAS = opcion('capturas', '');
const RUTAS = opcion('rutas', '/,live,accounts,messages,queues,observability,config,terminal').split(',');
const VIEWPORTS = [
  { nombre: 'escritorio', w: 1280, h: 900, movil: false },
  { nombre: 'movil360', w: 360, h: 740, movil: true },
];

/** Levanta vite en modo mock y espera a que responda. Devuelve `{ base, apagar }`. */
async function levantarVite() {
  const puerto = 4179;
  const hijo = spawn(
    resolve(CONSOLA, 'node_modules/.bin/vite'),
    ['--host', '127.0.0.1', '--port', String(puerto), '--strictPort'],
    { cwd: CONSOLA, env: { ...process.env, VITE_USE_MOCKS: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let salida = '';
  hijo.stdout.on('data', (d) => { salida += d.toString(); });
  hijo.stderr.on('data', (d) => { salida += d.toString(); });
  const limite = Date.now() + 60000;
  while (Date.now() < limite) {
    try {
      const res = await fetch(`http://127.0.0.1:${puerto}/`);
      if (res.ok) return { base: `http://127.0.0.1:${puerto}`, apagar: () => hijo.kill('SIGKILL') };
    } catch { /* todavía no */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  hijo.kill('SIGKILL');
  throw new Error(`vite no levantó en ${puerto}:\n${salida.slice(-2000)}`);
}

const servidorPropio = process.env.BASE ? null : await levantarVite();
const BASE = process.env.BASE || servidorPropio.base;
if (CAPTURAS) mkdirSync(CAPTURAS, { recursive: true });

const { child, port } = await launchChrome({ port: Number(process.env.PUERTO_CDP || 9333) });
const cdp = await Cdp.connect((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
const pagina = await Page.create(cdp, port);
await pagina.setColorScheme(TEMA);

const informe = {};
const problemas = [];
try {
  for (const vp of VIEWPORTS) {
    await pagina.setViewport(vp.w, vp.h, vp.movil);
    for (const ruta of RUTAS) {
      const clave = `${ruta}@${vp.nombre}`;
      // 2200 ms de asiento: hay animaciones y un refresco de datos. Midiendo a los 0 ms uno se
      // cree defectos que no existen, y eso cuesta el turno entero.
      await pagina.goto(BASE + (ruta === '/' ? '/' : `/${ruta}`), 2200);
      /*
       * TRES muestras separadas medio segundo, y sólo cuenta lo que sale en las tres.
       *
       * MEDIDO, y costó dos horas de intermitencia: «Sincronizar todo» empieza `disabled` (los
       * datos aún no llegaron) con `opacity: .55`, y `.button` transiciona en 180 ms. En el
       * fotograma en que React quita el atributo pero la opacidad todavía no subió, la sonda ve un
       * control ACTIVO al 55% —2,9:1— y lo denuncia. Por eso la huella incluye `inerte`: el
       * registro «deshabilitado» y el registro «en transición» son cosas distintas y ninguno de
       * los dos sobrevive a la intersección. Un guardia que grita en falso tapa el fallo real.
       */
      const muestras = [];
      for (let i = 0; i < 3; i += 1) {
        muestras.push(await pagina.eval(PROBE));
        if (i < 2) await new Promise((res) => setTimeout(res, 500));
      }
      const r = muestras[muestras.length - 1];
      const huella = (x) => `${x.tag}|${x.cls}|${x.text}|${x.color}|${x.bg}|${x.inerte}`;
      const previas = muestras.slice(0, -1).map((m) => new Set(m.subAA.map(huella)));
      r.subAA = r.subAA.filter((x) => previas.every((set) => set.has(huella(x))));
      if (CAPTURAS) await pagina.screenshot(`${CAPTURAS}/${ruta === '/' ? 'portada' : ruta}-${vp.nombre}.png`, true);

      const activos = r.subAA.filter((x) => !x.inerte);
      const inertes = r.subAA.length - activos.length;
      informe[clave] = { ...r, subAA: activos, subAAInertes: inertes };

      if (activos.length) {
        // El detalle va en el problema, no en un JSON aparte: un aviso que no dice QUÉ elemento es
        // obliga a reproducirlo para saberlo, y lo intermitente no siempre se deja reproducir.
        const peores = [...activos].sort((a, b) => a.ratio - b.ratio).slice(0, 3)
          .map((a) => `${a.tag}${a.cls ? `.${a.cls.split(' ').join('.')}` : ''} «${a.text}» ${a.color} sobre ${a.bg} = ${a.ratio}:1 op=${a.opacidad}`);
        problemas.push(`${clave}: ${activos.length} textos por debajo de AA — ${peores.join(' | ')}`);
      }
      if (r.doc.desborda) problemas.push(`${clave}: el documento mide ${r.doc.scrollWidth}px en una ventana de ${r.doc.clientWidth}`);
      if (r.panelesDesbordados.length) problemas.push(`${clave}: ${r.panelesDesbordados.length} paneles no caben en sí mismos`);
      if (r.fueraDePantalla.length) problemas.push(`${clave}: ${r.fueraDePantalla.length} elementos fuera de la pantalla`);
      if (r.truncado.length) problemas.push(`${clave}: ${r.truncado.length} textos recortados con elipsis (${r.truncado.slice(0, 3).map((t) => t.text).join(' · ')})`);
      if (r.nav?.pisados) problemas.push(`${clave}: ${r.nav.pisados} rótulos del menú se pisan con el de al lado`);
      if (r.nav?.arrastrable) problemas.push(`${clave}: el menú esconde entradas detrás de un arrastre (${r.nav.scrollWidth} en ${r.nav.clientWidth})`);

      console.log(
        `${clave.padEnd(26)} subAA=${String(activos.length).padStart(3)} (inertes=${String(inertes).padStart(2)})`
        + ` fuera=${String(r.fueraDePantalla.length).padStart(3)} panelX=${String(r.panelesDesbordados.length).padStart(2)}`
        + ` trunc=${String(r.truncado.length).padStart(3)}`
        + ` doc=${(r.doc.desborda ? `DESBORDA ${r.doc.scrollWidth}>${r.doc.clientWidth}` : 'ok').padEnd(21)}`
        + (r.nav ? ` nav[pisa=${r.nav.pisados} arrastra=${r.nav.arrastrable ? 'SÍ' : 'no'}]` : ''),
      );
    }
  }
} finally {
  cdp.close();
  child.kill('SIGKILL');
  servidorPropio?.apagar();
}

const destino = process.env.INFORME || '';
if (destino) writeFileSync(destino, JSON.stringify({ tema: TEMA, informe }, null, 2));

if (problemas.length) {
  console.log(`\n${problemas.length} problemas:`);
  for (const p of problemas) console.log(`  · ${p}`);
} else {
  console.log('\nSin problemas: contraste AA en todo lo activo, nada fuera de la pantalla, nada recortado.');
}
process.exit(EXIGIR && problemas.length ? 1 : 0);
