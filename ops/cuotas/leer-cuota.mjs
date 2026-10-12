#!/usr/bin/env node
// Provider tokens stay in this process. Refresh only with --refresh-own-session, which the
// quota runtime passes in own-session environments; agent containers read without refreshing.
import { readFileSync, existsSync, openSync, writeSync, fsyncSync, fchmodSync, closeSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CRED = join(homedir(), ".claude", ".credentials.json");
const BASE = "https://api.anthropic.com";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const MARGEN_MS = 5 * 60 * 1000;
const REFRESH = process.argv.includes("--refresh-own-session");
const salir = (nota, error_code) => { console.log(JSON.stringify({ ok: false, nota, error_code })); process.exit(0); };
const codigoDe = (e) => e.code === 429 ? "rate_limited" : e.code === 401 ? "token_expired"
  : e.code === 403 ? "forbidden_credential_type" : e.code ? "provider_error" : "network";
const codigoRefresco = (e) => e.code === 429 ? "rate_limited"
  : e.code === 400 || e.code === 401 || e.code === 403 ? "token_expired"
  : e.code || e.refresh ? "provider_error" : "network";

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
if (!oauth?.accessToken) salir("la credencial existe pero no trae accessToken", oauth ? "not_authenticated" : "forbidden_credential_type");
let tok = oauth.accessToken;

const guardaAtomico = () => {
  const tmp = CRED + ".tmp";
  const fd = openSync(tmp, "w", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, JSON.stringify({ ...cred, claudeAiOauth: oauth }, null, 2));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, CRED);
  const dir = openSync(dirname(CRED), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
};

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
  if (!j.access_token) throw Object.assign(new Error("refresh sin access_token"), { refresh: true });
  oauth = {
    ...oauth,
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? oauth.refreshToken,
    expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
    scopes: j.scope ? j.scope.split(" ") : oauth.scopes,
  };
  guardaAtomico();
  tok = oauth.accessToken;
};

if (oauth.expiresAt && oauth.expiresAt <= Date.now() && !REFRESH) {
  salir("token caducado: autenticar de nuevo en el entorno propio", "token_expired");
}
if (REFRESH && (!oauth.expiresAt || oauth.expiresAt - Date.now() < MARGEN_MS)) {
  try { await refresca(); }
  catch (e) {
    salir(`token caducado y no pude renovarlo (${e.code ? "HTTP " + e.code : e.name}): volver a hacer 'claude auth login' en este contenedor`,
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
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw Object.assign(new Error("http"), { code: r.status, retryAfter: Number(r.headers.get("retry-after")) || null });
  return r.json();
};

const pideRenovando = async (ruta) => {
  try { return await pide(ruta); }
  catch (e) {
    if (e.code !== 401 || !REFRESH) throw e;
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
  if (e.code === 429) {
    console.log(JSON.stringify({ ok: false, rateLimited: true, retryAfter: e.retryAfter, error_code: "rate_limited", nota: `HTTP 429: Anthropic limita la consulta, reintentar en ${e.retryAfter ?? "?"} s (la credencial sigue valida)` }));
    process.exit(0);
  }
  salir(e.code === 401 || e.refresh
    ? `HTTP ${e.code ?? 401}: el token ya no vale, hay que volver a hacer 'claude auth login' en este contenedor`
    : `no pude consultar: ${e.code ? "HTTP " + e.code : e.name}`, e.refresh ? codigoRefresco(e) : codigoDe(e));
}
