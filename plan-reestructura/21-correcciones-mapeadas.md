# 21 — Correcciones sobre lo mapeado (sin desplegar)

**Fase:** 2 · **Tamaño:** mediano · **Ejecutor:** Codex o Claude (Sonnet) · **Revisor:** GPT 5.6 Ultra
**Rama:** ninguna — directo a `main` · **Depende de:** FASE 1 mergeada en el sector que toque

## Objetivo
Corregir los defectos concretos que la auditoría dejó con archivo:línea, todos verificables en local sin tocar producción. Al cerrar este fichero, `pnpm test:unit` entra al gate global.

## Tareas (cada una = un commit con su evidencia en el mensaje)

### A. Tests
1. **AbortSignal (desbloquea 533 tests).** El cliente fetch de la consola falla en jsdom con `RequestInit: Expected signal … to be an instance of AbortSignal` (1.587 apariciones; 43 ficheros de test caídos en cascada). Es un problema de realm del polyfill. Arreglo en un punto: `apps/console/src/test/setup.ts` (hoy solo parchea matchMedia/getContext) — alinear fetch/AbortController al mismo realm. El mecanismo ofensor está instanciado en `api/client.ts:265,275` y `features/terminal/api.ts:188,207`.
2. **`pnpm test:unit` encadena con `&&`**: si consola falla, `vitest run tests/unit packages/protocol/test` nunca corre. Cambiar a que corran todos y se reporte el agregado (o usar `--no-bail` coherente).
3. **Tests de `tests/unit/` que ejecutan scripts de release reales** (deploy-release.sh, pin-production-release.py como subprocesos): tras la cuarentena de 12, estos tests van a `_legado/` con su maquinaria.
4. **Contrato interlenguaje del protocolo PTY** (`tests/terminal-pty/vectors.json`, "frozen", tags solo hasta PONG 0x41): extenderlo con los tags de gobierno 0x50–0x5E. Esta laguna es exactamente la que dejó pasar la incompatibilidad 0x5E viva en producción. El fake-pty-agent de `tests/terminal-pty/` debe conocer los mismos tags que el agente real.
5. **Testcontainers sin Ryuk** (`scripts/test.sh:14`): añadir limpieza compensatoria (trap) o reactivar Ryuk. Es la causa de los postgres huérfanos.

### B. Bugs de código confirmados (locales, sin despliegue)
6. **pty-agent manda TAG_READ_DONE incondicional** (`ops/pty-agent/cauce_pty_agent.py:1280`) sin negociar capacidad con el relay. Hacerlo condicional al feature-handshake (el relay anuncia qué tags acepta en HELLO_ACK, o versionar el protocolo). Esto convierte el mismatch de versiones de fatal a degradación limpia.
7. **El relay mata la conexión entera ante un tag desconocido** (`services/terminal-relay/src/framing.ts` + `agent-leg.ts:467-475`, `fail('framing_violation')` descarta el chunk completo, incluidas tramas válidas): ante tag desconocido, responder error de protocolo y descartar solo esa trama, o cerrar solo la sesión afectada. Documentar la decisión en el propio código (1 línea).
8. **nginx de consola y relay con rutas WS incompatibles entre versiones** (hallazgo: desplegar relay nuevo con consola vieja rompe el canal): unificar el path WS en un solo sitio compartido/config y test que lo verifique.
9. **Comentarios que mienten**: barrido final (post-limpieza de Gemini) buscando afirmaciones temporales/de estado en comentarios (`grep -rn "desde hace\|semanas\|meses\|hoy\|actualmente" --include="*.ts"` y equivalentes) — borrar o corregir.

### C. Decisiones del dueño a ejecutar aquí (marcar cuáles)
10. Vistas de consola sin tráfico (audit, jobs, chains, egress/notifications): [ ] conservar / [ ] a `_legado`.
11. Maquinaria de cuotas/licencias (61K muestras, 0 decisiones): [ ] conservar / [ ] a `_legado`.
12. Endpoints escritos y jamás llamados por la consola (`/v3/console/agents`, `/v3/console/egress/notifications`, chain-gates): [ ] cablear en la UI / [ ] a `_legado`.

## Gate de aceptación
- `pnpm typecheck && pnpm lint && pnpm test:unit` — TODO verde, y desde aquí es el gate global de cualquier rama.
- El contrato de vectores PTY cubre 0x50–0x5E y falla si un tag nuevo no se registra en los tres lados (agente Python, relay TS, fake de tests).
