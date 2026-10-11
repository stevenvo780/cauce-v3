#!/usr/bin/env node
// Provider tokens stay in this process and are never refreshed during a quota query.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CRED = join(homedir(), ".claude", ".credentials.json");
const BASE = "https://api.anthropic.com";
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
const tok = oauth.accessToken;

if (oauth.expiresAt && oauth.expiresAt <= Date.now()) salir("token caducado: autenticar de nuevo en el entorno propio");

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

try {
  const perfil = await pide("/api/oauth/profile");
  const uso = await pide("/api/oauth/usage");
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
    console.log(JSON.stringify({ ok: false, rateLimited: true, retryAfter: e.retryAfter, nota: `HTTP 429: Anthropic limita la consulta, reintentar en ${e.retryAfter ?? "?"} s (la credencial sigue valida)` }));
    process.exit(0);
  }
  salir(e.code === 401
    ? `HTTP ${e.code}: el token ya no vale, hay que volver a hacer 'claude auth login' en este contenedor`
    : `no pude consultar: ${e.code ? "HTTP " + e.code : e.name}`);
}
