# Consola web del operador

SPA React 19 + Vite destinada al operador del sistema. Se sirve en el mismo origen y consume exclusivamente las rutas `/v3/console/*` y `/v3/status` del gateway — no es un consumidor de entregas y no almacena estado duradero. La sesión se gestiona mediante la cookie `__Host-cauce_session`, emitida externamente; el navegador no guarda tokens ni identidad.

Véase [arquitectura.md](arquitectura.md) para el contexto general del sistema.

## Enrutamiento

No utiliza `react-router`. El enrutamiento se resuelve con un módulo propio en `src/router.ts` (`matchRoute`, `ROUTE_TABLE`, `ROUTE_ALIASES`) integrado en `src/App.tsx`.

## Vistas

| Directorio | Función |
|---|---|
| `features/landing/` | Dashboard: estado rápido del sistema |
| `features/live/` | Estado de flota en tiempo real, drawer de agente con tabs de directiva/perfil/ficheros, editor de ficheros de gobernanza (`FicherosTab.tsx`) |
| `features/fleet/` | Mapa de estado de la flota |
| `features/messages/` | Explorador y visor de mensajes |
| `features/queues/` | Colas de salida, DLQ, reintentos |
| `features/observability/` | Métricas, gráficos, salud de colas |
| `features/config/` | Configuración versionada con OCC |
| `features/accounts/` | Gestión y selección de cuentas/tenants |
| `features/auth/` | Login OIDC / contraseña / selección de sesión |
| `features/audit/` | Visor de eventos de auditoría y telemetría |
| `features/terminal/` | Terminal interactiva vía xterm.js (ver abajo) |
| `features/help/` | Documentación integrada y atajos de teclado |

## Editor de ficheros de gobernanza

`src/features/live/FicherosTab.tsx` junto con `src/api/client.ts` permiten leer y escribir `CLAUDE.md`, `AGENTS.md` y `SOUL.md` a través de `GET|PUT /v3/console/tenants/:t/agents/:a/documents/:kind/content`. La escritura utiliza `expected_sha` para control optimista de concurrencia (409 si otro usuario escribió primero) y confirma con ACK tipado. El código está completo; las rutas del gateway se publicarán en FASE 3.

## Cliente API

`src/api/client.ts` — cliente HTTP tipado con control de timeout y soporte de cancelación. El contexto se provee mediante `src/api/context.tsx` y el hook `src/api/use-resource.ts`.

## Terminal interactiva

`src/features/terminal/pty-session.ts` gestiona la sesión WebSocket en el mismo origen, que el gateway proxea hacia `terminal-relay`. Véase [terminal-pty.md](terminal-pty.md) y [services/terminal-relay/README.md](../services/terminal-relay/README.md).

## Gate de regresión visual

`qa/layout-gate.mjs` (ejecutar con `pnpm qa:layout`): lanza la consola con mocks, ejecuta Chromium a 360/760/1100/1440/1920/2560 px y mide ancho útil, espacio muerto, overflow, pantallas de scroll, enlaces de nav sin nombre y etiquetas solapadas. Baseline en `qa/layout-baseline.json` — funciona como ratchet: los números solo pueden mejorar. Requiere `npx playwright install chromium`.

## Despliegue

Dockerfile genera una SPA estática servida por nginx-unprivileged. TLS con certificado propio, mTLS hacia el gateway. El contenedor se ejecuta sin root y con filesystem de solo lectura.

## Tests

107 tests (vitest + jsdom):

```bash
pnpm --filter @cauce/console test
```

## Restricciones clave

- La consola **no importa** paquetes `@cauce/*` — está desacoplada en la frontera HTTP.
- Sin almacenamiento de tokens ni identidad en el navegador.
- CSP estricta: `script-src 'self'`, `style-src 'self'`; únicamente `style-src-attr 'unsafe-inline'` para la geometría de xterm.
