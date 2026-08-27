# Auditoría transversal cauce-v3 — síntesis de 10 familias

**Fecha de medición:** 2026-08-27, ~21:30 UTC · **Método:** 10 barridos independientes + verificador adversarial por familia + re-verificación contra el filesystem vivo durante esta síntesis.
**Corpus:** 77 hallazgos CONFIRMADOS (22 de gravedad alta), 3 rechazados por el verificador.

---

## 1. Veredicto global y nota de limpieza

> **El código está bastante más limpio de lo que temes; lo que está roto es el sistema que debía demostrarlo — el gate pasa en VERDE sobre 939 ficheros mientras 14 suites de un servicio vivo nunca se ejecutan, 31 promesas flotantes viven en producción, el CLI real de 1.138 líneas es invisible para el trinquete y `main` está ahora mismo con un `SHA256SUMS` desincronizado que la propia herramienta del repo ya sabe detectar pero nadie ejecuta.**

### Nota: **68 / 100**

No es un aprobado raspado ni un suspenso. Es la nota de un repo cuyo **código** está en forma y cuya **verificación** está agujereada. Desglose por eje, cada uno medido con los hallazgos de su familia:

| Eje | Nota | Por qué |
|---|---|---|
| Código muerto / símbolos inconexos | **95** | La familia salió **vacía**: 0 confirmados de 1 candidato. El único sospechoso era un refactor en vuelo, no un huérfano. |
| Dependencias declaradas | **85** | Solo 2 hallazgos, ambos en `mcp-fleet-monitor` (paquete escrito pero no desplegado). Ningún paquete desplegado miente sobre lo que consume. |
| Calidad de escritura del código | **80** | Solo 3 hallazgos en todo el árbol, y uno es un paquete sin desplegar. |
| Residuos de configuración | **75** | 4 hallazgos, todos en `.env.example` y docs, ninguno en código ejecutable. |
| Duplicación | **70** | 11 hallazgos, **cero de gravedad alta**; 8 de 11 son dobles de test. Solo uno toca producción de cara al usuario. |
| Tamaño y orden | **65** | Los topes se respetan; lo que falla es la contabilidad (trinquete stale) y la tabla de propiedad. |
| Idioma y nombres | **60** | 8 hallazgos, pero son **inventario de coste**, no defectos: falta una decisión del dueño, no trabajo de sector. |
| Veracidad de comentarios y citas | **45** | 20 hallazgos, 8 de gravedad alta, con un patrón de contagio en 8 ficheros y un test que verde-lava la mentira. |
| **Cobertura de gates** | **35** | El peor eje con diferencia, y el que explica por qué los antipatrones reaparecen. |

**Lo que sí sirvió (dilo en voz alta):** cuatro de las diez familias volvieron casi vacías. `inconexo` en **cero**. `dependencias` en dos, `codigo-mal-escrito` en tres, `artefactos-residuos` en cuatro. Eso no es suerte: es el resultado medible de las purgas y particiones de las últimas rondas. La duplicación, que era el terror del repo, ha quedado reducida a fixtures de test y **ninguna** de gravedad alta. El árbol está limpio.

**Lo que no sirvió:** no se cerró ni un solo hueco de gate. Y por eso la limpieza **no se sostiene sola** — cada cosa que se limpia a mano vuelve a poder entrar por la misma puerta abierta. Esa es la respuesta honesta a tu alarma: los antipatrones no reaparecen porque la flota trabaje mal, reaparecen porque **nada automático los detiene**. De las 22 gravedades altas, 14 son literalmente "el gate no mira aquí".

---

## 2. Los 10 hallazgos más graves del sistema completo

### 1. `services/terminal-relay/**`: 14 ficheros de test que no ha ejecutado nadie, nunca
`test:services` filtra `@cauce/gateway`, `@cauce/dispatcher` y `@cauce/telegram-bridge`, y **omite `@cauce/terminal-relay`**, el cuarto de los cuatro servicios vivos. El paquete declara su runner (`vitest run src/*.test.ts`) y está en el workspace; simplemente nadie lo llama.
```
$ grep -c 'terminal-relay' package.json         → 0
$ ls services/terminal-relay/src/*.test.ts | wc -l → 14
```
Es doblemente engañoso porque `typecheck` (tsconfig incluye `services/**`) y `lint:core` (incluye `services`) **sí** lo cubren: los 14 ficheros compilan y lintean limpios, así que todo parece verde mientras cero aserciones se ejecutan. Presupuesta fallos en la primera pasada.

### 2. `console/eslint.config.js`: 31 promesas flotantes vivas en producción bajo un gate en verde
La consola (275 ficheros TS/TSX, 48.597 líneas — el paquete más grande del repo) lintea con `...tseslint.configs.recommended` **sin chequeo de tipos**, mientras el `eslint.config.js` raíz usa `recommendedTypeChecked` para todo lo demás y además ignora `console/**` explícitamente. El verificador no se quedó en "falta la red": montó la config type-aware y midió.
```
$ cd console && npx eslint . --max-warnings 0   → EXIT 0 (verde HOY)
   mismo árbol con recommendedTypeChecked      → 109 violaciones, 31 no-floating-promises
```
Las 31 están **todas en ficheros de producción**, no en tests: `AccountsPage.tsx:36-37,43-44`, `FleetAgentDetailPage.tsx:45-50`, `LiveFleetPage.tsx:262-263`, `MessagesPage.tsx:140-145`, `ObservabilityPage.tsx:38-39`, `SessionStage.tsx:222,239,242,248,251`, `TerminalPage.tsx:78-83`. Son promesas reales: `use-resource.ts:24` declara `reload: () => Promise<RecargaResultado<T>>` y `AccountsPage.tsx:35-36` la llama desnuda dentro de un `setInterval` — un rechazo de recarga se pierde como unhandled rejection en el navegador en lugar de mostrarse al usuario.

### 3. CI ejecuta 4 comandos; `ops:validate` no corre jamás — y ya está costando
`.github/workflows/ci.yml` es el único fichero de CI del repo (no hay hooks, ni husky, ni `core.hooksPath`). Descontando los `pnpm install`, ejecuta exactamente cuatro cosas:
```
$ grep -nE '^\s+run:' .github/workflows/ci.yml
  pnpm install ×2 · pnpm typecheck · pnpm lint · pnpm test:unit · pnpm test:pty
```
Nunca invoca `pnpm ops:validate`, así que en CI **jamás** corren el `bash -n`, el `compile()` de Python, la comprobación generado-vs-versionado de las units systemd, el `docker compose config` de 5 composes, ni los 7 tests que `validate.sh` dispara a mano. Del matrix de 8 suites de `scripts/test-all.mjs`, CI cubre 2 y deja 6 fuera.
**La factura ya llegó:** `main` tiene ahora mismo un manifiesto inconsistente que `validate.sh` detecta y CI no ve.
```
$ (cd ops/generated/container-systemd/rootless && sha256sum -c SHA256SUMS)
  OPERATIONS.sha256: FAILED            (22 restantes OK)
$ bash ops/scripts/validate.sh | tail -1
  checked-in container systemd output is stale: SHA256SUMS
```
El commit `2d6045b` regeneró `OPERATIONS.sha256` sin regenerar `SHA256SUMS` en el mismo paso. Congelado en main, con la herramienta que lo caza desconectada del CI.

### 4. `ops/cli/cauce`: el CLI real, 1.138 líneas, invisible al trinquete por no tener extensión
`scripts/calidad.mjs:11` selecciona ficheros con `EXTS = /\.(ts|tsx|mjs|py|sh)$/`. Los 4 CLI de `ops/cli/` son bash con shebang y **sin extensión**, así que el gate no los ve. Simulado incluyéndolos: `ops/cli/cauce` violaría la regla 1 (**1.138 > 800**) y la regla 4 (**12 comentarios con fecha**, líneas 79, 99, 121, 252, 655, 686, 721, 816, 824, 834, 994, 1056).
```
$ wc -l ops/cli/cauce               → 1138
$ grep -c 'ops/cli' scripts/calidad-base.json → 0   (ni siquiera amnistiado)
$ node scripts/calidad.mjs          → VERDE (939 ficheros)
```
Y no es transitorio: el fichero se comprometió en `2d6045b` ("CLI real rescatado como fuente unica"). El agujero está **congelado en main**, sobre el fichero que el propio dueño quiere convertir en el CLI integral portátil.
**Aviso de orden de operaciones:** si se amplía `EXTS` y se corre `--update` antes de limpiar, el trinquete amnistía las 1.138 líneas y las 12 fechas **para siempre**.

### 5. `ops/guardias/*.py`: cero comprobación sobre código que corre como root cada día
Los 3 `.py` de `ops/guardias/` no están en ningún glob de `compile()` de `validate.sh` (que solo mira `ops/scripts/*.py` y `ops/container-runtime/*.py`), no tienen test, y nadie los importa.
```
$ grep -c guardias ops/scripts/validate.sh → 0
$ grep -n 'ExecStart\|OnCalendar' ops/guardias/systemd/hegel-ventas-checkin.*
  .timer:7   OnCalendar=*-*-* 13:00:00 UTC
  .service:10 ExecStart=/usr/local/sbin/hegel-ventas-checkin.py
```
`hegel-ventas-checkin.py` se dispara solo, a diario, **como root**, leyendo certificados mTLS de `/etc/cauce-v3/pki` contra el gateway. `cred-guard.py` llega por la cadena `cred-guard.timer → .service → cred-guard.sh:7 → python3 cred-guard.py`, y `PENDIENTES-DEL-DUEÑO.md:50` reporta que **la copia viva en kratos está divergida de la del repo**: ni siquiera es este fichero el que se ejecuta. Un `SyntaxError` aquí no lo caza nada hasta que el timer falla en silencio.

### 6. Veinte citas `fichero:línea` rotas en código vivo — y un test que las verde-lava
`packages/store/src/repository.ts` se partió y hoy es un barrel de **43 líneas**; `services/gateway/src/console/agent-documents.ts` es un barrel de **40**. Ocho ficheros de la consola siguen citando `repository.ts:5109`, `repository.ts:5151`, `repository.ts:1821/1826` y `agent-documents.ts:585/594/218/127`. Peor: `selfRoleBrief`, citada tres veces como "el lector probado" que sostiene una decisión de producto, **no existe en ningún fichero fuente del repo**.
```
$ wc -l packages/store/src/repository.ts   → 43
$ grep -rn 'repository.ts:5109' console services --include=*.ts* | wc -l → 4
$ grep -rn 'selfRoleBrief' --include=*.ts* . | wc -l → 3   (0 definiciones)
```
Y el remate estructural, `console/src/features/config/campos-inertes.test.ts:23`:
```js
expect(motivo).toMatch(/repository\.ts:5109/);
```
Un test que comprueba que el texto **contiene la subcadena**, no que la línea exista. Está en verde afirmando una coordenada físicamente imposible. El patrón repetido en 8 ficheros distintos indica contagio por copia entre vecinos, exactamente lo que el JSDoc de `campos-inertes.ts` dice que no debía pasar.

### 7. `shellcheck` no está instalado: la cobertura real de shell es 0 de 38
`ops/scripts/validate.sh` usa el mismo glob de cuatro rutas para `bash -n` (línea 6) y para `shellcheck` (línea 197), cubriendo 28 de 38 `.sh`. Pero:
```
$ command -v shellcheck → AUSENTE
$ git ls-files '*.sh' | wc -l → 38 ;  glob de validate.sh → 28
```
El `if command -v shellcheck` se salta **en silencio**: análisis estático real de shell = **0/38**. Y los 10 que quedan fuera hasta del `bash -n` incluyen `scripts/test.sh`, del que cuelgan `test:store-hardening`, `test:integration` y `test:e2e`.

### 8. La tabla de sectores no cubre dos árboles de código vivo
`ordenes/00-PROTOCOLO.md` declara que la propiedad por sector es "**LA** protección principal" contra colisiones entre las 4 instancias. Pero:
```
$ grep -c 'adapter-sdk' ordenes/00-PROTOCOLO.md → 0
$ grep -c 'dispatcher'  ordenes/00-PROTOCOLO.md → 0
```
`packages/adapter-sdk/**` (incluye el fichero más grande del repo, 5.454 líneas) y `services/dispatcher/**` (uno de los 4 servicios vivos según `AGENTS.md:13`, con `src/` de 5 ficheros y `test/` de 3) **no tienen dueño ni revisor**. No es una tabla vieja: el fichero se editó hoy a las 20:36 precisamente para retocar esa tabla. Es una omisión activa. Se nota aguas abajo: dos hallazgos de idioma en `adapter-sdk` se rutearon a Gemini "por parecido", sin base en el protocolo.

### 9. 857 ficheros propiedad de `root` en el checkout compartido, 2 de ellos **versionados** *(nuevo, hallado en esta síntesis)*
El protocolo prohíbe expresamente correr tests como root porque `runtime-package-smoke` compara uid y da falsos rojos. Ya ocurrió:
```
$ find . -user root -not -path './node_modules/*' -not -path './.git/*' | wc -l → 857
$ git ls-files -z | xargs -0 ls -l | awk '$3=="root"{print $NF}'
  ops/harness/fleet.mjs
  ordenes/reportes/claude-duplex-cli.md
$ grep -n uid deploy/runtime/runtime-package-smoke.mjs
  104: if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
```
`ops/harness/fleet.mjs` es **fuente versionada en sector de Codex** que una instancia corriendo como `stev` no puede editar sin sudo. El resto (dist/, `.test-state/`, `ops/artifacts/`) está gitignorado pero envenena builds y tests locales de las otras tres instancias. Además hay 3 reportes untracked propiedad de root en `ordenes/reportes/`.

### 10. 52 de 65 `.mjs` no pasan por ESLint jamás — incluidos 15 de runtime productivo
Los 4 targets de lint (`lint:core`, `lint:adapter`, `lint:mcp`, `lint:console`) dejan fuera 52 ficheros.
```
$ git ls-files '*.mjs' | wc -l → 65 ; fuera de todo target → 52
```
De ellos, 15 viven en `deploy/` y son runtime real: `migrate.mjs`, `migration-integrity.mjs`, `schema-version.mjs`, `readiness-probe.mjs`, `postgres-tls.mjs`, `outbox-metrics.mjs`. Su única red es un `node --check` de sintaxis dentro de `validate.sh`… que no corre en CI (hallazgo 3). Y en la lista está `scripts/calidad.mjs`: **la herramienta del gate no se lintea a sí misma**. El hueco es de *invocación*, no de configuración: `eslint.config.js` ya tiene un bloque `files: ['**/*.{js,mjs}']` que los analizaría si alguien se los pasara.

**Justo por debajo del corte:** la divergencia de tipos `console` ↔ `gateway` en las directivas de agente, donde la copia de consola añade `| string` a una unión discriminada y **la colapsa a `string`** (adiós exhaustividad y autocompletado); y el `INSERT INTO messages` de 11 columnas repetido en **7** ficheros del store con tres formas distintas de escribirlo.

---

## 3. Listas ejecutables por sector

> Regla de reparto: **la tabla de `ordenes/00-PROTOCOLO.md` manda**. Donde el verificador ruteó por parecido y la tabla dice otra cosa, se corrige aquí y se marca. Donde el arreglo cruza sectores, va explícito quién pide y quién aplica.

### 3.1 CODEX — `packages/store/src/**`, `services/gateway/src/**`, `packages/protocol/**`, `packages/mcp-fleet-monitor/**`, `ops/scripts/**`, `ops/tests/**`, `ops/harness/**`

1. **`ops/scripts/validate.sh` (líneas 6 y 197)** — Ampliar **ambos** globs a los 10 `.sh` que hoy quedan fuera, empezando por `scripts/test.sh`. *Por qué:* de `scripts/test.sh` cuelgan 3 suites y nadie le pasa ni un `bash -n`. Es 1 línea de glob por cada uno de los dos sitios; la instalación de shellcheck es del dueño (§3.5).
2. **`packages/mcp-fleet-monitor/package.json:11`** — Añadir `"esbuild": "0.28.1"` (pin exacto de la raíz) a `devDependencies`. *Por qué:* el script `build` solo funciona porque `pnpm exec` sube al `.bin` de la raíz; verificado ocultando el binario, falla con `Command "esbuild" not found`.
3. **`packages/mcp-fleet-monitor/package.json:20`** — Añadir `"@types/pg": "^8.15.4"` a `devDependencies`. *Por qué:* su `tsconfig` es aislado y su `tsc --noEmit` resuelve `pg` a través de `@cauce/store`; verificado ocultando `@types/pg` de la raíz, falla con TS7016.
4. **`packages/store/src/repository/messages/_insert.ts` (nuevo)** — Extraer `insertMessage(client, {...11 campos})` e `insertDelivery(client, ...)` y llamarlos desde los 7 sitios de `INSERT INTO messages` y los 6 de `INSERT INTO deliveries`. Sacar la lista de columnas a constante exportada para que el `INSERT…SELECT` de `outbox/operator.ts:227` no se desincronice. *Por qué:* añadir una columna `NOT NULL` a `messages` hoy obliga a tocar 7 ficheros y 8 listas de columnas a mano; ya conviven tres formas distintas de escribir el mismo INSERT. Hacer los dos INSERT en el **mismo** cambio: el de `deliveries` por separado no compensa la indirección.
5. **`services/gateway/src/console/types-agent-directive.ts`** — Dejar una sola declaración de `AgentDirectiveFile` / `AgentMemoryIndexAvailable` / `AgentMemoryIndexUnavailable`, importada con `import type` desde ambos lados. **Bloqueado** hasta que el dueño decida la dirección (§3.5.8). *Por qué:* la copia de consola añade `| string` y colapsa la unión discriminada a `string`. Ojo: una instancia borró hace minutos, sin commitear, la cabecera que declaraba la copia como intencional.
6. **`packages/protocol/src/outbox-contracts.ts`** — Cerrar el refactor de la forma del ACK entregando a Gemini la mitad de `telegram-bridge` (aviso, no edición: ese sector no es tuyo). *Por qué:* 2 de 3 sitios ya aterrizaron; el traspaso está prescrito en `_parcial-dup-backend.md` (G-15). **Dato para el traspaso:** los 7 campos de `OutboxAckWithEffectCount` son `readonly` y los de `TelegramOriginRelayAck` (`services/telegram-bridge/src/types.ts:274-283`) son mutables.
7. **`packages/protocol/src/schemas.ts`** — 1.093 líneas con todos los schemas Zod del wire 3.0 en un fichero del que dependen todos los paquetes. Partir por dominio de mensaje manteniendo el barrel como re-export. *Por qué:* es el cuello de botella de contención entre sectores.
8. **`services/gateway/src/terminal/session-control.ts`** — 785 líneas: revisar **antes** del próximo cambio que lo toque, partir si cruza 800. *Por qué:* no está en el trinquete; el primer commit que lo cruce pondrá `main` en rojo.
9. **`ops/scripts/host-backup.sh:102`** — Quitar `(verified 2026-07-25: passing the real path doubled it)`, dejando la restricción técnica. *Por qué:* regla 4 del protocolo (prohibido fechar en comentarios).
10. **`packages/mcp-fleet-monitor/src/server.ts:253,261`** — Extraer una `async function shutdown(signal)` con try/catch y registrar `process.once('SIG…', () => { void shutdown(…) })` como hacen gateway y dispatcher. *Por qué:* hoy son dos handlers `async` desnudos; si `pool.end()` rechaza, nunca se llega al `process.exit(0)` y el apagado limpio se convierte en crash. **El más débil de tu lista:** paquete no desplegado e invisible al gate por política (`checksVoidReturn: false`). Si hay que recortar, este cae primero.
11. **`ops/scripts/container-adapter-supervisor.sh`** (976), **`packages/store/src/repository/agents/chain-control/materialization.ts`** (778), **`packages/store/src/configuration/mutations.ts`** (728), **`ops/harness/runner.mjs`** (718) — Vigilancia de tamaño, partir solo si vuelven a crecer. *Por qué:* están bajo el tope; no toques nada hoy, solo no los engordes.
12. **`ops/harness/fleet.mjs`** — Pedir al integrador que corrija la propiedad del fichero (`root:root`, versionado, en tu sector). *Por qué:* no puedes editarlo sin sudo si corres como usuario normal.
13. **Inventario de idioma (NO renombrar; solo confirmar el coste al dueño)** — `services/gateway/src/console/agent-profile.routes.ts` (7 exports EN + 5 ES en el mismo fichero, con consumidores en `console/`), `packages/protocol/src/marcas-de-bloque.ts`, `packages/protocol/src/ficheros-del-arnes.ts`, `packages/protocol/src/agent-profile.ts` (`ArnesDelAlias`/`HechosDelAlias`/`ContextoDeAlias`), `services/gateway/src/terminal/hechos-del-registro.ts`. *Por qué:* la decisión es del dueño (§3.5.9); renombrar por iniciativa propia rompe consumidores en tres sectores.

### 3.2 GEMINI — `console/**`, `services/terminal-relay/**`, `services/telegram-bridge/**`, `ops/pty-agent/**`, `tests/**`

1. **`services/terminal-relay/src/*.test.ts` (14 ficheros)** — Ejecutarlos por primera vez (`pnpm --filter @cauce/terminal-relay test`) y arreglar lo que falle. La línea `--filter @cauce/terminal-relay` en `package.json:33` la pide al integrador (raíz no es tu sector). *Por qué:* 14 suites de un servicio vivo llevan quién sabe cuánto sin ejecutarse; presupuesta tiempo de arreglo, no solo el flag.
2. **`console/eslint.config.js:10`** — Sustituir `...tseslint.configs.recommended` por `...tseslint.configs.recommendedTypeChecked` y añadir `languageOptions.parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }`, replicando `eslint.config.js:18-25` incluidos sus dos ajustes (`no-misused-promises` con `checksVoidReturn: false`, `require-await` off). **En dos commits:** primero la config con las reglas ruidosas en `warn`, luego subirlas a `error`. *Por qué:* 109 violaciones esperan detrás, y 31 de ellas son bugs reales.
3. **Las 31 `no-floating-promises` de producción** — `AccountsPage.tsx:36-37,43-44`, `FleetAgentDetailPage.tsx:45-50`, `LiveFleetPage.tsx:262-263`, `MessagesPage.tsx:140-145`, `ObservabilityPage.tsx:38-39`, `SessionStage.tsx:222,239,242,248,251`, `TerminalPage.tsx:78-83`. *Por qué:* `use-resource.ts:24` devuelve `Promise`; hoy un fallo de recarga se pierde como unhandled rejection en vez de llegar al usuario. Este es el único hallazgo de toda la auditoría con impacto directo en lo que ve la persona que usa la consola.
4. **Las 15 citas rotas de `console/src/features/config/`** — Corregir en un solo pase, verificando cada destino con `grep -n` antes de escribirlo:

   | Fichero | Cita actual | Destino real medido |
   |---|---|---|
   | `campos-inertes.ts:38` | `repository.ts:5109` | `packages/store/src/repository/agents.ts:278` |
   | `campos-inertes.ts:21,31` | `repository.ts:5151` | localizar en `repository/agents.ts` o quitar la línea |
   | `campos-inertes.ts:19` | `agent-documents.ts:585` | `console/agent-documents/catalog.ts:494` |
   | `campos-inertes.ts:20` | `agent-documents.ts:594` | `console/agent-documents/catalog.ts:503` |
   | `campos-inertes.ts:26` | `agent-documents.ts:30` | `console/agent-documents/catalog.ts:19` |
   | `campos-inertes.test.ts:41` | `selfRoleBrief, repository.ts:1826` · `listAgents :7605` · `agentDeploymentStatus :1272` | **`selfRoleBrief` NO EXISTE** · `repository/agents.ts:321` · `repository/observability/helpers.ts:7` |
   | `arneses.ts:79` | `selfRoleBrief, repository.ts:1821` | **NO EXISTE** — localizar la sucesora o retirar la afirmación |
   | `arneses.ts:6` | `agent-documents.ts:33` | `catalog.ts:4` |
   | `arneses.ts:64` | `agent-documents.ts:218` | `catalog.ts:317` |
   | `arneses.test.ts:15` | `agent-documents.ts:127` | `catalog.ts:317` |
   | `ConfigPage.inertes.test.tsx:95` | `selfRoleBrief, repository.ts:1821` | **NO EXISTE** |
   | `SpaceWizard.tsx:24` | `repository.ts:5109` | `repository/agents.ts:278` |
   | `SpaceWizard.tsx:31` | `schemas.ts:503` | `schemas.ts:463` (campo `command` en `:468`) |
   | `SpaceWizard.test.tsx:180,~217` | `repository.ts:5109` | `repository/agents.ts:278` |

   *Por qué:* tres de esas citas (`selfRoleBrief`) sostienen decisiones de producto sobre una función inexistente. Prioriza esas.
5. **`console/src/features/config/campos-inertes.test.ts:23`** — Cambiar `expect(motivo).toMatch(/repository\.ts:5109/)` por un match del **nombre del símbolo**, o por una verificación que abra el fichero citado y confirme que la línea existe. *Por qué:* hoy es un test verde que certifica una coordenada imposible. Mientras exista, cualquier corrección de la cita rompe el test y la presión será revertir la corrección.
6. **`console/src/features/queues/filtro-de-colas.ts:7`** — Reducir el JSDoc a la restricción que el código no puede expresar, quitando "Recorrido de producción del 2026-08-23" y el relato de las 197 entregas. *Por qué:* regla 4.
7. **`console/src/features/live/role-brief.ts:55`** — Quitar `GUARDA TEMPORAL — zeus 2026-08-22`; si la caducidad importa, exprésala como condición verificable en test. *Por qué:* regla 4.
8. **`console/src/hooks/useFocusTrap.ts` (nuevo)** — Extraer la trampa de foco (7 líneas idénticas) de `features/config/CollectionTable.tsx:272-280` y `features/live/DirectivaModal.tsx:65-74`, dejando el manejo de Escape **fuera** del hook (cada diálogo ya lo resuelve a su manera). *Por qué:* es el único duplicado de la auditoría en producción de cara al usuario; hoy un arreglo del ciclo de tabulación se aplicaría a un solo diálogo.
9. **`services/terminal-relay/src/{sessions,sessions-recovery,session-spool}.test.ts`** — Borrar las 3 `grant()` locales y los 3 `CLAIM_TOKEN` locales; importar `{ grant, CLAIM_TOKEN }` de `./relay-test-fixtures.js` como ya hacen `relay.test.ts` y `relay-circuit.test.ts`. *Por qué:* el hogar compartido ya existe y funciona; hay 4 valores acoplados a mano (`RELAY_INSTANCE_ID`, `RELAY_BOOT_ID`, `CLAIM_TOKEN`) que ya divergieron en forma literal.
10. **`services/terminal-relay/src/relay-test-fixtures.ts`** — Añadir `agentHello(overrides: Partial<AgentHello> = {})` y migrar las **7** declaraciones de `const HELLO: AgentHello` (`read-governance`, `read-governance-directory`, `governance-relay`, `governance-relay-mutations`, `agent-leg`, `write-governance`, `write-governance-batch`) a pasar por overrides solo lo que cada test ejercita (`features`, `alias`, `harness`, `agent_version`). *Por qué:* 3 son idénticas y 4 varían solo en el campo bajo prueba; el fixture aún no existe para este tipo.
11. **`services/telegram-bridge/test/{bridge-egress,bridge-lifecycle}.test.ts`** — Sustituir el `const api: TelegramApi = {…6 no-op…}` por `class X extends FakeTelegram { override async sendText() {…} }`, siguiendo el patrón que ya usan `FailingActivityTelegram` y `RejectingSendTelegram` en `bridge-fixtures.ts:165,175`. *Por qué:* ambos ficheros ya importan `bridge-fixtures.js`; la solución está escrita al lado y no se usó.
12. **`tests/terminal-pty/protocol.mjs`** — Mover `interface TicketOverrides` + `ticketPayload()` allí (o a un `ticket.mjs` con su `.d.mts`, siguiendo la convención del directorio) y borrar las 3 copias de `relay-contract.test.ts:54`, `relay-contract-agent.test.ts:32`, `relay-contract-lifecycle.test.ts:36`. *Por qué:* los 3 ya importan `protocol.mjs` y `certs.mjs`; solo este helper se quedó fuera.
13. **`console/src/features/live/agent-state-fixtures.ts` (nuevo)** — Extraer `agent()`/`snapshot()` desde `agent-state.test.ts:17,35` y `agent-state-derivation.test.ts:21,39`; en `veredicto-vocabulario.test.ts:35` pasar `presence.lease_until` por overrides en vez de mantener la copia renombrada `agente()`. Añadir ahí `configConBrief()` de `DirectivaTab.test.tsx:31` y `DirectivaModal.test.tsx:30`. **No toques** `activity.test.ts:10`: su `agent()` es distinto y más pequeño, no es copia. *Por qué:* `configConBrief` enumera las 12 colecciones del snapshot de config; añadir una obliga hoy a tocar dos ficheros.
14. **`console/src/features/config/ConfigPage.test-helpers.ts` (nuevo)** — Extraer `recordChanges`, `snapshotDeConfig`, `MEMBERSHIP_JANUS` y `REVISIONES` de los 3 ficheros `ConfigPage*.test.tsx`. *Por qué:* byte-idénticas en los tres.
15. **`console/src/nav.ts` / `console/src/navigation.ts`** — Renombrar uno (p. ej. `navigation.ts → router.ts`). *Por qué:* dos nombres casi idénticos en la misma raíz con responsabilidades distintas (`nav.ts` = entradas de menú, importa de `navigation.ts` = primitivas de enrutado).
16. **`services/telegram-bridge/src/types.ts`** — Recibir de Codex la unificación del ACK de outbox: importar de `@cauce/protocol` y añadir `effect_count?`. Comprobar antes que nadie mute el ack (hoy se construye entero en `src/egress.ts:584`, así que los `readonly` del protocolo probablemente compilan tal cual). *Por qué:* divergencia ×3 catalogada de riesgo ALTO, con 2 de 3 sitios ya cerrados.
17. **Vigilancia de tamaño, sin acción hoy** — `ops/pty-agent/cauce_pty_agent.py` (2.661), `console/src/features/terminal/api.ts` (743), `ops/pty-agent/rollout_pty_lib.py` (736). *Por qué:* bajo tope o amnistiados; solo no los engordes.

### 3.3 OPENCODE/MINIMAX — higiene de disco, `docs/`, residuos, verificaciones mecánicas

> Esta ronda **no produjo ni un solo hallazgo ruteado a tu sector**, y eso es en sí un dato: tu sector se define por función y no por ruta, así que los verificadores nunca te asignan nada. Lo que sigue son los trabajos mecánicos que esta auditoría demostró que hacen falta y que **solo tú puedes hacer sin colisionar**, porque son de solo-lectura + reportes.

1. **Censo mecánico de TODAS las citas `fichero:línea` del código vivo** — Extraer con regex toda coordenada `ruta.ext:NNN` que aparezca en comentarios/JSDoc/strings de `console/`, `services/`, `packages/`, `ops/`, `scripts/`, `tests/`; para cada una verificar (a) que el fichero existe y (b) que tiene al menos NNN líneas. Entregable `ordenes/reportes/minimax-citas-rotas.md`: cita → fichero existe → líneas reales → veredicto → destino probable. *Por qué:* la auditoría encontró 20 rotas solo en `console/features/config`, contagiadas entre 8 ficheros; nadie sabe cuántas hay en el resto del árbol. **Este censo es el insumo del gate G7 (§4)** — sin él, el gate no se puede calibrar.
2. **Auditoría mecánica del trinquete** — Para las 24 entradas de `scripts/calidad-base.json['lineas']` y las 32 de `['fechas']`, comparar baseline contra el fichero real hoy. Entregable: tabla con las stale. *Por qué:* ya hay 2 demostradas (`rollout-pty.py` 1221→510, `update-alias-config.py` 1245→688) que sobrevivieron a la limpieza de HOY porque esa limpieza solo podó claves de `fechas`. El trinquete solo sabe subir; sin una auditoría periódica, cada amnistía es permanente.
3. **Matriz de cobertura fichero → gate** — Para cada fichero versionado, qué gate lo toca: `eslint` / `bash -n` / `shellcheck` / `compile()` / `tsc` / algún runner de test / **ninguno**. Entregable `ordenes/reportes/minimax-cobertura-gate.md` con la columna "ninguno" al principio. *Por qué:* toda la sección 4 de este informe se construyó a mano, familia por familia. Con esta matriz, el hueco siguiente se ve de un vistazo en lugar de requerir una auditoría de 10 agentes. Es la verificación mecánica de mayor rendimiento que puedes producir.
4. **Higiene de propiedad del checkout compartido** — Censar los **857** ficheros propiedad de `root` (`find . -user root -not -path './node_modules/*' -not -path './.git/*'`), separando (a) los 2 **versionados** (`ops/harness/fleet.mjs`, `ordenes/reportes/claude-duplex-cli.md`), (b) los 3 reportes untracked de `ordenes/reportes/`, (c) los ignorados (`dist/`, `.test-state/`, `ops/artifacts/`). Entregable: lista + el `chown` exacto por fila, **sin ejecutarlo**. *Por qué:* `runtime-package-smoke.mjs:104` compara uid y da falsos rojos; las instancias que corren como `stev` no pueden editar fuente versionada propiedad de root.
5. **`ops/README.md` líneas 7 y 26** — Reportar al integrador (la ruta no es tuya): documentan un profile de compose `shadow` que **no existe** (`deploy/compose.yaml` solo define `terminal`, `telegram`, `observability`×2) y afirman que `compose.dev.yaml` lo menciona (0 menciones). *Por qué:* es exactamente tu Tarea 2 (docs que mienten) y este caso quedó fuera del reporte entregado.
6. **`docs/mapa-de-ficheros.md`** — Refrescar tras la mudanza en vuelo `console/src/features/topology/**` → `console/src/features/live/hypergraph/**` (8 ficheros con `R` en git status ahora mismo). *Por qué:* el mapa es tuyo y el árbol se movió después de tu último pase; **espera a que Gemini cierre el commit** antes de medir.
7. **Commitear los 3 reportes untracked** (`minimax-docs-que-mienten.md`, `minimax-huerfanos-v2.md`, `minimax-mapa-credenciales.md`) con pathspec. *Por qué:* llevan desde las 20:47 sin versionar en un checkout compartido donde el protocolo prohíbe dejar trabajo sin commitear al cerrar turno.

### 3.4 CLAUDE — `scripts/**`, `ops/{systemd,generated,manifests,observability,config,guardias,container-runtime,openclaw-gateway,cli,patches,private,console-login}/**`, `ordenes/`, `plan-reestructura/`, integración

1. **`ordenes/00-PROTOCOLO.md:30`** — Añadir filas de sector para `packages/adapter-sdk/**` y `services/dispatcher/**`. *Por qué:* la propiedad por sector es la única protección anticolisión declarada, y dos árboles de código vivo están fuera de ella. Es el arreglo de menor coste y mayor efecto de todo el informe. (Referencia histórica de una asignación previa: `ordenes/reportes/minimax-docs-que-mienten.md:131` sitúa `adapter-sdk` en sector Codex.)
2. **`ops/generated/container-systemd/rootless/SHA256SUMS`** — Ejecutar `pnpm ops:manifests` y commitear el `SHA256SUMS` regenerado **en el mismo commit** que cualquier `.sha256` que cambie. *Por qué:* `main` está inconsistente ahora mismo (`OPERATIONS.sha256: FAILED`); `2d6045b` regeneró el hash hijo sin el padre.
3. **`scripts/calidad.mjs:11`** — Ampliar la selección de ficheros para incluir ejecutables sin extensión con shebang bash (detectar por primera línea, o enumerar `ops/cli/*`). *Por qué:* `ops/cli/cauce` (1.138 líneas, 12 fechas) es invisible al gate y está congelado en main. **Orden obligatorio:** limpiar las 12 fechas y decidir el tamaño **ANTES** de tocar `--update`; si se amnistía primero, la amnistía es para siempre.
4. **`scripts/calidad-base.json`** — Correr `node scripts/calidad.mjs --update` para podar `ops/pty-agent/rollout-pty.py` (1221→510) y `ops/scripts/update-alias-config.py` (1245→688), bajando el trinquete de 24 a 22 excepciones. *Por qué:* ambos ficheros ya están bajo 800 tras la partición modular de `995741d`; una excepción stale es una puerta abierta gratis.
5. **`package.json:17-22`** — Añadir `lint:ops` (`ops/harness ops/patches ops/scripts ops/tests`), `lint:tooling` (`scripts/*.mjs`), incluir `packages/adapter-sdk/{bridge,scripts}` en `lint:adapter` y `packages/mcp-fleet-monitor/*.mjs` en `lint:mcp`; encadenarlos todos en `pnpm lint`. *Por qué:* 37 `.mjs` editables por sectores activos no ven ESLint jamás, incluido `scripts/calidad.mjs`. Como `pnpm lint` ya está en CI, el efecto es inmediato. Presupuesta la primera limpieza (`no-undef` por globals no declarados: `languageOptions.globals` hoy solo lista `console/process/URL/Buffer/setTimeout/clearTimeout`).
6. **`package.json:33`** — Añadir `--filter @cauce/terminal-relay` a `test:services` (petición de Gemini; la raíz es tuya como integrador). *Por qué:* 14 suites de un servicio vivo sin ejecutar.
7. **`scripts/test-all.mjs:38`** — Extender `assertMatrixIsComplete()` para que falle también si un paquete del workspace declara script `test` y **ningún** `test:*` lo invoca. *Por qué:* hoy la guarda valida lo contrario (que todo `test:*` esté en el matrix), y ese ángulo muerto es exactamente por donde se coló `terminal-relay`. Convierte el fallo en irrepetible en lugar de arreglar el caso.
8. **`ops/scripts/validate.sh` (bucle de `compile()`, ~líneas 21-26)** — Añadir `sorted((root / 'guardias').glob('*.py'))`. *Por qué:* `hegel-ventas-checkin.py` corre como root cada día a las 13:00 UTC contra el gateway con mTLS y hoy no recibe ni un `compile()`. Son ~3 líneas. Complemento: cotejo repo-vs-host de `cred-guard.py`, que `PENDIENTES-DEL-DUEÑO.md:50` reporta divergido en kratos.
9. **`ops/guardias/cauce-envoltorio-local.sh:33,63,72`** — Aplicar el **doble** `printf '%q'` que el propio fichero ya usa en las líneas 106 y 119-120. Para `$ID` (línea 60), pasar por `psql -v id="$ID" -c "… where id = :'id';"` en vez de interpolar en el SQL. Añadir validación de entrada: `[[ $A =~ ^[A-Za-z0-9_-]+$ ]] || exit 2`. *Por qué:* con un solo nivel de escape, el texto atraviesa dos parseos (shell de login remoto + `bash -lc`) y el segundo lo trata como línea de comando; demostrado ejecutando el patrón en local. El riesgo hoy es bajo (entrada del operador), pero `ops/guardias/README.md:20` dice que esto se instala en **cada contenedor** y el dueño quiere hacerlo portátil.
10. **`ops/guardias/cauce-envoltorio-local.sh:3`** — Borrar `Lo escribio la sesion de relevo del 2026-07-31`, conservando la explicación funcional. *Por qué:* regla 4.
11. **`ops/config/prod.env.example` + `ops/config/dev.env.example`** — Retirar las 7 variables `SHADOW_ROUTER_*` / `CAUCE_SHADOW_*` (prod 91-97, dev 22-26; **0 lectores** en `.ts/.py/.mjs/.sh`); corregir el comentario de `prod.env.example:79-80` para no listar `origin-relay` como profile activo; retirar `CAUCE_RELAY_PROVIDER_MODULE_PATH:83` (sin lectores) o dejar constancia del plan; renombrar `CAUCE_BACKUP_STATUS_FILE:9` a `STATUS_DIR` o moverlo a `host-backup.env.example`. *Por qué:* el shadow router se purgó y el worker `relay-worker` se retiró (`tests/unit/relay-telegram-observability.test.ts:9-11` **exige** que no reaparezcan); `CAUCE_BACKUP_STATUS_FILE` no lo lee ningún script y ni siquiera vive en el fichero de entorno cableado al servicio (`EnvironmentFile=-/etc/cauce-v3/host-backup.env`).
12. **Propiedad de ficheros del checkout** — Corregir `ops/harness/fleet.mjs` y `ordenes/reportes/claude-duplex-cli.md` (versionados, `root:root`) y los 3 reportes untracked; establecer que ninguna instancia ejecute nada como root en el checkout compartido. *Por qué:* fuente versionada que un compañero no puede editar, y `runtime-package-smoke` da falsos rojos bajo uid ajeno.
13. **`ops/console-login/`** — Contiene solo un `README.md`. Si no va a alojar código, moverlo a `ops/runbooks/console-login.md` y retirarlo de la enumeración de la fila compartida de `00-PROTOCOLO.md:30`. *Por qué:* higiene; **corrección de dato**: no tiene fila propia, comparte fila con otros 11 directorios de `ops/`.
14. **`ops/container-runtime/cauce-container-runtime.py`** — 1.652 líneas, amnistiado y estable: vigilancia, separar supervisión/reaping/zombies si vuelve a crecer. *Por qué:* no urge; no lo engordes.

### 3.5 DUEÑO — decisiones, no ediciones

1. **CI (`.github/workflows/ci.yml`)** — Decidir qué subconjunto de `validate.sh` y del matrix entra. Recomendación: un job `pnpm ops:validate` entra **casi tal cual** (el script ya degrada con gracia si falta `docker compose`) y aporta de golpe `bash -n` + `compile()` + units generadas + los 7 tests de ops + la detección del `SHA256SUMS` stale. Las 3 suites con PostgreSQL real (`store-hardening`, `integration`, `e2e`) necesitan runner con Docker o self-hosted: **esa es la parte cara**, y puede ir en fase posterior. *Coste:* bajo el primer job, alto el runner.
2. **Instalar `shellcheck`** en la imagen de desarrollo y en CI, y hacer que su ausencia **falle** en vez de saltarse en silencio. *Coste:* bajo instalarlo, medio limpiar los avisos de la primera pasada sobre 38 ficheros nunca analizados.
3. **`ruff` para los 65 `.py`** — Es la primera dependencia de tooling Python en un repo cuyos gates son 100% Node/pnpm. Binario único, sin dependencias nativas. *Coste:* medio (decisión de reglas + primera limpieza). Sin esto, ningún `.py` recibe jamás análisis de imports muertos, nombres indefinidos ni shadowing.
4. **`deploy/**` (15 `.mjs` de runtime productivo sin lint)** — Está en NO TOCAR sin excepción, así que **ningún sector puede cerrarlo**. Basta con que autorices añadir `deploy` a un glob de lint: **cero cambios de contenido** en los ficheros. Hoy ni eso está permitido.
5. **Convención de ubicación de tests** — `gateway` y `terminal-relay` ponen `*.test.ts` junto al fuente; `dispatcher` y `telegram-bridge` en `test/` hermana. 2 contra 2, sin regla escrita. Documentar la elegida en `AGENTS.md` o unificar. *Coste:* trivial documentar, medio unificar.
6. **Criterio `tests/unit/` vs `ops/tests/`** — Ambos invocan por subproceso scripts de `ops/scripts/**`, pero solo el primero está en el gate obligatorio. Documentar cuándo va cada uno. *Coste:* trivial.
7. **P16 (`ops/tests/`, 9 ficheros sin runner)** — Ya está escalada a ti en `plan-reestructura/plano-objetivo.md:557`. La elección es binaria: engancharlos al gate (`unittest discover` para los 5 `.py`, líneas explícitas en `validate.sh` para los 4 `.mjs`) o `git rm`. **No abras tarea de sector por esto**; solo decide.
8. **Dirección de la unificación de tipos `console` ↔ `gateway`** — La cabecera recién borrada (sin commitear) decía que la fuente de verdad era **la consola**; el hallazgo propone `packages/protocol`. Además `console/package.json` **no depende** de `@cauce/protocol` a propósito (`features/live/perfil.ts:88-91`: "la consola es un bundle de navegador y `@cauce/protocol` arrastra zod entero"). Con `import type` puro el coste en bundle es cero, pero hay que dar de alta la dependencia de workspace o crear un submódulo de tipos sin zod. *Coste:* bajo técnico, requiere tu decisión para desbloquear a Codex.
9. **Política de idioma (es/en)** — 8 hallazgos de inventario con coste ya medido: `agent-profile.routes.ts` (12 exports mezclados), `tests/helpers/postgres.ts` (hub consumido por **62** ficheros de los 4 sectores), `packages/protocol/{marcas-de-bloque,ficheros-del-arnes,agent-profile}.ts`, `adapter-sdk/{harnesses/shared/errors,sdk/client}.ts`. Decide **una** de tres: (a) congelar el estado actual y documentarlo como aceptado, (b) regla "nombre público en inglés, interno libre", (c) homogeneizar con presupuesto. *Coste:* cero decidir; alto ejecutar (b) o (c). Mientras no decidas, esto reaparecerá en cada auditoría como 8 hallazgos "medios" que nadie puede accionar.
10. **`packages/store/migrations/**`** — Decenas de comentarios SQL narran fechas e incidentes ("la mató un humano con un `UPDATE` a mano en psql"), violando la regla 4, pero probablemente **predatan** la regla y la carpeta es fila NADIE hasta FASE 3. Declara excepción explícita o marca para limpieza en FASE 3. *Coste:* cero.
11. **Tablas `shadow_*` de `migrations/005`** — 4 tablas del subsistema purgado, sin consumidor real (la única referencia viva es un `TRUNCATE` mecánico de barrido en `tests/helpers/postgres.ts:246`). Migración forward-only de `DROP` o deuda documentada. *Coste:* bajo, pero solo tú puedes.
12. **`packages/adapter-sdk/test/shared-session.test.ts`** — 5.454 líneas, 6,8× el tope, el mayor del repo, amnistiado y estable. Partir por área de comportamiento antes de que crezca más. *Coste:* alto; no urge (el gate está verde). Depende también de la decisión 3.4.1 (adapter-sdk hoy no tiene dueño).

---

## 4. Los huecos de gate — la respuesta estructural

**La tesis:** de los 77 hallazgos, la inmensa mayoría no existiría si el gate mirase donde debe. La limpieza a mano se degrada; un gate no. Esta tabla es lo único de todo el informe que evita que la próxima auditoría vuelva a encontrar lo mismo.

| # | Hueco | Qué deja pasar HOY (medido) | Cierre | Coste | Quién |
|---|---|---|---|---|---|
| **G1** | El trinquete selecciona ficheros por **extensión** (`scripts/calidad.mjs:11`) | `ops/cli/cauce`: 1.138 líneas y 12 fechas, invisible y ni siquiera amnistiado | Detectar shebang bash en ficheros sin extensión | **Bajo** el cambio (1 función); **medio** la limpieza previa obligatoria | Claude |
| **G2** | ESLint no se **invoca** sobre 52 `.mjs`; **cero** linter para 65 `.py` | `migrate.mjs`, `readiness-probe.mjs`, `scripts/calidad.mjs` sin análisis; ningún `.py` ve imports muertos ni nombres indefinidos | `lint:ops` + `lint:tooling` + ampliar `lint:adapter`/`lint:mcp`; `ruff` como `lint:py` | **Bajo** los globs; **medio** la primera limpieza; `ruff` = primera dependencia Python | Claude (+dueño para ruff y `deploy/`) |
| **G3** | ESLint de `console/` **sin chequeo de tipos** | 109 violaciones, **31 promesas flotantes en producción**, con el gate en verde | `recommendedTypeChecked` + `projectService` | **Trivial** la config; **medio** arreglar las 31 | Gemini |
| **G4** | Nada comprueba que **todo paquete con script `test` sea invocado** | 14 suites de `terminal-relay` sin ejecutar nunca, mientras typecheck y lint las cubrían y todo parecía verde | Extender `assertMatrixIsComplete()` en `scripts/test-all.mjs` | **Bajo** (~20 líneas) | Claude |
| **G5** | **CI ≠ gate local**: 4 comandos, 2 de 8 suites, `ops:validate` nunca | `SHA256SUMS` stale congelado en main; `bash -n`, `compile()`, units generadas y `docker compose config` nunca corren | Job `pnpm ops:validate` (entra casi tal cual) + runner con Docker para las 3 suites pesadas | **Medio** el primer job; **alto** el runner | Dueño |
| **G6** | `shellcheck` **condicional sin instalar** = no-op silencioso | Cobertura real de análisis shell: **0 de 38** ficheros | Instalarlo y **fallar** si falta; ampliar el glob a los 10 sueltos | **Bajo** + **medio** la primera limpieza | Dueño + Codex |
| **G7** | **Nada verifica las citas `fichero:línea` de los comentarios** | 20 citas rotas, 3 apuntando a una función inexistente, contagiadas por copia a 8 ficheros — y un test en verde que certifica una de ellas | Regla nueva en `calidad.mjs`: extraer toda `ruta.ext:NNN` de comentarios y fallar si el fichero no existe o tiene menos de NNN líneas | **~80 líneas** + limpiar las 20 | Claude (gate) + Gemini (citas) + MiniMax (censo previo) |
| **G8** | El trinquete **solo sube, nunca baja**: no hay poda automática | 2 excepciones stale sobrevivieron a la limpieza de HOY porque esa limpieza solo podó la sección `fechas` | Que `calidad.mjs` avise (o falle) si una entrada del baseline supera al valor real en >10% | **Bajo** | Claude |
| **G9** | La **tabla de sectores no se comprueba** contra el árbol | `packages/adapter-sdk/**` y `services/dispatcher/**` sin dueño ni revisor, en un protocolo cuya única protección es la propiedad por sector | Test mecánico: todo directorio versionado de primer/segundo nivel casa con alguna fila de la tabla | **Bajo** (~40 líneas en `ops/tests/`) | Claude |
| **G10** | Nada impide **ejecutar como root** en el checkout compartido | 857 ficheros `root:root`, **2 de ellos versionados**; `runtime-package-smoke` compara uid y da falsos rojos a los demás | Comprobación de uid al arrancar el gate + `chown` de saneo | **Bajo** | Claude |

**Si solo se cierran tres, que sean G4, G7 y G9.** G4 hace imposible que un paquete de test quede sin ejecutar; G7 convierte una cita rota en un fallo de gate en lugar de en un test verde; G9 hace imposible que aparezca código sin dueño. Los tres cuestan poco y los tres cierran clases enteras de fallo, no casos. **G5 es el que más rinde**, pero es el más caro y solo tú puedes decidirlo.

---

## 5. Transparencia del método: rechazados por el verificador

Cada familia pasó por un verificador adversarial cuyo trabajo era **tumbar** los hallazgos, no confirmarlos.

| Familia | Confirmados | Rechazados | Correcciones aplicadas a supervivientes |
|---|---:|---:|---|
| inconexo | **0** | **1** | — (la familia entera cayó) |
| duplicado-codigo | 11 | **2** | 3 hechos corregidos: `HELLO` no es idéntico en 4 sino en 3 de **7** declaraciones; `INSERT INTO messages` está en **7** ficheros, no 4; los tipos de directiva llevaban una cabecera que declaraba la copia como intencional, borrada sin commitear |
| tamano-y-orden | 20 | 0 | 1 caracterización corregida: `ops/console-login/` **no** tiene fila propia, comparte fila con 11 directorios más |
| comentarios-v2 | 20 | 0 | — |
| gates-cobertura | 9 | 0 | **6 hallazgos reescritos**: `.sh` son 38 y no 39 (10 fuera, no 11); "los 65 `.py` solo reciben compile()" era **falso** (23 tienen suite unittest que corre en CI); `ops/cli/cauce` ya **no** está en estado `M` sino congelado en main; se **retiró** por no verificable la cifra "18 aserciones de política de despliegue"; `cauce-cuentas.py` no lo dispara ningún timer |
| artefactos-residuos | 4 | 0 | 2 detalles: el comentario de `origin-relay` está en 79-80 (no 78-79); `host-backup-monitor.sh` usa `STATUS_FILE` (no `STATUS_DIR`) |
| codigo-mal-escrito | 3 | 0 | **1 hallazgo agravado**: el buscador dijo "no hay violaciones vivas, solo falta la red"; el verificador midió **109 violaciones y 31 bugs reales**. Además: el grep "probatorio" del hallazgo **no reproduce** (comillas simples vs dobles) y la comparación con los 4 servicios era falsa en 2 de 4 |
| dependencias | 2 | 0 | — (ambos verificados **empíricamente**, ocultando el binario y los tipos y reproduciendo el fallo exacto) |
| idioma-nombres | 8 | 0 | 1 desajuste cosmético: en 2 hallazgos el campo `linea` apunta al `export` en `index.ts`, no al fichero señalado |
| **TOTAL** | **77** | **3** | **13 hallazgos corregidos o agravados sin ser rechazados** |

**Tres notas de honestidad sobre el propio método:**

1. **El payload recibido contiene 9 familias, no 10.** No puedo decir cuál falta ni si volvió vacía o se perdió en el camino. Cuenta este informe como cobertura de 9/10.
2. **El único rechazo total (`inconexo`) es la lección más valiosa de la ronda.** `OutboxAckWithEffectCount` parecía un símbolo huérfano perfecto: una sola aparición en todo el repo, la propia declaración. Cuatro comprobaciones lo tumbaron — la orden viva de Codex lo prescribe palabra por palabra 13 minutos antes de que naciera el fichero, 2 de sus 3 hermanos ya tienen consumidor, el autor estaba tecleando en paralelo en ese mismo sector, y el "arreglo" propuesto exigía tocar `telegram-bridge`, que **es sector de Gemini**. Clase de falso positivo: **refactor ordenado en vuelo, medio ejecutado por sector**. Cualquier ronda futura que audite un árbol con 3 instancias editando en vivo debe cruzar todo candidato a "muerto" contra las órdenes activas y contra `find -newermt` antes de reportarlo.
3. **`idioma-nombres` reporta 7 en su nota y entrega 8 entradas.** He contado 8. Si el orquestador cuadra cifras, este es el descuadre.

**Lo que sí se verificó dos veces contra el filesystem vivo durante esta síntesis** (con 3 instancias editando el árbol en paralelo): `terminal-relay` sigue con 0 menciones en `package.json`; `ops/cli/cauce` sigue en 1.138 líneas; `shellcheck` sigue AUSENTE; `SHA256SUMS` sigue en FAILED; `packages/store/src/repository.ts` sigue teniendo 43 líneas mientras 4 ficheros citan su línea 5109; `selfRoleBrief` sigue sin existir; la tabla del protocolo sigue sin mencionar `adapter-sdk` ni `dispatcher`; el trinquete sigue con 24 excepciones y las 2 stale intactas; `console/eslint.config.js:10` sigue sin type-check; y `node scripts/calidad.mjs` sigue devolviendo **VERDE sobre 939 ficheros**.
