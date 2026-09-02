# @cauce/console

SPA React 19 + Vite del operador. Same-origin: consume solo `/v3/console/*` y `/v3/status` del gateway; no es consumidor de entregas ni guarda estado durable. Cookie de sesión `__Host-cauce_session` emitida fuera; sin browser storage de identidad.

**Enrutado:** sin react-router — `matchRoute`/`ROUTE_TABLE`/`ROUTE_ALIASES` viven en `src/App.tsx`; `src/router.ts` sólo aporta la navegación (`navigate`, `redirect`, `onNavClick`) que `App.tsx` consume. Vistas: Portada, live (flota + cajón de agente con directiva/perfil/ficheros), accounts, messages, queues, observability, config y terminal (xterm.js vía `src/features/terminal/pty-session.ts`, WS same-origin proxificado al relay).

**El editor de ficheros de gobierno** (`src/features/live/FicherosTab.tsx` + `src/api/client.ts`): lee y escribe `CLAUDE.md`/`AGENTS.md`/`SOUL.md` por `GET|PUT /v3/console/tenants/:t/agents/:a/documents/:kind/content`, con `expected_sha` (409 si alguien escribió antes) y ACK tipado del efecto. El gateway ya publica esas rutas (`services/gateway/src/console/agent-documents.routes.ts`, registradas en `routes/console.ts`).

**Estado de tests:** 107/107 verdes desde la ronda 5 (las particiones y la deuda fina de la ronda 6 cerraron los 533 rojos por AbortSignal en jsdom). Anotar el número antes/después de cada cambio: no debe subir.

**Trinquete de layout** (`qa/layout-gate.mjs`, `pnpm qa:layout` desde la raíz): las pruebas de vitest corren en jsdom, que no aplica CSS ni calcula geometría — un menú cuyos rótulos se pisan y una vista que tira un tercio de la pantalla pasan las dos en verde. Los guardias de CSS que sí existen leen la hoja como TEXTO y comparan cadenas, así que tampoco ven la caja renderizada. Este gate levanta la consola con mocks, la recorre con Chromium en 360/760/1100/1440/1920/2560 px y mide ancho útil, hueco muerto, desborde, pantallas de scroll, enlaces de navegación sin nombre accesible y rótulos solapados. La referencia vive en `qa/layout-baseline.json` con la misma semántica que `scripts/calidad.mjs`: los números **solo pueden mejorar**. Una regresión falla con el valor medido al lado del presupuesto que rompió; una mejora también falla, pidiendo `pnpm qa:layout:update`, para que un arreglo no deje de estar vigilado en silencio. Necesita el navegador de Playwright (`npx playwright install chromium`), así que va como `qa:*` y no dentro de `test:unit`.

**Dev:** `pnpm --filter @cauce/console dev|typecheck|lint|test`. Sector de Gemini (`ordenes/gemini.md`, parte A).
