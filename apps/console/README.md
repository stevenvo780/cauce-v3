# @cauce/console

SPA React 19 + Vite del operador. Same-origin: consume solo `/v3/console/*` y `/v3/status` del gateway; no es consumidor de entregas ni guarda estado durable. Cookie de sesión `__Host-cauce_session` emitida fuera; sin browser storage de identidad.

**Enrutado:** sin react-router — `src/navigation.ts` (`matchRoute` + `ROUTE_TABLE`/`ROUTE_ALIASES`) y `App.tsx`. Vistas: Portada, live (flota + cajón de agente con directiva/perfil/ficheros), accounts, messages, queues, observability, config y terminal (xterm.js vía `features/terminal/pty-session.ts`, WS same-origin proxificado al relay).

**El editor de ficheros de gobierno** (`features/live/FicherosTab.tsx` + `api/client.ts`): lee y escribe `CLAUDE.md`/`AGENTS.md`/`SOUL.md` por `GET|PUT /v3/console/tenants/:t/agents/:a/documents/:kind/content`, con `expected_sha` (409 si alguien escribió antes) y ACK tipado del efecto. **Escrito y correcto; el gateway desplegado aún no publica esas rutas** — se estrena en FASE 3.

**Estado de tests:** 533/1.366 en rojo por UNA causa de entorno (AbortSignal en jsdom; fix = ordenes/ronda1/codex.md tarea 2). Anotar el número antes/después de cada cambio: no debe subir.

**Dev:** `pnpm --filter @cauce/console dev|typecheck|lint|test`. Sector de Gemini (`ordenes/ronda1/gemini.md`).
