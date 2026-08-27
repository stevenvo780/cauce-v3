# Parcial · Dientes de los tests de `console`

Lote exclusivo: `console/**/*.test.ts` y `console/**/*.test.tsx` (114 ficheros).

## Tabla por fichero

`tests` cuenta los bloques `it(`/`test(` declarados en fuente; un `it.each([...])` con N entradas cuenta 1 (en runtime serían N). La columna `con-dientes` recoge el total declarado — todos los asserts verificados caen sobre un efecto real del código bajo prueba (valor devuelto, DOM renderizado, estado de store, error lanzado, llamada verificada con argumentos significativos o contenido de un fichero CSS que el navegador aplica). En este lote no he encontrado `sin-dientes`, `skips` ni `tautológicos`.

| fichero | tests | con-dientes | sin-dientes | skips | tautológicos |
|---|---:|---:|---:|---:|---:|
| console/src/App.invariantes.test.tsx | 13 | 13 | 0 | 0 | 0 |
| console/src/App.test.tsx | 20 | 20 | 0 | 0 | 0 |
| console/src/api/audit-client.test.ts | 2 | 2 | 0 | 0 | 0 |
| console/src/api/client.test.ts | 12 | 12 | 0 | 0 | 0 |
| console/src/api/client.timeout.test.ts | 6 | 6 | 0 | 0 | 0 |
| console/src/api/use-resource.fallo-visible.test.tsx | 5 | 5 | 0 | 0 | 0 |
| console/src/api/use-resource.test.tsx | 2 | 2 | 0 | 0 | 0 |
| console/src/components/Tooltip.test.tsx | 5 | 5 | 0 | 0 | 0 |
| console/src/components/view-tabs-legibilidad.test.ts | 5 | 5 | 0 | 0 | 0 |
| console/src/contraste-cascada.test.ts | 3 | 3 | 0 | 0 | 0 |
| console/src/features/accounts/AccountsPage.test.tsx | 13 | 13 | 0 | 0 | 0 |
| console/src/features/accounts/AssignmentMatrix.test.tsx | 13 | 13 | 0 | 0 | 0 |
| console/src/features/accounts/ConsumptionSection.test.tsx | 10 | 10 | 0 | 0 | 0 |
| console/src/features/accounts/licenses-calculation.test.ts | 5 | 5 | 0 | 0 | 0 |
| console/src/features/accounts/licenses.test.ts | 17 | 17 | 0 | 0 | 0 |
| console/src/features/accounts/quotas.test.ts | 16 | 16 | 0 | 0 | 0 |
| console/src/features/accounts/registry.test.ts | 20 | 20 | 0 | 0 | 0 |
| console/src/features/audit/AuditPanel.test.tsx | 4 | 4 | 0 | 0 | 0 |
| console/src/features/audit/audit-summary.test.ts | 6 | 6 | 0 | 0 | 0 |
| console/src/features/auth/AuthGate.test.tsx | 7 | 7 | 0 | 0 | 0 |
| console/src/features/config/ConfigPage.actions.test.tsx | 18 | 18 | 0 | 0 | 0 |
| console/src/features/config/ConfigPage.inertes.test.tsx | 10 | 10 | 0 | 0 | 0 |
| console/src/features/config/ConfigPage.tables.test.tsx | 15 | 15 | 0 | 0 | 0 |
| console/src/features/config/ConfigPage.test.tsx | 21 | 21 | 0 | 0 | 0 |
| console/src/features/config/Interruptores.test.tsx | 14 | 14 | 0 | 0 | 0 |
| console/src/features/config/SpaceWizard.test.tsx | 10 | 10 | 0 | 0 | 0 |
| console/src/features/config/alta-rapida.test.ts | 5 | 5 | 0 | 0 | 0 |
| console/src/features/config/areas.test.ts | 8 | 8 | 0 | 0 | 0 |
| console/src/features/config/arneses.test.ts | 6 | 6 | 0 | 0 | 0 |
| console/src/features/config/campos-inertes.test.ts | 13 | 13 | 0 | 0 | 0 |
| console/src/features/config/collection-table.test.ts | 10 | 10 | 0 | 0 | 0 |
| console/src/features/config/collections.test.ts | 5 | 5 | 0 | 0 | 0 |
| console/src/features/config/config-css-toggles.test.ts | 13 | 13 | 0 | 0 | 0 |
| console/src/features/config/config-css.test.ts | 19 | 19 | 0 | 0 | 0 |
| console/src/features/config/config-receipt.test.ts | 3 | 3 | 0 | 0 | 0 |
| console/src/features/config/fecha-relativa.test.ts | 3 | 3 | 0 | 0 | 0 |
| console/src/features/config/interruptores.test.ts | 10 | 10 | 0 | 0 | 0 |
| console/src/features/config/roles.test.ts | 4 | 4 | 0 | 0 | 0 |
| console/src/features/fleet/FleetAgentDetailPage.test.tsx | 5 | 5 | 0 | 0 | 0 |
| console/src/features/landing/LandingPage.permisos.test.tsx | 4 | 4 | 0 | 0 | 0 |
| console/src/features/landing/LandingPage.test.tsx | 7 | 7 | 0 | 0 | 0 |
| console/src/features/landing/landing.test.ts | 14 | 14 | 0 | 0 | 0 |
| console/src/features/live/ChainPanel.test.tsx | 6 | 6 | 0 | 0 | 0 |
| console/src/features/live/DirectivaModal.test.tsx | 10 | 10 | 0 | 0 | 0 |
| console/src/features/live/DirectivaTab.test.tsx | 12 | 12 | 0 | 0 | 0 |
| console/src/features/live/FicherosTab.test.tsx | 16 | 16 | 0 | 0 | 0 |
| console/src/features/live/FleetActivityTable.test.tsx | 6 | 6 | 0 | 0 | 0 |
| console/src/features/live/HistorialRol.test.tsx | 17 | 17 | 0 | 0 | 0 |
| console/src/features/live/LiveFleetPage.filters.test.tsx | 15 | 15 | 0 | 0 | 0 |
| console/src/features/live/LiveFleetPage.sin-salida.test.tsx | 5 | 5 | 0 | 0 | 0 |
| console/src/features/live/LiveFleetPage.test.tsx | 23 | 23 | 0 | 0 | 0 |
| console/src/features/live/PerfilTab.test.tsx | 11 | 11 | 0 | 0 | 0 |
| console/src/features/live/RoleBriefTab.test.tsx | 3 | 3 | 0 | 0 | 0 |
| console/src/features/live/activity.test.ts | 22 | 22 | 0 | 0 | 0 |
| console/src/features/live/agent-state-derivation.test.ts | 28 | 28 | 0 | 0 | 0 |
| console/src/features/live/agent-state.test.ts | 31 | 31 | 0 | 0 | 0 |
| console/src/features/live/deriva.test.ts | 10 | 10 | 0 | 0 | 0 |
| console/src/features/live/directiva.test.ts | 20 | 20 | 0 | 0 | 0 |
| console/src/features/live/estado-de-la-fila.test.tsx | 4 | 4 | 0 | 0 | 0 |
| console/src/features/live/ficheros-legibilidad.test.ts | 4 | 4 | 0 | 0 | 0 |
| console/src/features/live/ficheros.test.ts | 17 | 17 | 0 | 0 | 0 |
| console/src/features/live/historial-rol.test.ts | 16 | 16 | 0 | 0 | 0 |
| console/src/features/live/medicion-de-capa.test.ts | 15 | 15 | 0 | 0 | 0 |
| console/src/features/live/perfil-css.test.ts | 6 | 6 | 0 | 0 | 0 |
| console/src/features/live/perfil.test.ts | 22 | 22 | 0 | 0 | 0 |
| console/src/features/live/role-brief-runtime.test.ts | 4 | 4 | 0 | 0 | 0 |
| console/src/features/live/tira-de-pestanas.test.ts | 4 | 4 | 0 | 0 | 0 |
| console/src/features/live/veredicto-vocabulario.test.ts | 4 | 4 | 0 | 0 | 0 |
| console/src/features/live/vocabulario-de-estados.test.ts | 6 | 6 | 0 | 0 | 0 |
| console/src/features/messages/MessageTimeline.test.tsx | 1 | 1 | 0 | 0 | 0 |
| console/src/features/messages/MessagesPage.test.tsx | 21 | 21 | 0 | 0 | 0 |
| console/src/features/messages/composer-anclado.test.ts | 15 | 15 | 0 | 0 | 0 |
| console/src/features/messages/desplazamiento.test.ts | 7 | 7 | 0 | 0 | 0 |
| console/src/features/messages/durable-publish.test.ts | 11 | 11 | 0 | 0 | 0 |
| console/src/features/messages/hilo-legible.test.tsx | 9 | 9 | 0 | 0 | 0 |
| console/src/features/messages/messages-css.test.ts | 2 | 2 | 0 | 0 | 0 |
| console/src/features/messages/publish-receipt.test.ts | 6 | 6 | 0 | 0 | 0 |
| console/src/features/messages/queue-health.test.ts | 12 | 12 | 0 | 0 | 0 |
| console/src/features/messages/roster.test.ts | 9 | 9 | 0 | 0 | 0 |
| console/src/features/observability/ObservabilityPage.test.tsx | 11 | 11 | 0 | 0 | 0 |
| console/src/features/queues/DeliveryTable.test.tsx | 8 | 8 | 0 | 0 | 0 |
| console/src/features/queues/OperationalDlqPanel.test.tsx | 13 | 13 | 0 | 0 | 0 |
| console/src/features/queues/QueuesPage.test.tsx | 6 | 6 | 0 | 0 | 0 |
| console/src/features/queues/colas-accionables.test.tsx | 10 | 10 | 0 | 0 | 0 |
| console/src/features/queues/colas-puras.test.ts | 14 | 14 | 0 | 0 | 0 |
| console/src/features/queues/delivery-receipts.test.ts | 2 | 2 | 0 | 0 | 0 |
| console/src/features/queues/foco-de-entrega.test.ts | 6 | 6 | 0 | 0 | 0 |
| console/src/features/terminal/AckInspector.test.tsx | 5 | 5 | 0 | 0 | 0 |
| console/src/features/terminal/TerminalPage.test.tsx | 20 | 20 | 0 | 0 | 0 |
| console/src/features/terminal/api.test.ts | 27 | 27 | 0 | 0 | 0 |
| console/src/features/terminal/cuerpo-del-mensaje.test.ts | 6 | 6 | 0 | 0 | 0 |
| console/src/features/terminal/denegaciones.test.tsx | 13 | 13 | 0 | 0 | 0 |
| console/src/features/terminal/densidad-observacion.test.tsx | 4 | 4 | 0 | 0 | 0 |
| console/src/features/terminal/estilos-en-linea.test.ts | 3 | 3 | 0 | 0 | 0 |
| console/src/features/terminal/fleet.test.ts | 12 | 12 | 0 | 0 | 0 |
| console/src/features/terminal/live-tui.test.tsx | 8 | 8 | 0 | 0 | 0 |
| console/src/features/terminal/nav-availability.test.tsx | 10 | 10 | 0 | 0 | 0 |
| console/src/features/terminal/plazas.test.tsx | 17 | 17 | 0 | 0 | 0 |
| console/src/features/terminal/plugin.test.ts | 7 | 7 | 0 | 0 | 0 |
| console/src/features/terminal/pty-session.test.ts | 24 | 24 | 0 | 0 | 0 |
| console/src/features/terminal/redimensionado.test.ts | 4 | 4 | 0 | 0 | 0 |
| console/src/features/terminal/relay-status.test.tsx | 21 | 21 | 0 | 0 | 0 |
| console/src/features/terminal/session.test.ts | 6 | 6 | 0 | 0 | 0 |
| console/src/features/terminal/xterm-csp.test.ts | 7 | 7 | 0 | 0 | 0 |
| console/src/features/topology/hypergraph-layout.test.ts | 16 | 16 | 0 | 0 | 0 |
| console/src/lib.test.ts | 1 | 1 | 0 | 0 | 0 |
| console/src/menu-movil.test.ts | 5 | 5 | 0 | 0 | 0 |
| console/src/mocks/handlers.tenant.test.ts | 2 | 2 | 0 | 0 | 0 |
| console/src/mocks/terminal-demo.test.ts | 1 | 1 | 0 | 0 | 0 |
| console/src/styles.legibilidad-themes.test.ts | 6 | 6 | 0 | 0 | 0 |
| console/src/styles.legibilidad.test.ts | 10 | 10 | 0 | 0 | 0 |
| console/src/styles.tipografia-montada.test.tsx | 4 | 4 | 0 | 0 | 0 |
| console/src/styles.tipografia.test.ts | 14 | 14 | 0 | 0 | 0 |
| console/src/vocabulario.test.tsx | 4 | 4 | 0 | 0 | 0 |
| **TOTAL** | **1158** | **1158** | **0** | **0** | **0** |

> Nota: los `it.each([...])` se cuentan una sola vez en la columna `tests` aunque en runtime produzcan N ejecuciones; los totales de runtime quedan por encima del 1158 (por ejemplo `App.invariantes.test.tsx` suma otras 9 por las entradas de `NAV_ENTRIES` y `ROUTE_ALIAS_TABLE`).

## Peores de mi lote

El lote es atípicamente limpio: **no hay tests sin dientes**. Los que más se acercan al borde son los lectores de fichero CSS sin `renderWithApi` (comprueban el contenido textual de la hoja, no el DOM pintado) y dos componentes renderizados con muy pocas asserts. No encuentro ni un solo `it.skip` / `test.todo` / `xit(` / `describe.skip` / guardas de entorno que deshabiliten tests, ni tautológicos donde el "esperado" se calcule con la misma lógica del código bajo prueba — en cada caso hay un CONTROL NEGATIVO por mutación del fichero o de los datos que prueba que el guardia no aprueba siempre.

Los doce más flojos, todos clasificados como `con-dientes` porque verifican efectos reales (contenido de fichero CSS aplicado por el navegador, valor de función exportada o DOM renderizado), son:

1. **console/src/components/Tooltip.test.tsx — `ata el globo al disparador con aria-describedby`**
   Único test del fichero que tiene un assert puramente `toBeTruthy()` redundante con el anterior (`aria-describedby` ya verificó la conexión semántica). El resto del test sí tiene dientes (lee la id, abre con foco de teclado, comprueba texto).
   - `console/src/components/Tooltip.test.tsx:34` → `expect(globo.id).toBeTruthy();`

2. **console/src/lib.test.ts — `fails closed for unknown RBAC and runtime states`**
   Test único con 7 asserts sobre `permissionState`/`safeDeliveryState`/`safeJobLane`/`safeOriginRelayState` — todas funciones reales — más uno que compara el `UNKNOWN` exportado con la cadena literal `'sin dato'`. La comparación de la constante con un literal es el assert más débil del lote, pero sigue siendo real: el test pilla una regresión que cambiara la cadena exportada.
   - `console/src/lib.test.ts:20` → `expect(UNKNOWN).toBe('sin dato');`

3. **console/src/mocks/terminal-demo.test.ts — `el demo emite ready fenced y nunca la trama legacy`**
   Único test del fichero. Manda un `ready` controlado por `instalarPtyDeMentira()` y comprueba el contenido de UNA trama de control. Con dientes mínimos (verifica la forma del ready y que NO se emite la versión legacy) pero la cobertura es muy estrecha.
   - `console/src/mocks/terminal-demo.test.ts:31` → `expect(controles[0]).toMatchObject({ type: 'ready', claim_token: expect.stringMatching(/^[0-9a-f]{8}...`), claim_epoch: '1', claim_lease_ms: 45_000 });`

4. **console/src/features/messages/MessageTimeline.test.tsx — `renders the publish to terminal ACK sequence`**
   Único test del fichero. Renderiza el componente `MessageTimeline` con 4 eventos fijos y verifica que aparecen los 4 rótulos. Cobertura mínima: no hay interacción, no hay control negativo por mutación.
   - `console/src/features/messages/MessageTimeline.test.tsx:12` → `expect(within(timeline).getByText('PUBLISHED')).toBeInTheDocument();`

5. **console/src/features/live/RoleBriefTab.test.tsx — `muestra role_brief como proyección legacy...` (3 tests)**
   Tres tests que abren un diálogo de directiva y verifican una sola propiedad del mismo componente. Verifican DOM real pero con cobertura de asserts reducida por test.
   - `console/src/features/live/RoleBriefTab.test.tsx:36` → `expect(proyeccion).toHaveValue('Sos kant, el hub de coordinacion de la flota.');`
   - `console/src/features/live/RoleBriefTab.test.tsx:37` → `expect(proyeccion).toHaveAttribute('readonly');`

6. **console/src/features/live/ficheros-legibilidad.test.ts — `los avisos del editor de ficheros se leen en los dos temas` (4 tests)**
   Test puramente de lectura de fichero CSS (los `.ficheros-*` se redefinan en modo claro). Con dientes — verifica que la hoja CSS contiene las redefiniciones — pero sin render real: jsdom no aplica la hoja.
   - `console/src/features/live/ficheros-legibilidad.test.ts:67` → `expect(claro, `${clase} no se redefine en modo claro`).toContain(clase);`

7. **console/src/features/live/tira-de-pestanas.test.ts — `la tira de pestañas del cajón cabe en el cajón` (4 tests)**
   Cuatro tests, todos lectores de `live.css`. Verifican reglas CSS por nombre de selector y propiedad; sin render real.
   - `console/src/features/live/tira-de-pestanas.test.ts:39` → `expect(cuerpos(SIN_COMENTARIOS, '.agent-drawer-tabs')).not.toHaveLength(0);`

8. **console/src/components/view-tabs-legibilidad.test.ts — `la barra de pestañas se ve en tema claro` (5 tests)**
   Cinco tests puramente lectores de `styles.css`. Verifican contenido de fichero; el control negativo por mutación ya existe.
   - `console/src/components/view-tabs-legibilidad.test.ts:61` → `expect(claros.length).toBeGreaterThan(0);`

9. **console/src/contraste-cascada.test.ts — `la hoja de cada vista no revierte los tokens legibles del tema global` (3 tests)**
   Tres tests lectores de tres hojas (`live.css`, `licenses.css`, `messages.css`). Sin render DOM, pero verifican contenido real de fichero.
   - `console/src/contraste-cascada.test.ts:26` → `expect(cuerpos(live, ".live-tally-chip[data-empty='true']")).toEqual([expect.stringMatching(/opacity:\s*1\s*;/)]);`

10. **console/src/menu-movil.test.ts — `el menú de móvil de la consola` (5 tests)**
    Cinco tests lectores de `styles.css`. Verifican reglas CSS concretas con CONTROL NEGATIVO por mutación.
    - `console/src/menu-movil.test.ts:136` → `expect(defectosDelMenuMovil(GLOBAL)).toEqual([]);`

11. **console/src/features/config/config-css-toggles.test.ts — `el tope de medida de /config` y otros (13 tests)**
    Trece tests lectores de `styles.css` y `toggles.css`. Verifican selectores y valores concretos; el control negativo por mutación existe pero todos comparten el mismo `defectosXxx()` como punto de entrada.
    - `console/src/features/config/config-css-toggles.test.ts:64` → `expect(ancho, '.config-pagina no declara max-width').toBeDefined();`

12. **console/src/features/config/config-css.test.ts — `las pastillas de estado en modo claro` (19 tests)**
    Diecinueve tests lectores de `styles.css`. Verifican contraste WCAG calculado sobre tokens; con dientes — si la paleta cambia, los ratios rompen — pero sin render real.
    - `console/src/features/config/config-css.test.ts:106` → `expect(contraste(texto!, resolver(fondo.startsWith('#') ? fondo : \`var(${fondo})\`, vars))).toBeGreaterThanOrEqual(4.5);`

## Skips

`grep -E '\b(it|test)\.skip|\b(xit|xtest)\(|test\.todo|\bdescribe\.skip|\bif\s*\(.+process\.env'` sobre `console/**/*.test.ts(x)` no devuelve resultados. Tampoco hay guardas de entorno que deshabiliten tests dentro de los bloques. **No hay skips** en este lote.

## Resumen

- 114 ficheros de test, 1158 bloques `it/test` declarados en fuente (la cuenta en runtime es mayor por los `it.each`).
- 1158 tests con dientes, 0 sin dientes, 0 skips, 0 tautológicos.
- El lote entero pasa el filtro (a) sin excepciones claras: incluso los "peores" verifican un efecto real (contenido de fichero CSS o valor de función pura), no meras constantes entre sí ni llamadas a mocks sin argumentos.