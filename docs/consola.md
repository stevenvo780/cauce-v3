# Consola web del operador

SPA React 19 + Vite destinada al operador del sistema. Se sirve en el mismo origen y consume exclusivamente las rutas `/v3/console/*` y `/v3/status` del gateway — no es un consumidor de entregas y no almacena estado duradero. La sesión se gestiona mediante la cookie `__Host-cauce_session`, emitida externamente; el navegador no guarda tokens ni identidad.

Véase [arquitectura.md](arquitectura.md) para el contexto general del sistema.

## Enrutamiento

No utiliza `react-router`. El enrutamiento se resuelve con un módulo propio en `src/router.ts` (`matchRoute`, `ROUTE_TABLE`, `ROUTE_ALIASES`) integrado en `src/App.tsx`.

## Vistas

| Directorio | Función |
|---|---|
| `features/landing/` | Dashboard: estado rápido del sistema |
| `features/live/` | Estado de flota en tiempo real y drawer de agente: una única vista `Contexto` para editar perfil y manual, más `Ficheros` como visor |
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

## Contexto y ficheros de gobernanza

El drawer de `/live` tiene un solo lugar de mutación: la pestaña **Contexto**. Allí conviven dos
controles distintos sin duplicar navegación:

- el perfil canónico (`purpose`, `role_summary`, `human_brief`, responsabilidades, restricciones,
  herramientas declaradas y reglas operativas), leído y escrito mediante
  `GET|PUT /v3/console/tenants/:t/agents/:a/perfil`;
- el texto manual ajeno al perfil, leído y escrito mediante
  `GET|PUT /v3/console/tenants/:t/agents/:a/documents/directive/content`.

Ambas escrituras ya tienen rutas en el gateway y requieren hechos medidos del runtime, control de
acceso y ACK verificable. El perfil usa revisión esperada y se aplica como lote. El manual usa
`expected_sha` —o `create_if_absent` para un fichero realmente ausente— y rechaza el conflicto si
otro operador escribió primero.

Los bloques delimitados por los marcadores reservados `<!-- CAUCE:CONTEXTO-FIJO ... -->` /
`<!-- CAUCE:FIN-CONTEXTO-FIJO -->` y `<!-- CAUCE:PERFIL ... -->` /
`<!-- CAUCE:FIN-PERFIL -->`, junto con `<!-- CAUCE:REVISION-PERFIL ... -->`, pertenecen al perfil
canónico. El PUT manual conserva esos bloques y rechaza cualquier intento de modificarlos,
retirarlos o introducir nuevos marcadores `CAUCE`; el texto libre de fuera sigue siendo editable.
Así el editor manual no se convierte en una segunda vía para cambiar el perfil.
Si el fichero contiene un marcador `CAUCE` de una versión que el gateway todavía no conoce, la
edición falla cerrada hasta actualizarlo. En documentos CRLF, la consola restaura ese mismo estilo
de salto antes del PUT para no alterar los bloques por la normalización propia de `<textarea>`.

`Ficheros` no guarda nada: lista rutas derivadas de hechos medidos y abre únicamente contenido
permitido en modo de sólo lectura. Configuraciones sensibles, credenciales, directorios y memoria
viva permanecen fuera de la escritura web.

El campo `tools` del perfil sólo declara herramientas en el contexto. No concede permisos, no
habilita binarios ni configura MCP; las capacidades acreditadas proceden del runtime y la
autorización efectiva de membresías, `role_policies`, ACL y RBAC.

La aplicación canónica por lote existe para Claude, Codex y OpenClaw. Hermes sólo puede ofrecer el
manual que su runtime mida; no se presenta como compatible con ese lote. OpenCode no pertenece al
juego de arneses soportado y la consola no ofrece una edición ficticia para él.

## Cliente API

`src/api/client.ts` — cliente HTTP tipado con control de timeout y soporte de cancelación. El contexto se provee mediante `src/api/context.tsx` y el hook `src/api/use-resource.ts`.

## Terminal interactiva

`src/features/terminal/pty-session.ts` gestiona la sesión WebSocket en el mismo origen, que el gateway proxea hacia `terminal-relay`. Véase [terminal-pty.md](terminal-pty.md) y [services/terminal-relay/README.md](../services/terminal-relay/README.md).

## Gate de regresión visual

`qa/layout-gate.mjs` (ejecutar con `pnpm qa:layout`): lanza la consola con mocks, ejecuta Chromium a 360/760/1100/1440/1920/2560 px y mide ancho útil, espacio muerto, overflow, pantallas de scroll, enlaces de nav sin nombre y etiquetas solapadas. Baseline en `qa/layout-baseline.json` — funciona como ratchet: los números solo pueden mejorar. Requiere `npx playwright install chromium`.

## Despliegue

Dockerfile genera una SPA estática servida por nginx-unprivileged. TLS con certificado propio, mTLS hacia el gateway. El contenedor se ejecuta sin root y con filesystem de solo lectura.

## Tests

La consola mantiene tests Vitest + jsdom, sin fijar en esta guía un conteo que envejece con cada
regresión nueva:

```bash
pnpm --filter @cauce/console test
```

## Restricciones clave

- La consola **no importa** paquetes `@cauce/*` — está desacoplada en la frontera HTTP.
- Sin almacenamiento de tokens ni identidad en el navegador.
- CSP estricta: `script-src 'self'`, `style-src 'self'`; únicamente `style-src-attr 'unsafe-inline'` para la geometría de xterm.
