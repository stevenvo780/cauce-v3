# Entorno de desarrollo con base de datos real

- **Fecha:** 2026-08-29
- **Para qué:** dejar de trabajar contra mocks. Varios agentes estaban parados porque las suites de
  Postgres y el gateway no podían arrancar sin base.
- **Dónde aplica:** el contenedor de workspace (`ws-*`). **Nada de esto toca producción.**

## Qué hay montado ahora

| Pieza | Valor |
|---|---|
| Servidor | PostgreSQL 16.15 local, clúster `16/main`, puerto 5432 |
| Autenticación | `trust` para `127.0.0.1` y `::1`; **sin contraseña en ninguna URL** |
| Rol | `cauce` (superusuario del clúster local) |
| Base de desarrollo | `cauce_dev` — esquema real (34 migraciones, 62 tablas) + flota sembrada |
| Base de pruebas | `cauce_test` — el servidor del que cada suite talla su propia base efímera |

La contraseña se evita a propósito: una URL con credencial dentro acaba copiada en un fichero y el
escaneo de secretos de GitHub bloquea el push. La base vive dentro del contenedor y no se expone.

## Arrancar (después de reiniciar el contenedor)

El clúster no se levanta solo porque aquí no hay systemd:

```bash
sudo pg_ctlcluster 16 main start
pg_isready -h 127.0.0.1 -p 5432        # -> accepting connections
```

## Correr las suites que necesitan Postgres

Son **65 ficheros** que antes no se podían ejecutar en este workspace:

```bash
CAUCE_TEST_DATABASE_URL="postgresql://cauce@127.0.0.1:5432/cauce_test" \
  npx vitest run packages/store/test tests/store-hardening tests/gateway-hardening tests/integration
```

**Cada fichero recibe su propia base efímera** (`cauce_test_e<hex>`), migrada desde cero y tirada al
terminar. No hace falta serializar con `--no-file-parallelism`.

> **Por qué la base es la unidad de aislamiento, y no la URL.** Compartir una sola base entre
> suites *parece* funcionar y envenena la corrida en silencio: las suites de integridad de
> migraciones insertan filas en `schema_migrations` **sin** su entrada de ledger, a propósito, para
> ejercitar la guardia de deriva. Con testcontainers ese daño muere con el contenedor del fichero;
> contra una base compartida, el primero de esos ficheros hace fallar a los 80 siguientes con
> `applied without an atomic source ledger`. Medido: 49 de 82 ficheros en rojo por esa única causa.
> El arreglo está en `tests/helpers/postgres.ts`, en la rama de base externa.

La guardia de nombre sigue en pie: `CAUCE_TEST_DATABASE_URL` sólo acepta bases cuyo nombre empiece
por `cauce_test`, porque las suites **TRUNCAN 30 tablas**. Apuntarla a otra base se rechaza antes de
abrir la conexión.

## La base de desarrollo y su flota

`cauce_dev` tiene el esquema real y una flota pequeña pero completa. Las migraciones ya siembran los
**cinco tenants y salas reales** (Steven como hub, más Isa, Jhon, Miguel y Pablo); el sembrador
añade lo que el esquema deja vacío:

| Grupo | Agentes | Arnés |
|---|---|---|
| `Steven` (hub, `grp.steven`) | `zeus`, `kant` | claude |
| `Miguel` (`grp.miguel`) | `kratos` | codex |

Con sus perfiles (`role_summary` tomado de `grupos.json`), sus membresías, la arista cruzada
Miguel↔Steven y tráfico real publicado por el propio repositorio: mensajes, entregas y un lease de
consumidor con una entrega reclamada.

```bash
DATABASE_URL="postgresql://cauce@127.0.0.1:5432/cauce_dev" npx tsx packages/store/src/seed-dev-cli.ts
```

Es **idempotente**: las claves de idempotencia son estables y el `INSERT` de agentes es
`ON CONFLICT DO UPDATE`. Correrlo dos veces no duplica nada.

El tráfico se publica con `CauceRepository`, nunca con `INSERT` a mano: una fila construida a mano
puede cumplir el esquema y ser algo que el código nunca habría producido.

### Rehacer la base de desarrollo desde cero

```bash
sudo -u postgres psql -tAc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='cauce_dev'"
sudo -u postgres psql -c "DROP DATABASE IF EXISTS cauce_dev" -c "CREATE DATABASE cauce_dev OWNER cauce"
NODE_ENV=development DATABASE_URL="postgresql://cauce@127.0.0.1:5432/cauce_dev" pnpm migrate:dev
DATABASE_URL="postgresql://cauce@127.0.0.1:5432/cauce_dev" npx tsx packages/store/src/seed-dev-cli.ts
```

> Si `DROP DATABASE` no termina la sesión primero, **falla en silencio** cuando alguien tiene la base
> abierta y te quedas con el estado viejo creyendo que la recreaste. Costó una corrida entera de
> diagnóstico: el `pg_terminate_backend` no es adorno.

## Levantar el gateway contra la base real

```bash
NODE_ENV=development DATABASE_URL="postgresql://cauce@127.0.0.1:5432/cauce_dev" \
  CAUCE_DEV_AUTH=1 pnpm dev:gateway
```

Levanta en `127.0.0.1:8080`. Desde ahí la consola puede correr **sin `VITE_USE_MOCKS`**, contra
datos que salen del esquema real.

## Lo que sigue sin poder hacerse aquí

- **No hay demonio de Docker** (`/var/run/docker.sock` no existe). El camino de `testcontainers`
  sigue muerto en este workspace; la variable de entorno es el único camino.
- Por eso falla **un** caso, y es legítimo:
  `migration-integrity-postgres.test.ts > derives the 024 contract from a clean database applying
  exactly through 024` levanta su **propio** contenedor a propósito. No se puede correr sin Docker y
  no hay que taparlo.
- **`pnpm test:services` y `pnpm test` completos** siguen sin verificarse en este entorno más allá de
  lo que cubre la orden de arriba.
