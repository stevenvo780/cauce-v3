#!/usr/bin/env node
// Cuota de Grok (Grok Build) por CLI, sin navegador. Mismo endpoint que usa el propio TUI de
// grok en `/usage`:  GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
// Devuelve creditUsagePercent y el periodo semanal (currentPeriod.start/end) -> ventana "7d".
//
// Refresh only with --refresh-own-session, which the quota runtime passes in own-session
// environments; shared sessions are never refreshed while measuring quota.
import { readFileSync, existsSync, openSync, writeSync, fsyncSync, fchmodSync, closeSync, renameSync, unlinkSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CRED = join(homedir(), ".grok", "auth.json");
const LOCK = CRED + ".lock";
const USAGE = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const LOCK_CADUCA_MS = 60 * 1000;
const DEADLINE = Date.now() + 45 * 1000; // el runtime corta a 60 s
const REFRESH = process.argv.includes("--refresh-own-session");
const salir = (nota, error_code) => { console.log(JSON.stringify({ ok: false, provider: "grok", nota, error_code })); process.exit(0); };
// Los fallos HTTP llevan `status`; DOMException (code 23), TypeError de fetch y errores de disco no son HTTP.
const httpError = (status, extra = {}) => Object.assign(new Error("http"), { status, ...extra });
const esRed = (e) => e?.name === "TimeoutError" || e?.name === "AbortError" || e instanceof TypeError;
const codigoDe = (e) => e.codigo ? e.codigo : e.status === 429 ? "rate_limited" : e.status === 401 ? "token_expired"
  : e.status === 403 ? "forbidden_credential_type" : e.status ? "provider_error" : esRed(e) ? "network" : "provider_error";
const codigoRefresco = (e) => e.codigo ? e.codigo : e.status === 429 ? "rate_limited"
  : e.status === 400 || e.status === 401 || e.status === 403 ? "token_expired"
  : e.status ? "provider_error" : esRed(e) ? "network" : "provider_error";
const describe = (e) => e.status ? "HTTP " + e.status : e.name + (typeof e.code === "string" ? " " + e.code : "");
const plazo = (max) => AbortSignal.timeout(Math.max(1, Math.min(max, DEADLINE - Date.now())));
const duerme = (ms) => new Promise((r) => setTimeout(r, ms));

const conCandado = async (fn) => {
  let fd;
  for (;;) {
    try { fd = openSync(LOCK, "wx", 0o600); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      let viejo = false;
      try { viejo = Date.now() - statSync(LOCK).mtimeMs > LOCK_CADUCA_MS; } catch { continue; }
      if (viejo) { // candado huerfano: rename atomico, solo un proceso lo retira
        const aparte = `${LOCK}.${process.pid}.${randomUUID()}.old`;
        try { renameSync(LOCK, aparte); unlinkSync(aparte); } catch { /* otro lo retiro */ }
        continue;
      }
      if (Date.now() >= DEADLINE) throw Object.assign(new Error("candado ocupado"), { name: "TimeoutError" });
      await duerme(100 + Math.floor(Math.random() * 150));
    }
  }
  try { return await fn(); }
  finally { try { closeSync(fd); } catch { /* ya cerrado */ } try { unlinkSync(LOCK); } catch { /* ya retirado */ } }
};

if (!existsSync(CRED)) salir("sin autenticar: falta ~/.grok/auth.json (cuota-auth <espacio> grok)", "not_authenticated");
let doc, clave, entry;
try { doc = JSON.parse(readFileSync(CRED, "utf8")); clave = Object.keys(doc)[0]; entry = doc[clave]; }
catch (e) { salir(`credencial ilegible: ${e.name}`, "not_authenticated"); }
if (!entry?.key) salir("la credencial no trae key", "not_authenticated");

const pide = async (tok) => {
  const r = await fetch(USAGE, {
    headers: { authorization: "Bearer " + tok, "user-agent": "grok-cli", accept: "application/json" },
    signal: plazo(30000),
  });
  if (!r.ok) throw httpError(r.status, { retryAfter: Number(r.headers.get("retry-after")) || null });
  return r.json();
};

const guardaAtomico = () => {
  const tmp = `${CRED}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, "wx", 0o600);
    fchmodSync(fd, 0o600);
    writeSync(fd, JSON.stringify(doc, null, 2));
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(tmp, CRED);
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* */ } }
    try { unlinkSync(tmp); } catch { /* puede no existir */ }
    throw e;
  }
  const dir = openSync(dirname(CRED), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
};

// Bajo candado: relee; si otro proceso ya renovo (key distinta y no vencida) la adopta sin refrescar.
const refresca = (usada) => conCandado(async () => {
  const d = JSON.parse(readFileSync(CRED, "utf8"));
  const k = Object.keys(d)[0];
  const e = d[k];
  if (!e?.key) throw Object.assign(new Error("credencial sin key"), { codigo: "not_authenticated" });
  doc = d; clave = k; entry = e;
  const vence = e.expires_at ? Date.parse(e.expires_at) : NaN;
  if (e.key !== usada && !(Number.isFinite(vence) && vence <= Date.now())) return e.key;
  if (!e.refresh_token || !e.oidc_client_id) throw Object.assign(new Error("sin refresh token"), { codigo: "token_expired" });
  const issuer = e.oidc_issuer || "https://auth.x.ai";
  const dr = await fetch(issuer.replace(/\/$/, "") + "/.well-known/openid-configuration", { signal: plazo(15000) });
  if (!dr.ok) throw httpError(dr.status);
  const disc = await dr.json();
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: e.refresh_token, client_id: e.oidc_client_id });
  const r = await fetch(disc.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: plazo(20000) });
  if (!r.ok) throw httpError(r.status);
  const t = await r.json();
  if (!t.access_token) throw Object.assign(new Error("refresh sin access_token"), { codigo: "provider_error" });
  e.key = t.access_token;
  if (t.refresh_token) e.refresh_token = t.refresh_token;
  if (t.expires_in) e.expires_at = new Date(Date.now() + t.expires_in * 1000).toISOString();
  d[k] = e;
  guardaAtomico();
  return e.key;
});

try {
  let j;
  try { j = await pide(entry.key); }
  catch (e) {
    if (e.status !== 401 || !REFRESH) throw e;
    let tok;
    try { tok = await refresca(entry.key); }
    catch (re) {
      salir(`HTTP 401 y el refresco fallo (${describe(re)}): volve a hacer cuota-auth <espacio> grok`,
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
  if (e.status === 429) {
    console.log(JSON.stringify({ ok: false, provider: "grok", rateLimited: true, retryAfter: e.retryAfter, error_code: "rate_limited",
      nota: `HTTP 429: Grok limita la consulta, reintentar en ${e.retryAfter ?? "?"} s (la credencial sigue valida)` }));
    process.exit(0);
  }
  salir(e.status === 401 ? "HTTP 401: token vencido, cuota-auth <espacio> grok" : `no pude consultar: ${describe(e)}`, codigoDe(e));
}
