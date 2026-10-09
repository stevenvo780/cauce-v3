#!/usr/bin/env node
// Lee la cuota de esta cuenta de Claude usando el token que dejo `claude auth login`.
//
// No abre ningun navegador. Llama a los dos endpoints que usa el propio CLI:
//   /api/oauth/profile -> de quien es la cuenta. Esto resuelve el viejo problema de
//                         "identidad distinta del inventario": ya no hay que adivinar
//                         mirando que sesion tenia abierta un navegador.
//   /api/oauth/usage   -> utilizacion de la ventana de 5 horas y la de 7 dias.
//
// Va en Node y no en Python a proposito: la imagen ya trae Node, y anadir Python solo para
// esto engordaria el contenedor sin necesidad.
//
// El token NUNCA sale de este proceso: no se imprime, no pasa por la linea de comandos y no
// se escribe en ningun sitio. Por la salida estandar solo salen los porcentajes.
import { readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CRED = join(homedir(), ".claude", ".credentials.json");
const BASE = "https://api.anthropic.com";
// Renovacion del token: mismo mecanismo que el lector de Grok. El access token de `claude auth
// login` dura 8 h y solo se renueva cuando alguien corre el CLI; en un contenedor donde nadie lo
// corre, caduca y el lector queda muerto (visto 2026-09-18: las dos cuentas a la vez). Aqui se
// renueva con el refresh token, contra el endpoint y client_id publico del propio CLI, y se
// reescribe el fichero de forma atomica para que el CLI y el lector sigan compartiendo credencial.
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"; // el que trae el propio CLI 2.1.274
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const MARGEN_MS = 5 * 60 * 1000;

const salir = (nota) => { console.log(JSON.stringify({ ok: false, nota })); process.exit(0); };

if (!existsSync(CRED)) {
  salir("sin autenticar: falta ~/.claude/.credentials.json (entra al contenedor y corre 'claude auth login')");
}

let cred, oauth;
try {
  cred = JSON.parse(readFileSync(CRED, "utf8"));
  oauth = cred.claudeAiOauth;
} catch (e) {
  salir(`credencial ilegible: ${e.name}`);
}
if (!oauth?.accessToken) salir("la credencial existe pero no trae accessToken");
let tok = oauth.accessToken;

const refresca = async () => {
  if (!oauth.refreshToken) throw Object.assign(new Error("sin refresh token"), { code: 401 });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "claude-cli/2.1.274" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: CLIENT_ID,
      scope: (oauth.scopes ?? []).join(" "),
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw Object.assign(new Error("refresh"), { code: r.status, refresh: true });
  const j = await r.json();
  oauth = {
    ...oauth,
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? oauth.refreshToken,
    expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
    scopes: j.scope ? j.scope.split(" ") : oauth.scopes,
  };
  // Escritura atomica: el refresh token rota; si el proceso muriera a medias no puede quedar
  // un fichero truncado, porque entonces se pierde tambien la cadena de renovacion.
  const tmp = CRED + ".tmp";
  writeFileSync(tmp, JSON.stringify({ ...cred, claudeAiOauth: oauth }, null, 2), { mode: 0o600 });
  renameSync(tmp, CRED);
  tok = oauth.accessToken;
};

if (!oauth.expiresAt || oauth.expiresAt - Date.now() < MARGEN_MS) {
  try { await refresca(); }
  catch (e) { salir(`token caducado y no pude renovarlo (${e.code ? "HTTP " + e.code : e.name}): volver a hacer 'claude auth login' en este contenedor`); }
}

const pide = async (ruta) => {
  const r = await fetch(BASE + ruta, {
    headers: {
      authorization: "Bearer " + tok,
      "anthropic-beta": "oauth-2025-04-20",
      "user-agent": "claude-cli/2.1.274",
    },
    signal: AbortSignal.timeout(30000),
  });
  // Un 401 aqui SI significa credencial a renovar. Un fallo de red, no: por eso se
  // distinguen, en vez de reportar cualquier tropiezo como "credencial muerta".
  if (!r.ok) throw Object.assign(new Error("http"), { code: r.status, retryAfter: Number(r.headers.get("retry-after")) || null });
  return r.json();
};

// Un 401 con token en fecha: se renueva una vez y se reintenta. Un 429 NO es credencial muerta,
// es limite de Anthropic: se reporta como tal, con el retry-after, para que nadie lo confunda.
const pideRenovando = async (ruta) => {
  try { return await pide(ruta); }
  catch (e) {
    if (e.code !== 401) throw e;
    await refresca();
    return pide(ruta);
  }
};

try {
  const perfil = await pideRenovando("/api/oauth/profile");
  const uso = await pideRenovando("/api/oauth/usage");
  const cuenta = perfil.account ?? {};
  const ventanas = [["five_hour", "5h"], ["seven_day", "7d"]]
    .map(([k, nombre]) => {
      const v = uso[k];
      if (!v) return null;
      return { key: nombre, usedPercent: v.utilization, resetAt: v.resets_at, locked: v.locked_reason };
    })
    .filter(Boolean);
  console.log(JSON.stringify({
    ok: true,
    provider: "claude",
    email: cuenta.email ?? null,
    plan: cuenta.has_claude_max ? "max" : cuenta.has_claude_pro ? "pro" : "?",
    windows: ventanas,
  }));
} catch (e) {
  if (e.code === 429) {
    console.log(JSON.stringify({ ok: false, rateLimited: true, retryAfter: e.retryAfter, nota: `HTTP 429: Anthropic limita la consulta, reintentar en ${e.retryAfter ?? "?"} s (la credencial sigue valida)` }));
    process.exit(0);
  }
  salir(e.code === 401 || e.refresh
    ? `HTTP ${e.code}: el token ya no vale, hay que volver a hacer 'claude auth login' en este contenedor`
    : `no pude consultar: ${e.code ? "HTTP " + e.code : e.name}`);
}
