# P14 — líneas exactas a borrar (lista ejecutable, verificada línea a línea)

Para borrar por número **sin volver a leer el fichero**. Cada entrada es `ruta:inicio-fin · clase · nº de líneas · «primera palabra»`; el rango es cerrado, inclusivo, y contiene solo líneas de comentario. Dentro de cada fichero, **borra de abajo hacia arriba** para que los números no se desplacen.

## Antes de borrar: comprueba el blob

Cada fichero de esta lista lleva su `git hash-object` del momento en que se verificó. **Si el hash no coincide, el fichero cambió y sus números están desplazados** — hay que reverificar ese fichero, no borrar a ciegas. Esto no es una precaución teórica: mientras se producía esta lista, otra instancia estaba editando `packages/protocol/src/schemas.ts` sin commitear y partiendo `services/gateway/src/routes/console.ts` (611 líneas → 430 + cuatro módulos nuevos). Seis entradas de `schemas.ts` y una de `console.ts` cayeron por eso.

```sh
# comprobar todos los blobs de la lista de golpe
grep -oE 'blob `[0-9a-f]{12}`' ordenes/reportes/minimax-lineas-p14.md | wc -l   # nº de ficheros
# y por fichero, antes de tocarlo:
git hash-object <ruta> | cut -c1-12
```

## Cómo se produjo, y por qué se puede confiar en los números

Cuatro subagentes leyeron por zonas disjuntas (parciales `_parcial-p14-*.md`, que traen además el «por qué» de cada decisión y una sección CONSERVAR EXPLÍCITAMENTE por fichero). **Después las 184 entradas propuestas pasaron por un verificador mecánico** que marca cada carácter del fichero como comentario / string / código y rechaza el rango si contiene una sola línea con código, si cae fuera del fichero, o si no tiene texto. Resultado:

- **176 verificadas** (516 líneas en 50 ficheros).
- **11 con el rango desplazado**, corregidas y marcadas `[rango corregido]` en la lista. Siete eran el mismo error en `ops/tests/test_container_runtime_zombies.py`: el rango incluía la línea `def ...` anterior al docstring. **Borradas a ciegas habrían roto el fichero.**
- **8 rechazadas** (abajo).

El verificador, para poder repetirlo:

```sh
# por cada entrada `ruta:a-b`, ninguna línea del rango debe tener código:
sed -n 'a,bp' ruta | grep -vE '^\s*($|//|/\*|\*|\{/\*|#|""")'   # debe salir vacío
```

## El censo original está caducado: 2.322 → 516

El total de `claude-censo-comentarios-basura.md:3` (2.322 líneas borrables) **ya no describe el árbol**. Releyendo hoy fichero por fichero quedan **516 líneas en 50 ficheros**. Tres causas, todas verificables:

1. Los tres commits de limpieza ya ejecutados (`901411f` −215, `802d323` −248, `6f7720a` −51) más los de la ronda en curso (`e25b7fe` −242 consola, `e8cc412` −46 gateway, `f4f05e3` −37 telegram-bridge).
2. **Ficheros que se partieron y dejaron de existir tal como los censó.** El caso extremo es `packages/store/src/repository/deliveries.ts`, al que el censo daba 294 líneas de comentario y 118 borrables — incluidas las etiquetas huérfanas `// S1`…`// S6`, que eran *la* evidencia dura de mutilación mecánica:

```
$ wc -l packages/store/src/repository/deliveries.ts packages/store/src/repository/outbox.ts
   27 packages/store/src/repository/deliveries.ts
   17 packages/store/src/repository/outbox.ts
$ grep -c 'S1\|S2' packages/store/src/repository/deliveries.ts
0
```

Hoy son barriles de re-export sin un solo comentario. Igual `console/src/api/types.ts`, `packages/adapter-sdk/src/harnesses/shared.ts` y `console/src/mocks/data.ts`.

3. **La prohibición estrella del plan apunta a un fantasma.** `plan-reestructura/plano-objetivo.md:555` prohíbe tocar «los comentarios `--` dentro del template literal SQL de fanin.ts:987-991». `packages/store/src/repository/agents/fanin.ts` tiene **289 líneas y cero comentarios `--` dentro de template literals** en todo el fichero. La regla general sigue siendo correcta; su ejemplo concreto ya no existe y conviene quitarlo del plan para que nadie busque lo que no está.

## Reparto por clase

| clase | líneas | qué es |
|---|---:|---|
| narrativo | 280 | historia, incidente, fecha, cifra medida un día concreto, cita de persona. Es la contaminación que las sesiones frescas leen como estado ACTUAL del sistema. |
| ceremonial | 221 | JSDoc y divisores que repiten el nombre de la función o del campo. Concentrado en los ficheros de perfil de agente. |
| mutilado | 15 | fragmentos que dejó la limpieza mecánica: `**` de negrita huérfano, frase que arranca sin sujeto. Solo 3 ficheros (`cuerpo-del-mensaje.ts:7`, `licenses.ts:1-7`, `AgentDrawer.tsx:57-63`), muy por debajo de los «15-17 fragmentos en 15 ficheros» que estimaba el censo. |

Dos correcciones al censo que conviene saber antes de borrar:

- **La zona de servicios entrega 13 líneas, no ~192.** Es invariante de alta calidad casi por completo; 21 de sus 34 ficheros quedan a cero. Aquí un falso positivo borra un invariante de seguridad.
- **`db.ts`, `messages.ts`, `notifications.ts` y `publish-receipt.ts` quedan a cero** pese a que el censo les daba 10, 15, 12 y 8 líneas: son quirks reales del driver `pg`, contratos de idempotencia y un motor default-deny numerado. No se tocan.

## Las 8 rechazadas por el verificador (NO borrar)

- `packages/protocol/src/schemas.ts:66-66` · CÓDIGO en el rango → 66: export function clampToRoleBriefLimit(text: string): st
- `packages/protocol/src/schemas.ts:128-128` · CÓDIGO en el rango → 128: });
- `packages/protocol/src/schemas.ts:198-198` · CÓDIGO en el rango → 198: path: ['timeout_ms'],
- `packages/protocol/src/schemas.ts:243-246` · CÓDIGO en el rango → 243: export const SYSTEM_PRINCIPAL_ALIASES = ['gate-probe', 
- `packages/protocol/src/schemas.ts:283-283` · CÓDIGO en el rango → 283: message: 'reserved internal message types cannot be pub
- `packages/protocol/src/schemas.ts:536-540` · CÓDIGO en el rango → 536: max_edge_repeats_per_root: z.number().int().min(1).max(
- `packages/store/src/configuration.ts:297-297` · rango sin texto (líneas en blanco)
- `services/gateway/src/routes/console.ts:611-614` · rango fuera del fichero (430 líneas hoy)
Seis de las ocho son de `packages/protocol/src/schemas.ts`, que tiene modificaciones sin commitear de otra instancia en este momento: sus números están desplazados y el fichero necesita una segunda pasada cuando esa instancia cierre. `services/gateway/src/routes/console.ts` se partió en `routes/console/{contracts,early,helpers,phase4}.ts` y pasó de 611 a 430 líneas.

## Resumen por fichero

| fichero | blob | líneas | narrativo | mutilado | ceremonial |
|---|---|---:|---:|---:|---:|
| `console/src/mocks/handlers.ts` | `87fdaeef8840` | 44 | 44 | 0 | 0 |
| `ops/tests/test_container_runtime_zombies.py` | `b996d617656d` | 42 | 0 | 0 | 42 |
| `console/src/features/messages/ConversationPane.tsx` | `dc0d656adde3` | 40 | 40 | 0 | 0 |
| `console/src/features/messages/roster.ts` | `af301168b1dd` | 34 | 34 | 0 | 0 |
| `packages/store/src/agent-profile.ts` | `812d3c10f47d` | 32 | 0 | 0 | 32 |
| `console/src/features/queues/DeliveryTable.tsx` | `322921ae6288` | 30 | 30 | 0 | 0 |
| `packages/protocol/src/agent-profile.ts` | `787fdc151223` | 28 | 0 | 0 | 28 |
| `console/src/features/config/CollectionTable.tsx` | `d9d1e8fbe877` | 24 | 24 | 0 | 0 |
| `packages/protocol/src/ficheros-del-arnes.ts` | `07e5cfd1bddd` | 20 | 0 | 0 | 20 |
| `packages/store/src/accounts.ts` | `0dd0eb77e028` | 15 | 0 | 0 | 15 |
| `console/src/features/landing/LandingPage.tsx` | `17a0bf37929c` | 15 | 13 | 0 | 2 |
| `packages/store/src/repository/quotas.ts` | `c11af935cd85` | 14 | 14 | 0 | 0 |
| `console/src/features/live/LiveHypergraph.tsx` | `057a95661829` | 14 | 14 | 0 | 0 |
| `packages/protocol/src/marcas-de-bloque.ts` | `2399b29df7e7` | 10 | 0 | 0 | 10 |
| `packages/adapter-sdk/src/sdk/engine.ts` | `fd59f0e8f389` | 10 | 10 | 0 | 0 |
| `console/src/styles.tipografia.test.ts` | `50f55907d88b` | 9 | 0 | 0 | 9 |
| `console/src/features/config/areas.test.ts` | `98edfb68cc6d` | 8 | 0 | 0 | 8 |
| `console/src/features/live/directiva.ts` | `9cb3ade4b684` | 8 | 8 | 0 | 0 |
| `console/src/features/messages/messages-css.test.ts` | `11843daf86fd` | 7 | 7 | 0 | 0 |
| `console/src/features/accounts/licenses.ts` | `a1c263b55c51` | 7 | 0 | 7 | 0 |
| `console/src/features/config/ConfigPage.tsx` | `c6ae769b5c7e` | 7 | 7 | 0 | 0 |
| `console/src/features/landing/landing.ts` | `b79167c9ada9` | 7 | 7 | 0 | 0 |
| `console/src/features/live/AgentDrawer.tsx` | `4a81717beca3` | 7 | 0 | 7 | 0 |
| `console/src/features/terminal/cuerpo-del-mensaje.ts` | `6b4747ff1ae6` | 7 | 6 | 1 | 0 |
| `console/src/styles.tipografia-montada.test.tsx` | `787570c39afc` | 6 | 0 | 0 | 6 |
| `packages/store/src/repository/deliveries/control.ts` | `57d8330640dd` | 5 | 0 | 0 | 5 |
| `services/gateway/src/console/types-agent-directive.ts` | `a5552f83e726` | 5 | 0 | 0 | 5 |
| `services/telegram-bridge/src/markdown.ts` | `c75a935e2f1c` | 5 | 0 | 0 | 5 |
| `console/src/features/config/campos-inertes.test.ts` | `1b373a776904` | 5 | 5 | 0 | 0 |
| `console/src/features/live/ficheros-legibilidad.test.ts` | `be3ba119983e` | 5 | 4 | 0 | 1 |
| `console/src/features/live/perfil.ts` | `8e81715b5f58` | 4 | 4 | 0 | 0 |
| `console/src/features/terminal/fleet.ts` | `4cd3636200b8` | 4 | 4 | 0 | 0 |
| `services/gateway/src/console/agent-directive.routes.ts` | `b68d110da66b` | 3 | 0 | 0 | 3 |
| `services/telegram-bridge/src/artifacts.ts` | `c4a3dfa6d127` | 3 | 0 | 0 | 3 |
| `services/telegram-bridge/src/redaction.ts` | `a9f95482eb8e` | 3 | 0 | 0 | 3 |
| `services/telegram-bridge/src/untrusted.ts` | `44652e50e397` | 3 | 0 | 0 | 3 |
| `console/src/features/live/LiveFleetPage.sin-salida.test.tsx` | `c0e7a9286b26` | 3 | 0 | 0 | 3 |
| `console/src/features/live/tira-de-pestanas.test.ts` | `4357eb4401bd` | 3 | 0 | 0 | 3 |
| `console/src/api/client.ts` | `c45a22ef6a59` | 3 | 0 | 0 | 3 |
| `console/src/features/live/agent-state.ts` | `2699b6134454` | 3 | 2 | 0 | 1 |
| `services/gateway/src/console/sonda-compartida.ts` | `cddb7633a3e1` | 2 | 0 | 0 | 2 |
| `console/src/vocabulario.test.tsx` | `d70abc87c3d6` | 2 | 0 | 0 | 2 |
| `console/src/features/config/collection-table.ts` | `a8ed80c4eb68` | 2 | 2 | 0 | 0 |
| `console/src/features/live/LiveFleetPage.tsx` | `fddf19d54f92` | 2 | 0 | 0 | 2 |
| `packages/protocol/src/schemas.ts` | `106fd290b6c6` | 1 | 0 | 0 | 1 |
| `console/src/api/client.timeout.test.ts` | `dab0379b8cd3` | 1 | 0 | 0 | 1 |
| `console/src/api/use-resource.fallo-visible.test.tsx` | `0c3eecbe10b1` | 1 | 0 | 0 | 1 |
| `console/src/features/landing/LandingPage.permisos.test.tsx` | `4fffe164c258` | 1 | 1 | 0 | 0 |
| `console/src/features/queues/colas-puras.test.ts` | `03c12e6d5f41` | 1 | 0 | 0 | 1 |
| `console/src/features/terminal/densidad-observacion.test.tsx` | `fd1e54bf8aa0` | 1 | 0 | 0 | 1 |
| **TOTAL (50 ficheros)** | | **516** | **280** | **15** | **221** |

## Lista ejecutable


## store + protocol

### `packages/protocol/src/agent-profile.ts` — 28 líneas en 24 rangos · blob `787fdc151223`

- `packages/protocol/src/agent-profile.ts:12-12` · ceremonial · 1 línea · «Largo»
- `packages/protocol/src/agent-profile.ts:17-17` · ceremonial · 1 línea · «Longitud»
- `packages/protocol/src/agent-profile.ts:22-22` · ceremonial · 1 línea · «Límites»
- `packages/protocol/src/agent-profile.ts:24-24` · ceremonial · 1 línea · «Identidad»
- `packages/protocol/src/agent-profile.ts:26-26` · ceremonial · 1 línea · «Rol»
- `packages/protocol/src/agent-profile.ts:28-28` · ceremonial · 1 línea · «Instrucciones»
- `packages/protocol/src/agent-profile.ts:50-50` · ceremonial · 1 línea · «Perfil»
- `packages/protocol/src/agent-profile.ts:66-66` · ceremonial · 1 línea · «Error»
- `packages/protocol/src/agent-profile.ts:81-81` · ceremonial · 1 línea · «Normaliza»
- `packages/protocol/src/agent-profile.ts:99-99` · ceremonial · 1 línea · «Normaliza»
- `packages/protocol/src/agent-profile.ts:130-130` · ceremonial · 1 línea · «Calcula»
- `packages/protocol/src/agent-profile.ts:142-142` · ceremonial · 1 línea · «Valida»
- `packages/protocol/src/agent-profile.ts:165-165` · ceremonial · 1 línea · «Crea»
- `packages/protocol/src/agent-profile.ts:205-205` · ceremonial · 1 línea · «Cuotas»
- `packages/protocol/src/agent-profile.ts:213-213` · ceremonial · 1 línea · «Configuración»
- `packages/protocol/src/agent-profile.ts:221-221` · ceremonial · 1 línea · «Hechos»
- `packages/protocol/src/agent-profile.ts:230-230` · ceremonial · 1 línea · «Contexto»
- `packages/protocol/src/agent-profile.ts:236-237` · ceremonial · 2 líneas · «──»
- `packages/protocol/src/agent-profile.ts:238-238` · ceremonial · 1 línea · «Renderiza»
- `packages/protocol/src/agent-profile.ts:243-243` · ceremonial · 1 línea · «Renderiza»
- `packages/protocol/src/agent-profile.ts:249-249` · ceremonial · 1 línea · «Renderiza»
- `packages/protocol/src/agent-profile.ts:260-260` · ceremonial · 1 línea · «Renderiza»
- `packages/protocol/src/agent-profile.ts:271-271` · ceremonial · 1 línea · «Renderiza»
- `packages/protocol/src/agent-profile.ts:283-286` · ceremonial · 4 líneas · «Compone»

### `packages/protocol/src/ficheros-del-arnes.ts` — 20 líneas en 13 rangos · blob `07e5cfd1bddd`

- `packages/protocol/src/ficheros-del-arnes.ts:10-11` · ceremonial · 2 líneas · «MEMORY»
- `packages/protocol/src/ficheros-del-arnes.ts:14-15` · ceremonial · 2 líneas · «──»
- `packages/protocol/src/ficheros-del-arnes.ts:24-24` · ceremonial · 1 línea · «Error»
- `packages/protocol/src/ficheros-del-arnes.ts:40-41` · ceremonial · 2 líneas · «──»
- `packages/protocol/src/ficheros-del-arnes.ts:66-67` · ceremonial · 2 líneas · «──»
- `packages/protocol/src/ficheros-del-arnes.ts:100-100` · ceremonial · 1 línea · «MEMORY»
- `packages/protocol/src/ficheros-del-arnes.ts:132-135` · ceremonial · 4 líneas · «Ficheros»
- `packages/protocol/src/ficheros-del-arnes.ts:147-147` · ceremonial · 1 línea · «MEMORY»
- `packages/protocol/src/ficheros-del-arnes.ts:157-157` · ceremonial · 1 línea · «El»
- `packages/protocol/src/ficheros-del-arnes.ts:163-163` · ceremonial · 1 línea · «Si»
- `packages/protocol/src/ficheros-del-arnes.ts:204-204` · ceremonial · 1 línea · «El»
- `packages/protocol/src/ficheros-del-arnes.ts:209-209` · ceremonial · 1 línea · «Comprueba»
- `packages/protocol/src/ficheros-del-arnes.ts:220-220` · ceremonial · 1 línea · «Valida»

### `packages/protocol/src/marcas-de-bloque.ts` — 10 líneas en 10 rangos · blob `2399b29df7e7`

- `packages/protocol/src/marcas-de-bloque.ts:6-6` · ceremonial · 1 línea · «Versión»
- `packages/protocol/src/marcas-de-bloque.ts:13-13` · ceremonial · 1 línea · «Versión»
- `packages/protocol/src/marcas-de-bloque.ts:40-40` · ceremonial · 1 línea · «Extrae»
- `packages/protocol/src/marcas-de-bloque.ts:49-49` · ceremonial · 1 línea · «Inserta»
- `packages/protocol/src/marcas-de-bloque.ts:62-62` · ceremonial · 1 línea · «El»
- `packages/protocol/src/marcas-de-bloque.ts:67-67` · ceremonial · 1 línea · «Inserta»
- `packages/protocol/src/marcas-de-bloque.ts:72-72` · ceremonial · 1 línea · «El»
- `packages/protocol/src/marcas-de-bloque.ts:77-77` · ceremonial · 1 línea · «Inserta»
- `packages/protocol/src/marcas-de-bloque.ts:82-82` · ceremonial · 1 línea · «Quita»
- `packages/protocol/src/marcas-de-bloque.ts:94-94` · ceremonial · 1 línea · «Devuelve»

### `packages/protocol/src/schemas.ts` — 1 líneas en 1 rangos · blob `106fd290b6c6`

- `packages/protocol/src/schemas.ts:162-162` · ceremonial · 1 línea · «}»

### `packages/store/src/accounts.ts` — 15 líneas en 5 rangos · blob `0dd0eb77e028`

- `packages/store/src/accounts.ts:1-5` · ceremonial · 5 líneas · «Selector»
- `packages/store/src/accounts.ts:66-66` · ceremonial · 1 línea · «Fila»
- `packages/store/src/accounts.ts:85-87` · ceremonial · 3 líneas · «Consulta»
- `packages/store/src/accounts.ts:120-122` · ceremonial · 3 líneas · «Actualiza»
- `packages/store/src/accounts.ts:140-142` · ceremonial · 3 líneas · «Selecciona»

### `packages/store/src/agent-profile.ts` — 32 líneas en 11 rangos · blob `812d3c10f47d`

- `packages/store/src/agent-profile.ts:9-12` · ceremonial · 4 líneas · «Repositorio»
- `packages/store/src/agent-profile.ts:31-33` · ceremonial · 3 líneas · «Representa»
- `packages/store/src/agent-profile.ts:65-65` · ceremonial · 1 línea · «Fallo»
- `packages/store/src/agent-profile.ts:95-97` · ceremonial · 3 líneas · «Convierte»
- `packages/store/src/agent-profile.ts:150-152` · ceremonial · 3 líneas · «Normaliza»
- `packages/store/src/agent-profile.ts:158-160` · ceremonial · 3 líneas · «Reemplazo»
- `packages/store/src/agent-profile.ts:334-336` · ceremonial · 3 líneas · «Elimina»
- `packages/store/src/agent-profile.ts:344-346` · ceremonial · 3 líneas · «Obtiene»
- `packages/store/src/agent-profile.ts:422-424` · ceremonial · 3 líneas · «Consulta»
- `packages/store/src/agent-profile.ts:437-439` · ceremonial · 3 líneas · «Consulta»
- `packages/store/src/agent-profile.ts:460-462` · ceremonial · 3 líneas · «Consulta»

### `packages/store/src/repository/deliveries/control.ts` — 5 líneas en 1 rangos · blob `57d8330640dd`

- `packages/store/src/repository/deliveries/control.ts:37-41` · ceremonial · 5 líneas · «Proporciona»

### `packages/store/src/repository/quotas.ts` — 14 líneas en 2 rangos · blob `c11af935cd85`

- `packages/store/src/repository/quotas.ts:489-498` · narrativo · 10 líneas · «Decía»
- `packages/store/src/repository/quotas.ts:499-502` · narrativo · 4 líneas · «El»

## services

### `services/gateway/src/console/agent-directive.routes.ts` — 3 líneas en 3 rangos · blob `b68d110da66b`

- `services/gateway/src/console/agent-directive.routes.ts:155-155` · ceremonial · 1 línea · «1»
- `services/gateway/src/console/agent-directive.routes.ts:167-167` · ceremonial · 1 línea · «2»
- `services/gateway/src/console/agent-directive.routes.ts:186-186` · ceremonial · 1 línea · «3»

### `services/gateway/src/console/sonda-compartida.ts` — 2 líneas en 2 rangos · blob `cddb7633a3e1`

- `services/gateway/src/console/sonda-compartida.ts:54-54` · ceremonial · 1 línea · «Registra»
- `services/gateway/src/console/sonda-compartida.ts:59-59` · ceremonial · 1 línea · «Obtiene»

### `services/gateway/src/console/types-agent-directive.ts` — 5 líneas en 1 rangos · blob `a5552f83e726`

- `services/gateway/src/console/types-agent-directive.ts:1-5` · ceremonial · 5 líneas · «Tipos»

### `services/telegram-bridge/src/artifacts.ts` — 3 líneas en 1 rangos · blob `c4a3dfa6d127`

- `services/telegram-bridge/src/artifacts.ts:4-6` · ceremonial · 3 líneas · «Planificación»

### `services/telegram-bridge/src/markdown.ts` — 5 líneas en 3 rangos · blob `c75a935e2f1c`

- `services/telegram-bridge/src/markdown.ts:1-3` · ceremonial · 3 líneas · «Conversión»
- `services/telegram-bridge/src/markdown.ts:70-70` · ceremonial · 1 línea · «3»
- `services/telegram-bridge/src/markdown.ts:96-96` · ceremonial · 1 línea · «10»

### `services/telegram-bridge/src/redaction.ts` — 3 líneas en 1 rangos · blob `a9f95482eb8e`

- `services/telegram-bridge/src/redaction.ts:1-3` · ceremonial · 3 líneas · «Redacción»

### `services/telegram-bridge/src/untrusted.ts` — 3 líneas en 1 rangos · blob `44652e50e397`

- `services/telegram-bridge/src/untrusted.ts:1-3` · ceremonial · 3 líneas · «Saneo»

## consola (tests)

### `console/src/api/client.timeout.test.ts` — 1 líneas en 1 rangos · blob `dab0379b8cd3`

- `console/src/api/client.timeout.test.ts:8-8` · ceremonial · 1 línea · «Simula»

### `console/src/api/use-resource.fallo-visible.test.tsx` — 1 líneas en 1 rangos · blob `0c3eecbe10b1`

- `console/src/api/use-resource.fallo-visible.test.tsx:12-12` · ceremonial · 1 línea · «Un»

### `console/src/features/config/areas.test.ts` — 8 líneas en 3 rangos · blob `98edfb68cc6d`

- `console/src/features/config/areas.test.ts:41-41` · ceremonial · 1 línea · «Regla»
- `console/src/features/config/areas.test.ts:96-98` · ceremonial · 3 líneas · «Verifica»
- `console/src/features/config/areas.test.ts:108-111` · ceremonial · 4 líneas · «Verifica»

### `console/src/features/config/campos-inertes.test.ts` — 5 líneas en 1 rangos · blob `1b373a776904`

- `console/src/features/config/campos-inertes.test.ts:113-117` · narrativo · 5 líneas · «MEDIDO»

### `console/src/features/landing/LandingPage.permisos.test.tsx` — 1 líneas en 1 rangos · blob `4fffe164c258`

- `console/src/features/landing/LandingPage.permisos.test.tsx:58-58` · narrativo · 1 línea · «Y»

### `console/src/features/live/LiveFleetPage.sin-salida.test.tsx` — 3 líneas en 3 rangos · blob `c0e7a9286b26`

- `console/src/features/live/LiveFleetPage.sin-salida.test.tsx:14-14` · ceremonial · 1 línea · «Simula»
- `console/src/features/live/LiveFleetPage.sin-salida.test.tsx:19-19` · ceremonial · 1 línea · «La»
- `console/src/features/live/LiveFleetPage.sin-salida.test.tsx:73-73` · ceremonial · 1 línea · «Indica»

### `console/src/features/live/ficheros-legibilidad.test.ts` — 5 líneas en 2 rangos · blob `be3ba119983e`

- `console/src/features/live/ficheros-legibilidad.test.ts:8-11` · narrativo · 4 líneas · «Esto»
- `console/src/features/live/ficheros-legibilidad.test.ts:33-33` · ceremonial · 1 línea · «Devuelve»

### `console/src/features/live/tira-de-pestanas.test.ts` — 3 líneas en 3 rangos · blob `4357eb4401bd`

- `console/src/features/live/tira-de-pestanas.test.ts:42-42` · ceremonial · 1 línea · «Contención»
- `console/src/features/live/tira-de-pestanas.test.ts:54-54` · ceremonial · 1 línea · «Evita»
- `console/src/features/live/tira-de-pestanas.test.ts:60-60` · ceremonial · 1 línea · «Ancho»

### `console/src/features/messages/messages-css.test.ts` — 7 líneas en 1 rangos · blob `11843daf86fd`

- `console/src/features/messages/messages-css.test.ts:8-14` · narrativo · 7 líneas · «Este»

### `console/src/features/queues/colas-puras.test.ts` — 1 líneas en 1 rangos · blob `03c12e6d5f41`

- `console/src/features/queues/colas-puras.test.ts:91-91` · ceremonial · 1 línea · « LA VISTA EN»

### `console/src/features/terminal/densidad-observacion.test.tsx` — 1 líneas en 1 rangos · blob `fd1e54bf8aa0`

- `console/src/features/terminal/densidad-observacion.test.tsx:109-109` · ceremonial · 1 línea · «El»

### `console/src/styles.tipografia-montada.test.tsx` — 6 líneas en 4 rangos · blob `787570c39afc`

- `console/src/styles.tipografia-montada.test.tsx:26-26` · ceremonial · 1 línea · «Los»
- `console/src/styles.tipografia-montada.test.tsx:45-45` · ceremonial · 1 línea · «Texto»
- `console/src/styles.tipografia-montada.test.tsx:114-114` · ceremonial · 1 línea · «Los»
- `console/src/styles.tipografia-montada.test.tsx:133-135` · ceremonial · 3 líneas · «Las»

### `console/src/styles.tipografia.test.ts` — 9 líneas en 9 rangos · blob `50f55907d88b`

- `console/src/styles.tipografia.test.ts:20-20` · ceremonial · 1 línea · «Hojas»
- `console/src/styles.tipografia.test.ts:34-34` · ceremonial · 1 línea · « lectura de »
- `console/src/styles.tipografia.test.ts:41-41` · ceremonial · 1 línea · «Todas»
- `console/src/styles.tipografia.test.ts:66-66` · ceremonial · 1 línea · «14px»
- `console/src/styles.tipografia.test.ts:139-139` · ceremonial · 1 línea · «═══»
- `console/src/styles.tipografia.test.ts:168-168` · ceremonial · 1 línea · «═══»
- `console/src/styles.tipografia.test.ts:227-227` · ceremonial · 1 línea · «═══»
- `console/src/styles.tipografia.test.ts:274-274` · ceremonial · 1 línea · «Elementos»
- `console/src/styles.tipografia.test.ts:294-294` · ceremonial · 1 línea · «═══»

### `console/src/vocabulario.test.tsx` — 2 líneas en 2 rangos · blob `d70abc87c3d6`

- `console/src/vocabulario.test.tsx:18-18` · ceremonial · 1 línea · «Las»
- `console/src/vocabulario.test.tsx:37-37` · ceremonial · 1 línea · «Una»

## consola + adapter-sdk (fuente)

### `console/src/api/client.ts` — 3 líneas en 3 rangos · blob `c45a22ef6a59`

- `console/src/api/client.ts:161-161` · ceremonial · 1 línea · «System»
- `console/src/api/client.ts:228-228` · ceremonial · 1 línea · «Messaging»
- `console/src/api/client.ts:273-273` · ceremonial · 1 línea · «Agent»

### `console/src/features/accounts/licenses.ts` — 7 líneas en 1 rangos · blob `a1c263b55c51`

- `console/src/features/accounts/licenses.ts:1-7` · mutilado · 7 líneas · «Lecturas»

### `console/src/features/config/CollectionTable.tsx` — 24 líneas en 1 rangos · blob `d9d1e8fbe877`

- `console/src/features/config/CollectionTable.tsx:243-266` · narrativo · 24 líneas · «Confirmación»

### `console/src/features/config/ConfigPage.tsx` — 7 líneas en 2 rangos · blob `c6ae769b5c7e`

- `console/src/features/config/ConfigPage.tsx:424-427` · narrativo · 4 líneas · «UN»
- `console/src/features/config/ConfigPage.tsx:485-487` · narrativo · 3 líneas · «Alta»

### `console/src/features/config/collection-table.ts` — 2 líneas en 1 rangos · blob `a8ed80c4eb68`

- `console/src/features/config/collection-table.ts:118-119` · narrativo · 2 líneas · «La»

### `console/src/features/landing/LandingPage.tsx` — 15 líneas en 3 rangos · blob `17a0bf37929c`

- `console/src/features/landing/LandingPage.tsx:13-16` · narrativo · 4 líneas · «Nace»
- `console/src/features/landing/LandingPage.tsx:30-31` · ceremonial · 2 líneas · «Los»
- `console/src/features/landing/LandingPage.tsx:152-160` · narrativo · 9 líneas · «Acá»

### `console/src/features/landing/landing.ts` — 7 líneas en 1 rangos · blob `b79167c9ada9`

- `console/src/features/landing/landing.ts:108-114` · narrativo · 7 líneas · «Trabado»

### `console/src/features/live/AgentDrawer.tsx` — 7 líneas en 1 rangos · blob `4a81717beca3`

- `console/src/features/live/AgentDrawer.tsx:57-63` · mutilado · 7 líneas · «Ficheros»

### `console/src/features/live/LiveFleetPage.tsx` — 2 líneas en 2 rangos · blob `fddf19d54f92`

- `console/src/features/live/LiveFleetPage.tsx:68-68` · ceremonial · 1 línea · « Estado del »
- `console/src/features/live/LiveFleetPage.tsx:115-115` · ceremonial · 1 línea · « Acotamiento»

### `console/src/features/live/LiveHypergraph.tsx` — 14 líneas en 4 rangos · blob `057a95661829`

- `console/src/features/live/LiveHypergraph.tsx:36-38` · narrativo · 3 líneas · « un alias qu»
- `console/src/features/live/LiveHypergraph.tsx:223-225` · narrativo · 3 líneas · «Tres» · **[rango corregido: el parcial decía 222-225]**
- `console/src/features/live/LiveHypergraph.tsx:257-261` · narrativo · 5 líneas · «Antes»
- `console/src/features/live/LiveHypergraph.tsx:378-380` · narrativo · 3 líneas · «Antes»

### `console/src/features/live/agent-state.ts` — 3 líneas en 2 rangos · blob `2699b6134454`

- `console/src/features/live/agent-state.ts:294-295` · narrativo · 2 líneas · «Si»
- `console/src/features/live/agent-state.ts:347-347` · ceremonial · 1 línea · «Re-export»

### `console/src/features/live/directiva.ts` — 8 líneas en 1 rangos · blob `9cb3ade4b684`

- `console/src/features/live/directiva.ts:26-33` · narrativo · 8 líneas · «Los»

### `console/src/features/live/perfil.ts` — 4 líneas en 1 rangos · blob `8e81715b5f58`

- `console/src/features/live/perfil.ts:27-30` · narrativo · 4 líneas · «Postgres»

### `console/src/features/messages/ConversationPane.tsx` — 40 líneas en 5 rangos · blob `dc0d656adde3`

- `console/src/features/messages/ConversationPane.tsx:296-302` · narrativo · 7 líneas · «El»
- `console/src/features/messages/ConversationPane.tsx:304-310` · narrativo · 7 líneas · «El» · **[rango corregido: el parcial decía 304-310]**
- `console/src/features/messages/ConversationPane.tsx:343-352` · narrativo · 10 líneas · «EL»
- `console/src/features/messages/ConversationPane.tsx:354-364` · narrativo · 11 líneas · «EL»
- `console/src/features/messages/ConversationPane.tsx:383-387` · narrativo · 5 líneas · «EL»

### `console/src/features/messages/roster.ts` — 34 líneas en 1 rangos · blob `af301168b1dd`

- `console/src/features/messages/roster.ts:23-56` · narrativo · 34 líneas · «EL»

### `console/src/features/queues/DeliveryTable.tsx` — 30 líneas en 6 rangos · blob `322921ae6288`

- `console/src/features/queues/DeliveryTable.tsx:11-13` · narrativo · 3 líneas · «Los»
- `console/src/features/queues/DeliveryTable.tsx:42-44` · narrativo · 3 líneas · «Los»
- `console/src/features/queues/DeliveryTable.tsx:49-56` · narrativo · 8 líneas · «QUÉ»
- `console/src/features/queues/DeliveryTable.tsx:114-120` · narrativo · 7 líneas · «Ninguna»
- `console/src/features/queues/DeliveryTable.tsx:176-177` · narrativo · 2 líneas · «Se» · **[rango corregido: el parcial decía 175-177]**
- `console/src/features/queues/DeliveryTable.tsx:268-274` · narrativo · 7 líneas · «Sin»

### `console/src/features/terminal/cuerpo-del-mensaje.ts` — 7 líneas en 3 rangos · blob `6b4747ff1ae6`

- `console/src/features/terminal/cuerpo-del-mensaje.ts:7-7` · mutilado · 1 línea · «100»
- `console/src/features/terminal/cuerpo-del-mensaje.ts:8-11` · narrativo · 4 líneas · «leía»
- `console/src/features/terminal/cuerpo-del-mensaje.ts:13-14` · narrativo · 2 líneas · «O» · **[rango corregido: el parcial decía 13-14]**

### `console/src/features/terminal/fleet.ts` — 4 líneas en 1 rangos · blob `4cd3636200b8`

- `console/src/features/terminal/fleet.ts:36-39` · narrativo · 4 líneas · «TenantSchema»

### `console/src/mocks/handlers.ts` — 44 líneas en 5 rangos · blob `87fdaeef8840`

- `console/src/mocks/handlers.ts:152-159` · narrativo · 8 líneas · «Las»
- `console/src/mocks/handlers.ts:161-168` · narrativo · 8 líneas · «LOS»
- `console/src/mocks/handlers.ts:169-173` · narrativo · 5 líneas · «EL»
- `console/src/mocks/handlers.ts:303-317` · narrativo · 15 líneas · «LAS»
- `console/src/mocks/handlers.ts:357-364` · narrativo · 8 líneas · «El»

### `packages/adapter-sdk/src/sdk/engine.ts` — 10 líneas en 2 rangos · blob `fd59f0e8f389`

- `packages/adapter-sdk/src/sdk/engine.ts:218-223` · narrativo · 6 líneas · «Un»
- `packages/adapter-sdk/src/sdk/engine.ts:256-259` · narrativo · 4 líneas · «A»

## ops

### `ops/tests/test_container_runtime_zombies.py` — 42 líneas en 18 rangos · blob `b996d617656d`

- `ops/tests/test_container_runtime_zombies.py:2-9` · ceremonial · 8 líneas · «Regression» · **[rango corregido: el parcial decía 1-9]**
- `ops/tests/test_container_runtime_zombies.py:19-19` · ceremonial · 1 línea · «Count» · **[rango corregido: el parcial decía 18-19]**
- `ops/tests/test_container_runtime_zombies.py:32-32` · ceremonial · 1 línea · «Reap» · **[rango corregido: el parcial decía 31-32]**
- `ops/tests/test_container_runtime_zombies.py:43-46` · ceremonial · 4 líneas · «Test» · **[rango corregido: el parcial decía 42-46]**
- `ops/tests/test_container_runtime_zombies.py:47-47` · ceremonial · 1 línea · «Create»
- `ops/tests/test_container_runtime_zombies.py:54-54` · ceremonial · 1 línea · «Don't»
- `ops/tests/test_container_runtime_zombies.py:83-86` · ceremonial · 4 líneas · «Test» · **[rango corregido: el parcial decía 82-86]**
- `ops/tests/test_container_runtime_zombies.py:87-87` · ceremonial · 1 línea · «Create»
- `ops/tests/test_container_runtime_zombies.py:99-99` · ceremonial · 1 línea · «Let»
- `ops/tests/test_container_runtime_zombies.py:102-102` · ceremonial · 1 línea · «Count»
- `ops/tests/test_container_runtime_zombies.py:105-105` · ceremonial · 1 línea · «Now»
- `ops/tests/test_container_runtime_zombies.py:108-108` · ceremonial · 1 línea · «Count»
- `ops/tests/test_container_runtime_zombies.py:121-127` · ceremonial · 7 líneas · «Test» · **[rango corregido: el parcial decía 120-127]**
- `ops/tests/test_container_runtime_zombies.py:146-146` · ceremonial · 1 línea · «Let»
- `ops/tests/test_container_runtime_zombies.py:163-168` · ceremonial · 6 líneas · «Test» · **[rango corregido: el parcial decía 162-168]**
- `ops/tests/test_container_runtime_zombies.py:178-178` · ceremonial · 1 línea · «Let»
- `ops/tests/test_container_runtime_zombies.py:200-200` · ceremonial · 1 línea · «Run»
- `ops/tests/test_container_runtime_zombies.py:203-203` · ceremonial · 1 línea · «Only»

## Qué queda fuera de esta lista, a propósito

- **Los `[compactar]`**: 12 bloques que mezclan historia e invariante en la misma frase. Borrar por línea los mutila — que es exactamente cómo nacieron los 15 fragmentos mutilados que hoy hay que limpiar. Cada parcial trae la reescritura exacta propuesta.
- **Los `CONSERVAR EXPLÍCITAMENTE`** de cada parcial: invariantes que se parecen a narrativo y no deben caer en una segunda pasada. Merece la pena leerlos antes de borrar.
- **Comentarios dentro de strings SQL**: cero hallazgos en todo el árbol hoy, pero la regla se mantiene.
- **`services/gateway/src/routes/console.ts` y `packages/protocol/src/schemas.ts`**: sin marcar hasta que se estabilicen.
