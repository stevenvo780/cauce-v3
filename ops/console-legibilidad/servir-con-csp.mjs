#!/usr/bin/env node
/*
 * Servidor local HTTPS para probar el `dist` de la consola con la política CSP de producción.
 *
 * Sirve el bundle compilado aplicando la cabecera `Content-Security-Policy` equivalente a la de
 * `deploy/nginx-console-tls.conf`, y reenvía las peticiones `/v3/*` (HTTP y WebSocket) a la URL
 * especificada en `CONSOLA_URL`.
 *
 * Uso:
 *   openssl req -x509 -newkey rsa:2048 -keyout llave.pem -out cert.pem -days 3 -nodes \
 *     -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1"
 *   CONSOLA_URL=https://consola.humanizar.tech \
 *     node ops/console-legibilidad/servir-con-csp.mjs console/dist 5290 ./cert.pem ./llave.pem
 */
import { createServer } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { readFile as leer } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const [RAIZ, PUERTO = '5290', CERT = 'cert.pem', LLAVE = 'llave.pem'] = process.argv.slice(2);
if (!RAIZ) { console.error('uso: servir-con-csp.mjs <dist> [puerto] [cert.pem] [llave.pem]'); process.exit(2); }
if (!process.env.CONSOLA_URL) { console.error('falta CONSOLA_URL'); process.exit(2); }
const ORIGEN = new URL(process.env.CONSOLA_URL);

/*
 * COPIA EXACTA de la cabecera de `deploy/nginx-console-tls.conf`. Si allá cambia y acá no, esto
 * vuelve a medir otra cosa: es la línea que hay que mantener a mano, y por eso está sola y con
 * este cartel encima. `ws:` se añade a `connect-src` sólo porque el banco de pruebas es local.
 */
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; "
  + "img-src 'self' data:; font-src 'self'; connect-src 'self' wss: ws:; worker-src 'self'; "
  + "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

const TIPOS = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json',
                '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon', '.woff2':'font/woff2', '.map':'application/json' };

const TLS = { cert: readFileSync(resolve(CERT)), key: readFileSync(resolve(LLAVE)) };

const servidor = createServer(TLS, async (req, res) => {
  const url = new URL(req.url, 'https://x');
  if (url.pathname.startsWith('/v3/')) {
    const cabeceras = { ...req.headers, host: ORIGEN.host, origin: ORIGEN.origin, referer: `${ORIGEN.origin}/` };
    delete cabeceras['accept-encoding'];
    const arriba = httpsRequest({ host: ORIGEN.hostname, port: 443, path: req.url, method: req.method, headers: cabeceras }, (r) => {
      const h = { ...r.headers };
      // Se le quita el `Domain` para que la cookie valga en 127.0.0.1. El `Secure` NO se toca: sin
      // él, el navegador tira la cookie `__Host-` y el login falla en silencio.
      if (h['set-cookie']) h['set-cookie'] = h['set-cookie'].map((c) => c.replace(/;\s*Domain=[^;]*/i, ''));
      res.writeHead(r.statusCode, h);
      r.pipe(res);
    });
    arriba.on('error', (e) => { res.writeHead(502); res.end(`proxy: ${e.message}`); });
    req.pipe(arriba);
    return;
  }
  const camino = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
  let fichero = join(RAIZ, camino);
  let cuerpo;
  try { cuerpo = await leer(fichero); if (!extname(fichero)) throw new Error('directorio'); }
  catch { fichero = join(RAIZ, 'index.html'); cuerpo = await leer(fichero); }
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Content-Type', TIPOS[extname(fichero)] || 'application/octet-stream');
  res.end(cuerpo);
});

// El PTY viaja por WebSocket: se reenvía el apretón de manos crudo y se empalman los dos sockets.
servidor.on('upgrade', (req, socket, head) => {
  const arriba = tlsConnect({ host: ORIGEN.hostname, port: 443, servername: ORIGEN.hostname, ALPNProtocols: ['http/1.1'] }, () => {
    const lineas = [`GET ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === 'host') lineas.push(`Host: ${ORIGEN.host}`);
      else if (k === 'origin') lineas.push(`Origin: ${ORIGEN.origin}`);
      else if (Array.isArray(v)) for (const x of v) lineas.push(`${k}: ${x}`);
      else lineas.push(`${k}: ${v}`);
    }
    arriba.write(`${lineas.join('\r\n')}\r\n\r\n`);
    if (head?.length) arriba.write(head);
    arriba.pipe(socket);
    socket.pipe(arriba);
  });
  arriba.on('error', () => socket.destroy());
  socket.on('error', () => arriba.destroy());
});

servidor.listen(Number(PUERTO), '127.0.0.1', () => {
  console.log(`sirviendo ${RAIZ} en https://127.0.0.1:${PUERTO} con la CSP de producción, /v3/* → ${ORIGEN.host}`);
});
