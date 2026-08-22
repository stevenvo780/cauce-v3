# Runbook: la consola de producción vive en una rama que no está en `main`

**Estado al 2026-08-22.** Todo lo que sigue está medido en este repo, con los comandos que se citan.
Lo que no pude comprobar desde acá va marcado como **NO COMPROBADO** y con qué comando comprobarlo.

---

## 1. El riesgo, en una frase

**Quien construya la consola desde `main` manda a producción una consola sin la vista «La flota
ahora», sin login por contraseña y sin la vista de licencias — y no recibe un solo error que se lo
avise.** El build pasa, los tests pasan, el gate pasa. Lo único que cambia es que la pantalla que el
dueño usa todos los días deja de existir, y nadie se entera hasta que alguien la abre.

No es una hipótesis. Es lo que produce hoy `git checkout main && pnpm build:console`.

---

## 2. Qué está medido

```sh
# La rama NO es ancestro de main:
git merge-base --is-ancestor feat/consola-flota-ahora-20260822 main && echo SI || echo NO
# → NO

# Cuánto han divergido (izquierda = commits sólo en main, derecha = sólo en la rama):
git rev-list --left-right --count main...feat/consola-flota-ahora-20260822
# → 19    16

# El tamaño de lo que main no tiene:
git diff --stat main...feat/consola-flota-ahora-20260822 | tail -1
# → 76 files changed, 13386 insertions(+), 737 deletions(-)

# Y el hecho más concreto: en main la carpeta de la vista no existe.
git ls-tree -r --name-only main -- apps/console/src/features/live | wc -l
# → 0
```

La rama cuelga de `feat/consola-viva-20260806`, que tampoco está en `main`
(`git merge-base --is-ancestor feat/consola-viva-20260806 main` → NO). El antepasado común de las
dos historias es `0166e598`.

### Lo que `main` NO tiene (se perdería al construir desde `main`)

| Qué | Dónde |
|---|---|
| La vista «La flota ahora» entera | `apps/console/src/features/live/` (13 ficheros, 0 en `main`) |
| Login humano por contraseña + JWT | `services/gateway/src/password-auth.ts`, `password.ts`, `console-users.ts`, `console-user-cli.ts` |
| La tabla de usuarios de consola | `packages/store/migrations/023_console_users.sql` |
| Vista única de licencias | `apps/console/src/features/licenses/` |
| Lista blanca de rutas en el borde público | `ops/console-login/patch-caddy-lista-blanca.py`, `deploy/nginx-console-tls.conf` |
| El E2E real del login contra Postgres efímero | `tests/e2e/console-login.test.ts` |

### Lo que la RAMA no tiene (se perdería al desplegar el runtime desde la rama)

Los 19 commits de `main` son casi todos de runtime, no de consola, y varios son arreglos caros:
política de reintentos R1/R2/R3/R6, «un ambiguo sin ejecución se reintenta en vez de morir en el
intento 1», el adjunto inválido que mataba la cola de un alias, el cursor de codex 0.145, y la
sesión compartida que ya no le borra la conversación al alias.

**Por eso el riesgo es simétrico y por eso la salida no es «desplegar la rama»: es fusionar.**

---

## 3. La buena noticia: la fusión no tiene conflictos

Medido, no supuesto:

```sh
# Ningún fichero fue tocado por los dos lados desde el antepasado común:
comm -12 <(git diff --name-only 0166e598..main | sort) \
         <(git diff --name-only 0166e598..feat/consola-flota-ahora-20260822 | sort)
# → (vacío)

# Y la fusión en seco sale limpia (exit 0, sólo el OID del árbol resultante):
git merge-tree --write-tree main feat/consola-flota-ahora-20260822
# → 567a05d4e12c6291faced2039030e30fb8f14815   (sin bloque de conflictos)
```

Un `merge-tree` limpio dice que **git** no encuentra choque textual. No dice que el resultado
compile ni que los tests pasen: los dos lados tocan `services/gateway/src/*` en ficheros distintos y
un `main.ts` que registra rutas nuevas puede chocar semánticamente con un `auth.ts` que main movió.
Por eso el plan de abajo compila y prueba ANTES de empujar nada.

---

## 4. Las dos cosas que sí hay que mirar a mano

### 4.1 El hueco del `022` en las migraciones

`main` llega hasta `021_failure_notice_coalescing.sql`. La rama añade `023_console_users.sql`.
**Ninguno de los dos tiene un `022`**: existió (`50b539e`, `022_execution_lifetime.sql`) y ya no está
en la punta de `main`.

El hueco en sí es inofensivo: `applyMigrations` (`packages/store/src/db.ts:81-99`) ordena por nombre
de fichero y salta las que ya figuran en `schema_migrations` por su nombre EXACTO — no exige que la
numeración sea contigua.

Lo que sí sería un problema es que otra rama viva reutilice el número `022` con otro contenido: dos
ficheros distintos con el mismo prefijo se aplicarían en un orden que depende del resto del nombre, y
en una base donde uno ya está aplicado el otro entraría sin que nada lo note. **Antes de fusionar,
comprobar que nadie más está usando `022`:**

```sh
git log --all --oneline --diff-filter=A -- 'packages/store/migrations/022_*'
```

### 4.2 El runtime de producción tiene que traer ya el login

La consola de la rama pide `POST /v3/console/auth/login`. Si el runtime que corre en producción
saliera de `main`, esa ruta no existiría y la consola nueva quedaría con una pantalla de login que no
puede autenticar contra nada.

**NO COMPROBADO desde este worktree** — no tengo acceso al host. Se comprueba así, y hay que hacerlo
ANTES de tocar nada:

```sh
# ¿La ruta existe en el gateway que está corriendo?
ssh kratos "cd /datos/workspaces/cauce-v3 && docker compose -f deploy/compose.yaml exec -T gateway \
  node -e \"process.exit(0)\" && docker compose -f deploy/compose.yaml exec -T gateway \
  sh -c 'grep -rl \"console/auth/login\" dist | head -1'"

# ¿La migración 023 está aplicada?
ssh kratos "cd /datos/workspaces/cauce-v3 && docker compose -f deploy/compose.yaml exec -T gateway \
  node -e 'import(\"@cauce/store\").then(async m => { /* … */ })'"
# o, más simple y directo, contra la DB:
#   SELECT version FROM schema_migrations ORDER BY version;
```

Si el runtime de producción NO trae el login, el orden correcto es: fusionar → desplegar runtime →
migrar → recién entonces desplegar la consola. Nunca al revés.

---

## 5. El plan de fusión, con los comandos

Se hace con **una rama de integración**, no fusionando directo sobre `main`: si algo no compila hay
que poder tirar la rama y volver a empezar sin haber tocado la punta de la que todos parten.

```sh
# 0 — punto de partida limpio y con la rama ya empujada a kratos (zeus la empujó el 2026-08-22).
git fetch kratos
git rev-parse kratos/desde-zeus/feat/consola-flota-ahora-20260822
# → d3411debcf53b75b180c5516cf11d329fbc1c144   (la que está desplegada, más los arreglos de esta tanda)

# 1 — rama de integración desde main.
git switch -c integracion/consola-a-main main

# 2 — la fusión. Sin --squash: los 16 commits cuentan una historia y el squash la borra,
#     y esta rama tiene tres cambios independientes (login, licencias, vista live) que
#     mañana hay que poder revertir por separado.
git merge --no-ff kratos/desde-zeus/feat/consola-flota-ahora-20260822
# medido el 2026-08-22: sin conflictos.

# 3 — LO QUE DE VERDAD ACREDITA LA FUSIÓN. El merge-tree limpio no prueba nada de esto.
pnpm install --frozen-lockfile
pnpm -C apps/console exec tsc --noEmit -p tsconfig.app.json
pnpm -C apps/console exec eslint . --max-warnings 0
pnpm -C apps/console exec vitest run
pnpm build:core && pnpm build:console
pnpm test            # la suite entera, no sólo la de consola: la rama toca el gateway

# 4 — comprobación de que lo que se estaba perdiendo está DENTRO del resultado.
#     No basta con que compile: hay que ver la vista y el login en el árbol fusionado.
git ls-tree -r --name-only HEAD -- apps/console/src/features/live | wc -l   # > 0
git ls-tree -r --name-only HEAD -- services/gateway/src/password-auth.ts    # existe
grep -rn "R1\|ambiguo" packages/store/src --include=*.ts | head -3          # lo de main sigue ahí

# 5 — y que el BUNDLE construido contiene la vista, que es lo único que llega al navegador.
grep -rq "La flota ahora" apps/console/dist/assets/*.js && echo "la vista está en el bundle"

# 6 — recién ahora, a main.
git switch main
git merge --ff-only integracion/consola-a-main
git push origin main
git push kratos main
```

### Si el paso 3 falla

No se arregla sobre `main`. Se arregla en `integracion/consola-a-main`, con un commit propio que
explique el choque semántico, y se vuelve al paso 3. La punta de `main` no se toca hasta que la
secuencia entera pasa.

---

## 6. Después de fusionar: qué desplegar y en qué orden

1. **Runtime**, si y sólo si el punto 4.2 dijo que hace falta. `ops/runbooks/deploy.md`, con
   `make -C ops release-build` + `release-gate`. Es el paso caro y el que puede tirar entregas en
   vuelo: si el runtime de producción ya trae el login y las migraciones, **saltearlo**.
2. **Migraciones**, si `023` no estaba aplicada: `ops/scripts/migrate.sh`. Forward-only.
3. **Consola sola**: `ops/scripts/release-console.sh desplegar` (o `make -C ops release-console`) — construye
   `--target console`, pinea `CAUCE_CONSOLE_IMAGE` con respaldo previo, recrea sólo el servicio
   `console` y verifica por efecto que el bundle servido contiene la vista. Trae su propia vuelta
   atrás: `release-console.sh revertir`.

---

## 7. Cómo evitar que vuelva a pasar

Lo que hizo posible este agujero es que **construir desde `main` produce un artefacto plausible**:
sin error, sin aviso, sólo con menos cosas dentro. Dos guardas baratas lo cierran:

- **Una comprobación de bundle en el gate.** `release-gate.sh` ya exige que los digests coincidan con
  la evidencia; añadirle un `grep` del bundle de consola por una marca de la vista convierte
  «se construyó» en «se construyó CON la vista». Es exactamente lo que hace el paso (b) de
  `release-console.sh`, y no cuesta nada moverlo al gate.
- **Que la rama de producción sea `main`.** Mientras la consola desplegada viva en una rama larga,
  cada despliegue es una decisión sobre qué historia usar, y esa decisión se toma a las tres de la
  mañana. La fusión de arriba no es sólo higiene: es lo que quita la decisión.

---

## 8. Lo que este runbook NO acredita

- **No probé la fusión más allá de `merge-tree --write-tree`.** No ejecuté los pasos 3 a 6; están
  escritos para que los ejecute quien fusione.
- **No comprobé el estado de producción**: ni qué runtime corre, ni si `023` está aplicada, ni si
  `/v3/console/auth/login` existe en el gateway desplegado. El § 4.2 dice cómo comprobarlo.
- **No empujé nada.** La rama `desde-zeus/feat/consola-flota-ahora-20260822` ya estaba en `kratos`
  antes de esta tanda; los arreglos de los diez defectos van en una rama aparte.
