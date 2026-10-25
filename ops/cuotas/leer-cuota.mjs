#!/usr/bin/env node
// Provider tokens stay in this process. Refresh only with --refresh-own-session, which the
// quota runtime passes in own-session environments; agent containers read without refreshing.
import { readFileSync, existsSync, openSync, writeSync, fsyncSync, fchmodSync, closeSync, renameSync, unlinkSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// CLAUDE_CONFIG_DIR is how Claude Code itself finds a session kept outside $HOME (fleet profile mounts).
const CRED = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".credentials.json");
const LOCK = CRED + ".lock";
const BASE = "https://api.anthropic.com";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const MARGEN_MS = 5 * 60 * 1000;
const LOCK_CADUCA_MS = 60 * 1000;
const DEADLINE = Date.now() + 45 * 1000; // el runtime corta a 60 s
const REFRESH = process.argv.includes("--refresh-own-session");
const salir = (nota, error_code) => { console.log(JSON.stringify({ ok: false, nota, error_code })); process.exit(0); };
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

// Candado exclusivo junto a la credencial: leer -> refrescar -> escribir es una sola seccion critica.
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

if (!existsSync(CRED)) {
  salir("sin autenticar: falta ~/.claude/.credentials.json (entra al contenedor y corre 'claude auth login')", "not_authenticated");
}

let cred, oauth;
try {
  cred = JSON.parse(readFileSync(CRED, "utf8"));
  oauth = cred.claudeAiOauth;
} catch (e) {
  salir(`credencial ilegible: ${e.name}`, "not_authenticated");
}
if (!oauth?.accessToken) salir("la credencial no trae sesion de Claude (claudeAiOauth/accessToken)", "not_authenticated");
let tok = oauth.accessToken;

const guardaAtomico = () => {
  const tmp = `${CRED}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, "wx", 0o600);
    fchmodSync(fd, 0o600);
    writeSync(fd, JSON.stringify({ ...cred, claudeAiOauth: oauth }, null, 2));
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

// Bajo candado: relee la credencial; si otro proceso ya la renovo (token distinto y vigente) la adopta.
const refresca = () => conCandado(async () => {
  const usado = tok;
  const disco = JSON.parse(readFileSync(CRED, "utf8"));
  const o = disco.claudeAiOauth;
  if (!o?.accessToken) throw Object.assign(new Error("credencial sin sesion"), { codigo: "not_authenticated" });
  cred = disco; oauth = o;
  if (o.accessToken !== usado && o.expiresAt && o.expiresAt - Date.now() > MARGEN_MS) { tok = o.accessToken; return; }
  if (!o.refreshToken) throw Object.assign(new Error("sin refresh token"), { codigo: "token_expired" });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "claude-cli/2.1.274" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: o.refreshToken,
      client_id: CLIENT_ID,
      scope: (o.scopes ?? []).join(" "),
    }),
    signal: plazo(30000),
  });
  if (!r.ok) throw httpError(r.status);
  const j = await r.json();
  if (!j.access_token) throw Object.assign(new Error("refresh sin access_token"), { codigo: "provider_error" });
  oauth = {
    ...o,
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? o.refreshToken,
    expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
    scopes: j.scope ? j.scope.split(" ") : o.scopes,
  };
  guardaAtomico();
  tok = oauth.accessToken;
}).catch((e) => { throw Object.assign(e, { refresh: true }); });

if (oauth.expiresAt && oauth.expiresAt <= Date.now() && !REFRESH) {
  salir("token caducado: autenticar de nuevo en el entorno propio", "token_expired");
}
if (REFRESH && (!oauth.expiresAt || oauth.expiresAt - Date.now() < MARGEN_MS)) {
  try { await refresca(); }
  catch (e) {
    // Refresco preventivo fallido con el token aun vigente: seguir con el actual (como Codex).
    if (!oauth.expiresAt || oauth.expiresAt > Date.now()) { /* sigue con tok */ }
    else salir(`token caducado y no pude renovarlo (${describe(e)}): volver a hacer 'claude auth login' en este contenedor`,
      codigoRefresco(e));
  }
}

const pide = async (ruta) => {
  const r = await fetch(BASE + ruta, {
    headers: {
      authorization: "Bearer " + tok,
      "anthropic-beta": "oauth-2025-04-20",
      "user-agent": "claude-cli/2.1.274",
    },
    signal: plazo(30000),
  });
  if (!r.ok) throw httpError(r.status, { retryAfter: Number(r.headers.get("retry-after")) || null });
  return r.json();
};

const pideRenovando = async (ruta) => {
  try { return await pide(ruta); }
  catch (e) {
    if (e.status !== 401 || !REFRESH) throw e;
    await refresca();
    return pide(ruta);
  }
};

try {
  const perfil = await pideRenovando("/api/oauth/profile");
  const uso = await pideRenovando("/api/oauth/usage");
  const cuenta = perfil.account ?? {};
  const ventanas = Object.entries(uso).flatMap(([key, value]) => {
    if (!/^(five_hour|seven_day)(?:_[a-z0-9_]+)?$/u.test(key) || key === "seven_day_breakdown"
      || !value || typeof value !== "object" || Array.isArray(value)) return [];
    const base = key.startsWith("five_hour") ? "five_hour" : "seven_day";
    const usedPercent = typeof value.utilization === "number" && Number.isFinite(value.utilization) ? value.utilization : null;
    if (key !== base && usedPercent === null) return [];
    const suffix = key.slice(base.length + 1);
    const model = value.model ?? (/^(sonnet|opus|haiku)(?:_|$)/u.test(suffix) ? suffix : null);
    return [{ key: key === base ? (base === "five_hour" ? "5h" : "7d") : key,
      limitId: value.limit_id ?? value.limitId ?? "default", model,
      windowMinutes: value.window_minutes ?? (base === "five_hour" ? 300 : 10080),
      usedPercent, resetAt: value.resets_at ?? null,
      status: value.locked_reason ? "rate-limited" : usedPercent === null ? "unknown" : "ok" }];
  });
  console.log(JSON.stringify({
    ok: true,
    provider: "claude",
    account_id: cuenta.uuid ?? cuenta.id ?? null,
    email: cuenta.email ?? null,
    plan: cuenta.has_claude_max ? "max" : cuenta.has_claude_pro ? "pro" : "?",
    windows: ventanas,
  }));
} catch (e) {
  if (e.status === 429 && !e.refresh) {
    console.log(JSON.stringify({ ok: false, rateLimited: true, retryAfter: e.retryAfter, error_code: "rate_limited", nota: `HTTP 429: Anthropic limita la consulta, reintentar en ${e.retryAfter ?? "?"} s (la credencial sigue valida)` }));
    process.exit(0);
  }
  salir(e.refresh ? `no pude renovar el token (${describe(e)}): volver a hacer 'claude auth login' en este contenedor`
    : e.status === 401 ? "HTTP 401: el token ya no vale, hay que volver a hacer 'claude auth login' en este contenedor"
    : `no pude consultar: ${describe(e)}`, e.refresh ? codigoRefresco(e) : codigoDe(e));
}
