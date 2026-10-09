#!/usr/bin/env node
// Cuota de Grok (Grok Build) por CLI, sin navegador. Mismo endpoint que usa el propio TUI de
// grok en `/usage`:  GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
// Devuelve creditUsagePercent y el periodo semanal (currentPeriod.start/end) -> ventana "7d".
//
// El token de ~/.grok/auth.json caduca a las ~6 h; el fichero trae refresh_token y el
// client_id OIDC. Si el servidor responde 401, se intenta un refresco OIDC estandar
// (descubrimiento en auth.x.ai) y se reescribe auth.json de forma atomica, para que el CLI
// y este lector sigan en sintonia. El token nunca sale de este proceso.
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CRED = join(homedir(), ".grok", "auth.json");
const USAGE = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const salir = (nota) => { console.log(JSON.stringify({ ok: false, provider: "grok", nota })); process.exit(0); };

if (!existsSync(CRED)) salir("sin autenticar: falta ~/.grok/auth.json (cuota-auth <espacio> grok)");
let doc, clave, entry;
try { doc = JSON.parse(readFileSync(CRED, "utf8")); clave = Object.keys(doc)[0]; entry = doc[clave]; }
catch (e) { salir(`credencial ilegible: ${e.name}`); }
if (!entry?.key) salir("la credencial no trae key");

const pide = async (tok) => {
  const r = await fetch(USAGE, {
    headers: { authorization: "Bearer " + tok, "user-agent": "grok-cli", accept: "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw Object.assign(new Error("http"), { code: r.status });
  return r.json();
};

const refresca = async () => {
  const issuer = entry.oidc_issuer || "https://auth.x.ai";
  const disc = await (await fetch(issuer.replace(/\/$/, "") + "/.well-known/openid-configuration", { signal: AbortSignal.timeout(15000) })).json();
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: entry.refresh_token, client_id: entry.oidc_client_id });
  const r = await fetch(disc.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw Object.assign(new Error("refresh"), { code: r.status });
  const t = await r.json();
  if (!t.access_token) throw new Error("refresh sin access_token");
  entry.key = t.access_token;
  if (t.refresh_token) entry.refresh_token = t.refresh_token;
  if (t.expires_in) entry.expires_at = new Date(Date.now() + t.expires_in * 1000).toISOString();
  doc[clave] = entry;
  const tmp = CRED + ".tmp"; writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 }); renameSync(tmp, CRED);
  return entry.key;
};

try {
  let j;
  try { j = await pide(entry.key); }
  catch (e) {
    if (e.code !== 401) throw e;
    let tok; try { tok = await refresca(); } catch (re) { salir("HTTP 401 y el refresco fallo: volve a hacer cuota-auth <espacio> grok"); }
    j = await pide(tok);
  }
  const c = j.config ?? {}; const per = c.currentPeriod ?? {}; const pct = c.creditUsagePercent;
  console.log(JSON.stringify({
    ok: true, provider: "grok", email: entry.email ?? null, plan: entry.subscription_tier ?? null,
    windows: [{ key: "7d", usedPercent: (typeof pct === "number" ? pct : null), resetAt: per.end ?? null, periodType: per.type ?? null }],
  }));
} catch (e) {
  salir(e.code === 401 ? "HTTP 401: token vencido, cuota-auth <espacio> grok" : `no pude consultar: ${e.code ? "HTTP " + e.code : e.name}`);
}
