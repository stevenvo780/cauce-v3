# Orden de trabajo para MiniMax — limpieza mecánica de validaciones muertas

- **Repositorio:** `/workspace/cauce-v3`, rama `dev`
- **Origen:** `docs/auditorias/2026-08-29-validaciones-inconexas.md`, ya validado hallazgo por hallazgo
- **Alcance:** solo la parte mecánica. Lo delicado (contrato `notify` triplicado, `mcp-fleet-monitor`,
  unidades UTF-8/UTF-16, alias del relay, sesión compartida) **lo hace otra instancia en paralelo**.

## Paso 0 · Trabajá en tu propio worktree, no en el directorio compartido

**Antes de tocar nada**, aislate:

```bash
cd /workspace/cauce-v3
git worktree add ../cauce-v3-minimax dev
cd ../cauce-v3-minimax
pnpm install --frozen-lockfile
```

Todo lo de abajo se hace **ahí dentro**. Cuando termines, tus commits ya están en `dev` y quien
integra los ve sin que hayas escrito una sola vez en el árbol de los demás.

**Por qué no es opcional:** hay tres instancias escribiendo en `/workspace/cauce-v3` a la vez. Un
`git reset`, un `git checkout --` o un `git stash` de cualquiera de ellas borra lo que las otras
tengan sin commitear, y ninguna lo ve venir. Acordar rutas no alcanza: hace falta que cada una tenga
su propio índice y su propio árbol. Hoy ya costó un susto y una acusación equivocada.

Si `pnpm install` en el worktree te resulta caro y preferís el directorio compartido, **avisá antes
de empezar** y commiteá después de cada bloque, sin dejar nada sin commitear entre paso y paso.

## Reglas que no se negocian

1. **No decidas nada.** Cada paso de abajo dice qué borrar y qué escribir en su lugar. Si algo no
   coincide con lo que ves en el árbol, **PARÁ y reportá**; no improvises un equivalente.
2. **Ficheros prohibidos.** Otra instancia los está editando ahora mismo, y su trabajo ya está
   commiteado o en vuelo. Aunque trabajes en tu propio worktree, **no los toques**: el conflicto
   aparecería al integrar.
   - `packages/protocol/src/schemas/messages.ts`
   - `packages/adapter-sdk/src/sdk/output-parser/contract.ts` y `output-parser.ts`
   - `packages/adapter-sdk/src/shared-session/**`
   - `packages/store/src/repository/deliveries/contracts.ts`
   - `packages/mcp-fleet-monitor/**`
   - `services/terminal-relay/**`
   - `tests/unit/gate-probe-authority.test.ts`
   - `docs/**`
3. **Commit con pathspec, nunca `-a` ni `add -A`.** Un commit por bloque (son 4). Máximo 20 ficheros.
4. **El código muerto se borra**, no se comenta ni se deja `@deprecated`.
5. **Comentarios de código en inglés, sin fechas y sin nombres propios.** Si tu cambio deja un
   comentario que ya no describe el código, corregilo; no lo dejes mintiendo.
6. **Gate obligatorio antes de cada commit:** `pnpm typecheck && pnpm lint && pnpm test:unit`.
   Si sale rojo por un fichero que NO tocaste, **no lo arregles**: anotalo y seguí.
7. **No corras `vitest` con `--root`** desde la raíz: hay tests que leen ficheros por ruta relativa
   al cwd y fallan con un `ENOENT` que parece tuyo y no lo es.

---

## BLOQUE 1 · `adapter-sdk/src/sdk/client.ts` — dos cambios en un fichero

### 1.1 · Borrar la rama `FRAME_SCHEMA`, que es inalcanzable

En `packages/adapter-sdk/src/sdk/client.ts:644`, **borrá esta línea entera**:

```ts
  if (error.message.includes('outside the Cauce V3 schema')) return 'FRAME_SCHEMA';
```

Si justo encima hay un comentario que solo explica esa rama, borralo también.

**Por qué:** esa cadena aparece **una sola vez en todo el repositorio** y es en esa misma línea. No
hay ningún productor que la emita. Los frames inválidos de verdad se registran con
`error_code: 'INBOUND_FRAME_SCHEMA'` / `'OUTBOUND_FRAME_SCHEMA'` en
`websocket-transport.ts:141,175`, que es un campo del log, no el `error.message` que esta rama mira.

**Comprobación:** `rg "outside the Cauce V3 schema" --glob '!docs/**'` debe dar **0 resultados**.

### 1.2 · `validateIdentity` debe usar el esquema canónico, no una copia de su regex

En `packages/adapter-sdk/src/sdk/client.ts:41-43` está esto:

```ts
function validateIdentity(config: AdapterConfig): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(config.alias)) {
    throw new Error('Alias must be a stable lowercase identifier');
  }
```

Reemplazá **solo la condición del alias** por el esquema canónico:

```ts
  if (!AliasSchema.safeParse(config.alias).success) {
    throw new Error('Alias must be a stable lowercase identifier');
  }
```

y añadí `AliasSchema` al import que ya existe de `@cauce/protocol` en ese fichero.

**Ya está verificado que son equivalentes:** `AliasSchema` es
`z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)` en `packages/protocol/src/schemas/core.ts:7`, la misma
expresión carácter a carácter.

**NO toques** la validación de `instanceId` que está justo debajo: no tiene esquema canónico y
queda como está.

**Comprobación:** `rg "a-z0-9_-" packages/adapter-sdk/src/sdk/client.ts` no debe devolver la regex
del alias. El mensaje de error no cambia.

**Commit 1:** `consola/sdk: el alias se valida con el esquema canonico y cae la rama de error sin productor`

---

## BLOQUE 2 · Borrar `PREFLIGHT_ACK_ERROR_CODES`

### 2.1 · La constante y su auto-chequeo

En `packages/protocol/src/schemas/core.ts`, **borrá el bloque `41-55` completo**: la constante
`PREFLIGHT_ACK_ERROR_CODES`, la función `assertPreflightCodesAreNotAmbiguous` y la llamada suelta
`assertPreflightCodesAreNotAmbiguous();`. Borrá también el comentario que la introduce.

**Por qué:** cero consumidores en `packages/store/src`, `services/gateway/src` y
`services/dispatcher/src`. La política de retry real vive en
`packages/store/src/repository/deliveries/acks.ts` y decide con
`ack.retryable || isAmbiguousAckErrorCode(...)`. Los cinco productores del SDK escriben los literales
a mano. Añadir o quitar un código de esa lista **no cambia ningún comportamiento**.

**No borres** `isAmbiguousAckErrorCode` ni `AckErrorCodeSchema`: esos sí se usan.

### 2.2 · El test que se queda sin sujeto

En `packages/store/test/retry-policy-postgres.test.ts`, borrá el caso completo que empieza en la
línea 353:

```ts
  it('el esquema impide que un código de pre-vuelo entre en la lista de ambiguos', () => {
```

hasta su `});` de cierre. Y quitá `PREFLIGHT_ACK_ERROR_CODES` del import de la línea 4, dejando
`AckSchema` e `isAmbiguousAckErrorCode`, que el resto del fichero sigue usando.

**Por qué se borra en vez de adaptarse:** ese caso prueba que una lista sin lectores es coherente
consigo misma. No cubre ningún comportamiento del sistema.

**Comprobación:** `rg "PREFLIGHT_ACK_ERROR_CODES|assertPreflightCodesAreNotAmbiguous"` debe dar
**0 resultados fuera de `docs/`**.

**Commit 2:** `protocolo: se va la lista de codigos de pre-vuelo, que no ataba a ningun consumidor`

---

## BLOQUE 3 · Borrar `isHumanPriority`

### 3.1 · La función

En `packages/protocol/src/priority.ts`, borrá la función `isHumanPriority` completa (línea 28 y su
cuerpo) y el comentario que la documenta.

**No borres** `HUMAN_PRIORITY_FLOOR`, `HUMAN_CHAT_PRIORITY` ni `AGENT_PRIORITY_CEILING`: son las
constantes que el sistema sí usa.

**Por qué:** cero referencias de producción. La política equivalente vive en SQL
(`m.priority >= HUMAN_PRIORITY_FLOOR`, en `packages/store/src/repository/deliveries/claims.ts`). Un
predicado exportado desde el protocolo insinúa que el protocolo lo hace cumplir, y no lo hace.

### 3.2 · `packages/protocol/test/priority.test.ts`

Borrá las cuatro aserciones que llaman a `isHumanPriority` (líneas 16, 17, 29 y 45) y quitala del
import de la línea 4. Si algún `it(...)` se queda sin ninguna aserción, borrá el `it` entero.
**No borres** las aserciones sobre `PublishMessageSchema` ni sobre las constantes.

### 3.3 · `services/telegram-bridge/test/ingress.test.ts`

Ahí las dos aserciones sí cubren comportamiento y **hay que conservarlas reescritas contra la
constante que de verdad gobierna**:

- línea 55: `expect(isHumanPriority(published?.priority ?? 0)).toBe(true);`
  → `expect(published?.priority ?? 0).toBeGreaterThanOrEqual(HUMAN_PRIORITY_FLOOR);`
- línea 69: `expect(isHumanPriority(published?.priority ?? 0)).toBe(false);`
  → `expect(published?.priority ?? 0).toBeLessThan(HUMAN_PRIORITY_FLOOR);`

En el import de la línea 3, cambiá `isHumanPriority` por `HUMAN_PRIORITY_FLOOR`.

**Comprobación:** `rg "isHumanPriority"` debe dar **0 resultados fuera de `docs/`**, y los dos tests
de telegram siguen en verde.

**Commit 3:** `protocolo: cae isHumanPriority, que insinuaba una politica que el protocolo no aplica`

---

## BLOQUE 4 · El store deja de copiar la lista de tipos reservados

En `packages/store/src/repository/config/publish-policy.ts:24-29` hay esto:

```ts
export const reservedInternalMessageTypes = new Set([
  'agent.message',
  'agent.response',
  'agent.fanin',
  'agent.notify'
]);
```

Reemplazalo por:

```ts
export const reservedInternalMessageTypes = new Set<string>(RESERVED_INTERNAL_MESSAGE_TYPES);
```

y añadí `RESERVED_INTERNAL_MESSAGE_TYPES` al import de `@cauce/protocol` que **ya existe** en la
línea 5 de ese fichero (el que trae `SYSTEM_PRINCIPAL_ALIASES`).

**Ya está verificado que son idénticas:** en `packages/protocol/src/schemas/messages.ts:165`,
`RESERVED_INTERNAL_MESSAGE_TYPES` es `[...AGENT_TO_AGENT_MESSAGE_TYPES, 'agent.notify']`, y
`AGENT_TO_AGENT_MESSAGE_TYPES` es exactamente `['agent.message','agent.response','agent.fanin']`.
Mismos cuatro valores, mismo orden.

**Por qué importa:** hoy la constante canónica del protocolo **no tiene ni un importador externo**,
mientras esta copia se usa en 10 sitios de 5 ficheros del store. El contrato manda una copia y no el
canon: el día que el protocolo reserve un tipo nuevo, el store lo va a seguir dejando publicar.

**No cambies** ninguno de los 10 usos de `reservedInternalMessageTypes`: siguen igual, solo cambia de
dónde salen sus valores.

**Comprobación:** `rg "'agent.fanin'" packages/store/src/repository/config/publish-policy.ts` debe
dar **0 resultados**.

**Commit 4:** `store: los tipos internos reservados salen del protocolo en vez de una copia local`

---

## Verificación final, con la salida pegada

Corré esto y **pegá la salida real** en tu informe, sin resumirla:

```bash
cd /workspace/cauce-v3
pnpm typecheck 2>&1 | tail -4
pnpm lint 2>&1 | tail -4
pnpm test:unit 2>&1 | grep -E "Test Files|Tests |FAIL"
node scripts/calidad.mjs 2>&1 | tail -3
rg "outside the Cauce V3 schema|PREFLIGHT_ACK_ERROR_CODES|isHumanPriority" --glob '!docs/**'
```

Las tres cadenas del último comando deben dar **cero resultados**.

Punto de partida medido antes de esta orden: `node scripts/calidad.mjs` ya está en **ROJO** por
`tests/unit/protocol-profile-runtime-adoption.test.ts` (32 líneas de comentario, tope 21). **Ese rojo
no es tuyo y no lo arregles**: es de otra instancia. Si aparece cualquier otro rojo, sí es tuyo.

## Qué reportar al terminar

1. Los 4 hashes de commit.
2. La salida literal del gate, sin recortar.
3. Cualquier paso donde lo que viste en el árbol **no coincidía** con lo que dice esta orden.
4. **Qué no probaste.** Si no ejecutaste algo, escribí «no lo probé» con esas palabras. No hay
   Postgres en todos los workspaces: si `retry-policy-postgres.test.ts` no corre acá, decilo en vez
   de dar por bueno que pasa.
