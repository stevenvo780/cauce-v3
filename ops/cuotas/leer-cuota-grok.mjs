#!/usr/bin/env node
// Cuota de Grok (Grok Build) por CLI, sin navegador. Mismo endpoint que usa el propio TUI de
// grok en `/usage`:  GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
// Devuelve creditUsagePercent y el periodo semanal (currentPeriod.start/end) -> ventana "7d".
//
// Shared sessions must never be refreshed while measuring quota.
import { readFileSync, existsSync } from "node:fs";
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

try {
  const j = await pide(entry.key);
  const c = j.config ?? {}; const per = c.currentPeriod ?? {}; const pct = c.creditUsagePercent;
  const duration = (Date.parse(per.end) - Date.parse(per.start)) / 60000;
  console.log(JSON.stringify({
    ok: true, provider: "grok", email: entry.email ?? null, plan: entry.subscription_tier ?? null,
    windows: [{ key: per.type ?? "billing", limitId: "default", windowMinutes: Number.isFinite(duration) && duration > 0 ? duration : null,
      usedPercent: (typeof pct === "number" ? pct : null), resetAt: per.end ?? null, periodType: per.type ?? null }],
  }));
} catch (e) {
  salir(e.code === 401 ? "HTTP 401: token vencido, cuota-auth <espacio> grok" : `no pude consultar: ${e.code ? "HTTP " + e.code : e.name}`);
}
