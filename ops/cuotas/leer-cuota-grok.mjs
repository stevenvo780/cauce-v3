#!/usr/bin/env node
// Cuota de Grok (Grok Build) por CLI, sin navegador. Mismo endpoint que usa el propio TUI de
// grok en `/usage`:  GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
// Devuelve creditUsagePercent y el periodo semanal (currentPeriod.start/end) -> ventana "7d".
//
// Refresh only with --refresh-own-session, which the quota runtime passes in own-session
// environments; shared sessions are never refreshed while measuring quota.
import { readFileSync, existsSync, openSync, writeSync, fsyncSync, fchmodSync, closeSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CRED = join(homedir(), ".grok", "auth.json");
const USAGE = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const REFRESH = process.argv.includes("--refresh-own-session");
const salir = (nota, error_code) => { console.log(JSON.stringify({ ok: false, provider: "grok", nota, error_code })); process.exit(0); };
const codigoDe = (e) => e.code === 429 ? "rate_limited" : e.code === 401 ? "token_expired"
  : e.code === 403 ? "forbidden_credential_type" : e.code ? "provider_error" : "network";
const codigoRefresco = (e) => e.code === 429 ? "rate_limited"
  : e.code === 400 || e.code === 401 || e.code === 403 ? "token_expired"
  : e.code || e.refresh ? "provider_error" : "network";

if (!existsSync(CRED)) salir("sin autenticar: falta ~/.grok/auth.json (cuota-auth <espacio> grok)", "not_authenticated");
let doc, clave, entry;
try { doc = JSON.parse(readFileSync(CRED, "utf8")); clave = Object.keys(doc)[0]; entry = doc[clave]; }
catch (e) { salir(`credencial ilegible: ${e.name}`, "not_authenticated"); }
if (!entry?.key) salir("la credencial no trae key", "not_authenticated");

const pide = async (tok) => {
  const r = await fetch(USAGE, {
    headers: { authorization: "Bearer " + tok, "user-agent": "grok-cli", accept: "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw Object.assign(new Error("http"), { code: r.status, retryAfter: Number(r.headers.get("retry-after")) || null });
  return r.json();
};

const refresca = async () => {
  if (!entry.refresh_token || !entry.oidc_client_id) throw Object.assign(new Error("sin refresh token"), { code: 401 });
  const issuer = entry.oidc_issuer || "https://auth.x.ai";
  const disc = await (await fetch(issuer.replace(/\/$/, "") + "/.well-known/openid-configuration", { signal: AbortSignal.timeout(15000) })).json();
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: entry.refresh_token, client_id: entry.oidc_client_id });
  const r = await fetch(disc.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw Object.assign(new Error("refresh"), { code: r.status, refresh: true });
  const t = await r.json();
  if (!t.access_token) throw Object.assign(new Error("refresh sin access_token"), { refresh: true });
  entry.key = t.access_token;
  if (t.refresh_token) entry.refresh_token = t.refresh_token;
  if (t.expires_in) entry.expires_at = new Date(Date.now() + t.expires_in * 1000).toISOString();
  doc[clave] = entry;
  const tmp = CRED + ".tmp";
  const fd = openSync(tmp, "w", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, JSON.stringify(doc, null, 2));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, CRED);
  const dir = openSync(dirname(CRED), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
  return entry.key;
};

try {
  let j;
  try { j = await pide(entry.key); }
  catch (e) {
    if (e.code !== 401 || !REFRESH) throw e;
    let tok;
    try { tok = await refresca(); }
    catch (re) {
      salir("HTTP 401 y el refresco fallo: volve a hacer cuota-auth <espacio> grok",
        codigoRefresco(re));
    }
    j = await pide(tok);
  }
  const c = j.config ?? {}; const per = c.currentPeriod ?? {}; const pct = c.creditUsagePercent;
  const duration = (Date.parse(per.end) - Date.parse(per.start)) / 60000;
  console.log(JSON.stringify({
    ok: true, provider: "grok", email: entry.email ?? null, plan: entry.subscription_tier ?? null,
    windows: [{ key: per.type ?? "billing", limitId: "default", windowMinutes: Number.isFinite(duration) && duration > 0 ? duration : null,
      usedPercent: (typeof pct === "number" ? pct : null), resetAt: per.end ?? null, periodType: per.type ?? null }],
  }));
} catch (e) {
  if (e.code === 429) {
    console.log(JSON.stringify({ ok: false, provider: "grok", rateLimited: true, retryAfter: e.retryAfter, error_code: "rate_limited",
      nota: `HTTP 429: Grok limita la consulta, reintentar en ${e.retryAfter ?? "?"} s (la credencial sigue valida)` }));
    process.exit(0);
  }
  salir(e.code === 401 ? "HTTP 401: token vencido, cuota-auth <espacio> grok" : `no pude consultar: ${e.code ? "HTTP " + e.code : e.name}`, codigoDe(e));
}
