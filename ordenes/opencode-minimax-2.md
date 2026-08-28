# OpenCode/MiniMax-2 — ORDEN ACTIVA (ronda 2; 4 subagentes): inglés hasta el último rincón + las zonas de test de consola/relay/bridge

ARRANQUE: `git pull` → `ordenes/00-PROTOCOLO.md` → esta orden. Tu ronda anterior fue LIMPIA: 4 zonas traducidas y commiteadas por zona (adapter-sdk/src, dispatcher, deploy+scripts, pty-agent) — exactamente como se pide. Muestreo de hoy: quedan ~51 comentarios en español en tu zona anterior. Mismas reglas duras (SOLO líneas 100% comentario; narrativo→borrar; invariantes→traducir; fechas/nombres fuera; `git diff` solo-comentarios o revertir).

## Tarea 1 — Barrido de restos en tu zona anterior
`grep -rnE "^\s*(//|#)\s+.*\b(el|la|los|las|que|para|con|una|este|esta|porque|cuando)\b" <zona>` sobre adapter-sdk/src, dispatcher/src, deploy/, scripts/, ops/pty-agent/*.py y tests/{unit,integration,e2e,gateway-hardening,store-hardening,terminal-pty,helpers}: cierra con el grep en CERO (excluye strings de test que sean datos).

## Tarea 2 — Zonas NUEVAS (asignación del integrador, disjuntas de todos): los TESTS de consola, relay y bridge
`console/src/**/*.test.{ts,tsx}` · `services/terminal-relay/src/*.test.ts` · `services/telegram-bridge/test/**` — Gemini ya los molió a nivel estricto; TÚ traduces sus comentarios (mismas reglas). NO toques ficheros que no sean `*.test.*` en esas rutas (el src es de Gemini).

## Tarea 3 — `ops/guardias/**` — DECISIÓN DEL DUEÑO YA TOMADA: son código del proyecto, se traducen
Las 18 herramientas rescatadas (el médico de 3.208 líneas con 709 comentarios, ai-live, credenciales, esfuerzo, estado…) + cred-guard.py/polidin. Mismas reglas; aquí abunda la narrativa con fechas y nombres (`zeus`, `2026-08-13`…): FUERA. El trinquete tiene amnistías altas para ellos: al bajar, re-clava tú las claves en `scripts/calidad-base.json` (solo baja) en el mismo commit.

Push por tarea + reporte ≤5 líneas con el grep final en cero por zona.
