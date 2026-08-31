# Cierre de las tres rondas: lo que el gate verde no miraba

Revisión adversarial de ~250 commits de tres rondas sobre `dev`. El método principal fue
**mutación**: romper a propósito el código que una suite dice cubrir y comprobar si se pone roja.
Una prueba que sobrevive a su mutante no prueba nada, y el gate la seguirá dando por verde.

## 1 · Veredicto en una frase

**El árbol se puede desplegar.** No apareció ningún defecto de comportamiento introducido por las
tres rondas: los dos merges no perdieron ni una aserción, y las cuatro zonas más reescritas
(parser de salida, criptografía de billetes, disciplina de delegación, consola de cuentas) matan
casi todos sus mutantes. Lo que sí apareció —y es el resultado que importa— son **diez guardias
reales que ninguna prueba sostenía**, incluido un arreglo de seguridad de esta misma ronda. Están
cerradas. Quedan cuatro huecos conocidos, todos en la validación de reclamos del token de
reanudación, documentados abajo y sin cerrar a propósito.

## 2 · Mutación: 62 plantados, 16 supervivientes

Cada mutante se evaluó contra una suite **verificada en verde antes de plantarlo** (el arnés aborta
si la base ya está roja; esa comprobación cazó una medición falsa, ver §6).

| Objetivo | Plantados | Sobrevivieron |
|---|---:|---:|
| `services/gateway/src/terminal/tickets.ts` | 13 | **4** |
| `packages/store/src/delegation-guard.ts` | 7 | **2** |
| `packages/adapter-sdk/src/sdk/output-parser/contract.ts` | 10 | 0 |
| `services/gateway/src/console/agent-profile.routes.ts` | 6 | **5** |
| `services/gateway/src/terminal/session-control.ts` | 1 | 0 |
| `console/src/features/accounts/quotas.ts` | 10 | **2** |
| `packages/store/src/audit-summary.ts` | 8 | **3** |
| `services/dispatcher/src/metrics.ts` | 1 | 0 |
| `console/src/features/live/AgentDrawer.tsx` | 6 | 0 |
| **Total** | **62** | **16** |

De los 16: **10 eran huecos reales y están cerrados**, **2 resultaron mutantes equivalentes** (no
cambian ningún comportamiento observable) y **4 quedan abiertos** (§4).

### 2.1 · Lo que sí está bien protegido

Esto también es resultado, y evita que la próxima ronda lo vuelva a mirar:

- **Firma de los billetes PTY.** Desactivar el `timingSafeEqual` del billete o del token de
  reanudación, cambiar el salt HKDF, intercambiar tenant y alias en el `info`, aceptar base64url no
  canónico, admitir una maestra que no sea de 32 bytes, truncar el digest de auditoría: **todos
  mueren**. Los vectores dorados hacen su trabajo.
- **Parser de salida del adaptador** (`output-parser/contract.ts`): 10 de 10 muertos contra la
  suite completa de `adapter-sdk`. Ojo: 3 de esos 10 sobreviven si solo se corren los tres ficheros
  `output-parser-*`; quien mida por fichero se llevará una impresión falsa.
- **Consola de cuentas** (`quotas.ts`): orden por severidad, ventana peor, bordes `<` contra `<=`,
  0 % como agotado, redondeo a un decimal.
- **El cajón de agente de CODEX 1**: 6 de 6 muertos (§5).
- **El doble control de permiso en `POST /owner`** (`session-control.ts`): quitar la consulta a la
  BD deja la suite roja.

## 3 · Los diez huecos cerrados

Cada uno con el mutante que sobrevivía antes y muere ahora.

### 3.1 · `adoptionMatches` no tenía ninguna prueba — y ahí vivía un arreglo de seguridad

`services/gateway/src/console/agent-profile.routes.ts`. Esta función decide
`runtime_state: 'applied'`, que es **la única evidencia que tiene el operador de que un agente
adoptó de verdad su revisión de perfil**.

Con la superficie **entera** de pruebas del gateway en verde (`tests/gateway-hardening` +
`tests/unit` + `services/gateway/src`), se podían borrar sus comprobaciones una a una sin que nada
se pusiera rojo:

| Mutante | Antes |
|---|---|
| quitar `!hasAdapterDeliveryEvidence(adoption)` | SOBREVIVE |
| no comparar la revisión adoptada | SOBREVIVE |
| no comparar la generación del contenedor | SOBREVIVE |
| aceptar un `adopted_at` no parseable | SOBREVIVE |
| no comparar el número de documentos | SOBREVIVE |

El primero es **la comprobación que `3a31bbc` añadió para cerrar un fail-open**. El arreglo de
seguridad entró sin una sola prueba que lo sostuviera: cualquier refactor posterior podía
revertirlo en silencio.

La prueba positiva que ya existía se llama *«sólo marca applied con revisión durable igual y
ruta+SHA+generación actuales»*. El «sólo» nunca se comprobó.

Cerrado en `63b8b55`. Los cuatro primeros mueren ahora. El quinto —no comparar el número de
documentos— es un **mutante equivalente**: el `return expected.size === 0` del final de la función
ya cubre todos sus casos.

### 3.2 · «strips control characters» no probaba ningún control de verdad

`packages/store/src/audit-summary.ts` produce el resumen de auditoría que ve el operador en la
consola, con lista blanca de campos. La prueba llamada *bounds generated config prose and strips
control characters* usaba como único control un `\n` — y `cleanText` colapsa `\s+` a un espacio
**antes** de que importe la rama `code <= 31`. El único control del caso ya estaba cubierto por
otro paso, así que **borrar la limpieza entera dejaba la suite en verde**.

Los que sí dependen de esa rama son los que no son espacio: `ESC`, `BEL`, `NUL`. Sin ella, una
secuencia ANSI metida en un metadato viaja entera hasta la vista de auditoría del operador.

También estaba sin probar el tope de 10 campos: ninguna prueba pasaba más de diez escalares
permitidos. Cerrado en `6bbe4d0`.

Un tercer mutante de este fichero —quitar el guardia `Array.isArray`— **sobrevive y es
equivalente**: ninguna clave de la lista blanca puede existir en un array JSON, así que el
resultado sale vacío igual.

### 3.3 · `boundedRejectionTarget` no tenía ninguna prueba

`packages/store/src/delegation-guard.ts`. Dos mutantes sobrevivían a la suite entera de
`packages/store/test`: dejar pasar un destino de 257 caracteres, y recortar con elipsis a 257.

No es un desbordamiento cosmético. `repository/agents/chain-control/policy.ts` reconstruye cada
rechazo con `DelegationRejectionSchema.safeParse` y lo apila **solo** `if (parsed.success)`. Un
destino un carácter por encima del tope hace que el aviso de rechazo **se descarte sin rastro** y
el agente rechazado no reciba nada: ni el motivo, ni la instrucción de no reintentar. Cerrado en
`5b0b3db`.

### 3.4 · La consola suponía sano a un proveedor sin severidad

`console/src/features/accounts/quotas.ts`. Dos mutantes sobrevivían a las **1566** pruebas de la
consola:

- `severityRank(null)` devolviendo el rango de `ok` en vez del de `unknown`. El comentario de la
  función afirma justo lo contrario —«un proveedor sin severidad no debe suponerse sano»— y nada
  lo comprobaba: las pruebas solo la llamaban con severidades literales válidas.
- `balanceSeverity` con los umbrales por defecto 10/25 cambiados a 1/2. Todas las pruebas pasaban
  `thresholds` explícitos, así que las ramas `?? 10` y `?? 25` **nunca se ejecutaban**. Una cuenta
  al 10 % libre habría pasado de ATENCIÓN a OK sin que nada se pusiera rojo.

Cerrado en `460558a`.

### 3.5 · `test:unit` estaba en rojo sobre `dev`

No es de las tres rondas: entró durante esta auditoría, en `2b33147` (CIERRE 2), y lo cazó la
comprobación de línea base del arnés de mutación.

El commit movió los gauges del dispatcher a un array aparte que solo se vuelca en `lines` si la
recolección **entera** salió bien. Es mejor comportamiento: antes, una fila con un `count` no
parseable dejaba en la salida los gauges ya calculados **junto a** `query_success 0`, y un scrape
leía esa profundidad de cola parcial como si fuera la real.

La prueba de `tests/unit` seguía afirmando esa fuga. Corregida en `d86f156` para que afirme el
contrato nuevo —todo o nada—, verificada con un mutante que devuelve la fuga.

## 4 · Los cuatro huecos que quedan abiertos

Todos en `verifyResumeTokenSignature`, en la validación de reclamos **posterior** a la firma:

| Mutante | Estado |
|---|---|
| `decodePayload` del billete ya no exige `v === 1` | SOBREVIVE |
| el token de reanudación ya no exige `v === 1` | SOBREVIVE |
| el nonce deja de validarse contra `/^[A-Za-z0-9_-]{22}$/` | SOBREVIVE |
| `iat`/`exp` dejan de exigir entero seguro | SOBREVIVE |

**No los cerré a propósito.** Los cuatro campos viajan **dentro de la carga firmada**: para
alterarlos hace falta la clave, y con la clave hay problemas mayores. Son defensa en profundidad
contra un emisor futuro `v2` que comparta la maestra, no contra un atacante. La suite de billetes
prueba a fondo la frontera criptográfica y **nada** de la frontera de forma de los reclamos; esa
asimetría es el hallazgo, y conviene que la próxima ronda decida si la cierra.

## 5 · Los dos merges: no se perdió nada

Comprobación mecánica sobre **los 461 ficheros de prueba que existen en `origin/main`**: para cada
uno, número de líneas con `expect`/`assert` en `main` frente a `dev`.

**Ninguno tiene menos aserciones en `dev`. Ninguno desapareció.**

Revisión a mano de los ficheros que fueron conflicto:

- `packages/adapter-sdk/test/dialects.test.ts` (−15/+14): parecía pérdida y **no lo es**. Son
  renombres de variable (`ilegible`→`unreadable`, `sinAndamiaje`→`missingScaffold`) y dos líneas de
  comentario condensadas en una. Las nueve aserciones están intactas.
- `console/src/features/accounts/licenses.ts` (−6/+6) y `hypergraph/hypergraph-layout.ts` (−3/+8):
  solo palabras `export`. `main` privatizó esos tipos y `dev` los mantiene exportados. No hay
  cambio de comportamiento; sí quedan exports de más, que es material para un barrido futuro, no un
  defecto.
- `packages/adapter-sdk/src/sdk/durable-store/sessions.ts` (−13/+5) y
  `services/gateway/src/console/agent-profile.routes.ts` (−12/+11): las líneas que `dev` no tiene
  son comentarios mutilados de `main` (§7) y una IIFE que `dev` extrajo a `selfRole`. `dev` además
  **añade** el `hasAdapterDeliveryEvidence` de `3a31bbc`.
- `services/gateway/src/terminal/session-control.ts` (−4/+0): dos comentarios idénticos, ambos ya
  truncados en `main` («…es la BD. \`POST» y línea siguiente sin sujeto). Se perdió un comentario
  ya ilegible, no comportamiento.
- `tests/unit/gateway-terminal-tickets.test.ts` (−18/+7): `dev` sustituyó el helper `exigir()` por
  `?? ''`. **Debilita** cuatro aserciones —si el billete dorado se corrompiera, el caso pasaría por
  el motivo equivocado en vez de fallar diciendo qué faltó— pero como `GOLDEN_TICKET_*` es una
  constante de tres partes, hoy no cambia ningún resultado. Los 13 mutantes de `tickets.ts` lo
  confirman: los 9 que deben morir mueren igual.

**Caveat honesto:** contar aserciones detecta pérdidas, no debilitamientos. El caso `exigir()` es
justo uno que el conteo no ve; lo encontré leyendo. Pueden quedar debilitamientos del mismo tipo en
ficheros que no fueron conflicto y que no revisé línea a línea.

## 6 · La trampa del `rerere`, desarmada

`git rerere` seguía guardando la resolución equivocada, en
`.git/rr-cache/b66bb6353e7c1ad364aa825c365d1d042f3d219d/`. Su `postimage` importa `parseAndVerify`
y `parseResumeToken`, y **ninguno de los dos símbolos existe ya en el árbol** (`git grep` vacío
para ambos). Cualquier merge futuro que tocara el mismo conflicto en
`tests/unit/gateway-terminal-tickets.test.ts` la habría reaplicado sola y en silencio.

**Entrada eliminada** (copia de respaldo fuera del repo). El efecto es que ese conflicto vuelva a
pedir resolución a mano, que es lo que se quiere. Quedan 36 entradas en la caché; ninguna otra
menciona símbolos inexistentes.

## 7 · El trinquete de comentarios sigue mutilando

Cinco bloques JSDoc del árbol actual perdieron su frase de apertura para bajar el conteo y quedaron
incoherentes:

| Fichero:línea | Qué quedó |
|---|---|
| `packages/adapter-sdk/test/preflight-retry.test.ts:23` | bloque **completamente vacío** (`/**`, ` *`, ` *`, `*/`) |
| `packages/adapter-sdk/src/harnesses/shared/errors.ts:147` | una lista numerada que empieza en el punto 2 |
| `tests/unit/gateway-console-user-cli.test.ts:17` | una lista numerada sin la frase que la introduce |
| `services/gateway/src/console/agent-profile.routes.ts:213` | empieza a media frase: «writing a person halfway is worse…» |
| `services/gateway/src/console/agent-profile.routes.test.ts:9` | el mismo patrón |

No los toqué: no son defectos de comportamiento y la orden pide no reescribir por estética. Van
aquí con `fichero:línea` para que la ronda que decida limpiarlos no tenga que buscarlos. El de
`preflight-retry.test.ts` no informa de nada y además **cuenta** para el trinquete.

Esta presión es real y la sufrí: los dos primeros arreglos dejaron `calidad` en **ROJO** por añadir
comentarios, y tuve que meter la explicación en los nombres de los `it(...)`. Sale mejor prosa de
prueba, pero conviene saber que el trinquete empuja en esa dirección por construcción, no por
criterio.

## 8 · `eslint-disable`: los 45 están vivos

`eslint --report-unused-disable-directives` sobre todas las zonas estrictas devuelve **cero
directivas sin usar**. Ninguna es residuo.

Ninguna tapa un defecto: los `no-unnecessary-condition` de `src` protegen guardias fail-closed
contra entrada de runtime que el tipo declara imposible, y la mutación lo confirma donde hay
pruebas (los guardias de `tickets.ts` mueren al quitarlos).

Sí confirmo el ensanchamiento que señalaba la orden: en `packages/adapter-sdk/test/config.test.ts`
el `/* eslint-disable @typescript-eslint/no-dynamic-delete */` de fichero cubre **2** sitios
reales. Eran dos disables de línea. El trinquete bajó una línea y la regla dejó de mirar el resto
del fichero. Cosmético hoy; no lo cambié porque no puedo demostrarlo roto.

## 9 · Los dos informes que faltaban

### CODEX 1 (consola) — `bc2c247`, `a90515f`

Su trabajo es sólido y **está probado**. `bc2c247` convierte el cajón de agente en un diálogo modal
de verdad: `role="dialog"` + `aria-modal`, trampa de foco, hermanos `inert`, foco inicial al botón
de cerrar, foco devuelto al abridor, y flechas/Home/End entre pestañas.

Seis mutantes contra las 1566 pruebas de la consola: **6 de 6 muertos** (revertir el `role`, quitar
`aria-modal`, no mover el foco al abrir, no devolverlo al cerrar, no inertizar el fondo, romper las
flechas). No es andamiaje: cada pieza tiene quien la vigile.

`a90515f` y su cambio de `console/qa/layout-baseline.json`: `node console/qa/layout-gate.mjs` pasa
—*every measured budget holds*— en las siete rutas.

**Lo que CODEX 1 no probó:** nada de esto se verificó en un navegador real ni con un lector de
pantalla; las pruebas son jsdom, donde `inert` es un atributo que nadie hace cumplir. Que el fondo
quede marcado `inert` está probado; que un lector de pantalla real lo respete, no.

### MINIMAX 2 (python) — 6 commits de ruff

Los 12 `B904` están bien resueltos, revisados uno a uno:

- Los 8 `from err` / `from error` conservan la causa donde traducen una excepción a otra más rica.
- El `raise` desnudo de `cauce_pty_agent.py:2151` es un re-`raise` dentro de su propio `except`: la
  forma canónica, preserva el traceback sin duplicar la cadena.
- **Los 4 `from None` no tapan nada.** Los cuatro (`container-alias-query.py`,
  `container_ops_digest.py`, `pin-container-release.py`, `validate-manifests.py`) hacen
  `print(f"...: {error}", file=sys.stderr)` **inmediatamente antes** del `raise SystemExit(...) from
  None`. La causa se imprime; lo que se recorta es el traceback de un CLI, que es lo correcto.

**Lo que MINIMAX 2 no probó:** ninguno de esos cuatro caminos de error tiene prueba automática. Se
verifican leyendo, no ejecutando. Si alguien quita el `print`, el `from None` pasa a tapar la causa
de verdad y nada lo detecta.

## 10 · Qué NO probé

Con esas palabras, y son los límites reales de este informe:

- **No probé nada contra el sistema vivo.** Todo es local: sin Docker, sin producción, sin un
  agente real. `qa:real`, `qa:testcontainers` y `qa:runtime-packaging` **no los corrí**.
- **No probé la consola en un navegador.** Ni la mía ni la de CODEX 1. Todo es jsdom.
- **No mutá `services/{dispatcher,telegram-bridge,terminal-relay}/**` ni
  `packages/store/test/*migration*`** más allá del único mutante de verificación en
  `metrics.ts`: son zonas de CIERRE 1 y 2.
- **La mutación es una muestra, no un barrido.** 62 mutantes sobre 9 ficheros. El árbol tiene
  cientos. Un fichero que no aparece en la tabla del §2 **no está declarado sano**: está sin medir.
  En particular no toqué `packages/store/src/repository/**` (el grueso del store), `sdk/engine.ts`,
  `shared-session/**` ni casi nada de `console/src/features/live/**`.
- **No revisé línea a línea los ~250 commits.** Comparé `main` contra `dev` mecánicamente y leí a
  fondo los ficheros que fueron conflicto. Un debilitamiento del tipo `exigir()`→`?? ''` en un
  fichero que no fue conflicto se me habría escapado.
- **No verifiqué que la caché de `rerere` no tenga otras resoluciones malas**, solo que ninguna de
  las 36 restantes menciona los dos símbolos borrados. Una resolución equivocada por otro motivo
  seguiría ahí.
- **Las mediciones de esta sesión se tomaron en un árbol compartido** con CIERRE 1 y CIERRE 2
  trabajando en vivo. Una corrida amplia quedó contaminada por una edición ajena en vuelo; la
  repetí. Las que quedan en este informe se tomaron con la línea base verificada en verde
  inmediatamente antes, pero el árbol no estuvo quieto en ningún momento.

## 11 · Estado del gate

Ver `ordenes-locales/CIERRE-3-OPUS-adversarial-reporte.md` para la salida pegada.
