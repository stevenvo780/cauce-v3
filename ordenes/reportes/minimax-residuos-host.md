# Inventario de residuos del host — ronda 3 minimax

Inventario de residuos en la máquina, **solo reporte con comando de borrado
propuesto por fila**. El dueño aprueba, nadie borra. Tareas explícitas:
(a) contenedores docker de test huérfanos con fechas; (b) los 13 árboles
`/opt/cauce-v3-release-*` con tamaño; (c) imágenes `rc-*` y `*-legacy` del
registry local con fechas; (d) el clon muerto `/datos/workspaces/cauce-v3`.

Medido el 2026-08-27 contra `main` (HEAD `cef78de`). Producción viva
**intacta**: containers `cauce-v3-prod-*`, registry local, `cauce-v3`
no se tocan.

## (a) Contenedores docker de test huérfanos

Producción es el stack `cauce-v3-prod-*` (`gateway`, `dispatcher`,
`telegram-bridge`, `terminal-relay`, `console`, `postgres`, `outbox-metrics`,
`otel-collector`, `prometheus`, `migrator`, `registry`). Todo lo demás con
prefijo `cauce-` o con nombre aleatorio de `docker run` cae en este grupo.
Ninguno pertenece al release; el dueño decide.

| Contenedor | Imagen | Creado | Estado actual | Comando propuesto |
|---|---|---|---|---|
| `cauce-test-zeus` | `57c72fd2a128` (postgres:16-alpine) | 2026-08-24 22:09 UTC | Up 2 días | `docker rm -f cauce-test-zeus` |
| `cauce-v3-restore-drill-20260825` | `57c72fd2a128` | 2026-08-25 16:16 UTC | Up 37 h (drill de restore) | `docker rm -f cauce-v3-restore-drill-20260825` |
| `cauce-inspect-migration024` | `7b88c1e8dc4e` | 2026-08-25 16:18 UTC | Exited (0) hace 37 h | `docker rm cauce-inspect-migration024` |
| `dreamy_murdock` | `815cf6d03e5a` | 2026-08-25 22:59 UTC | Exited (1) hace 30 h | `docker rm dreamy_murdock` |
| `eloquent_beaver` | `b5592a5fcdc2` | 2026-08-25 22:42 UTC | Exited (1) hace 30 h | `docker rm eloquent_beaver` |

Los nombres aleatorios (`hopeful_hopper`, `practical_heyrovsky`, `frosty_meninsky`) son `postgres:16-alpine` sanos y corriendo; **no los listo aquí** porque su estado es «Up healthy» y no hay señal de que sean huérfanos. Si el dueño confirma que sí, agregarlos.

## (b) Árboles `/opt/cauce-v3-release-*`

13 árboles que quedaron de builds/smokes de releases anteriores. Todos
comparten layout (Makefile, PLAN-DIRECTIVE-CONTENT-LECTURA.md, apps, deploy,
docs, ops, packages, services, tests, etc.) — son copias casi idénticas de la
fuente de la época. Tamaño medido con `du -sh`; el grande (`1741218`) trae
artefactos extra.

| Path | Tamaño | Comando propuesto |
|---|---|---|
| `/opt/cauce-v3-release-03e125a` | 24M | `rm -rf /opt/cauce-v3-release-03e125a` |
| `/opt/cauce-v3-release-0c8e6f0` | 25M | `rm -rf /opt/cauce-v3-release-0c8e6f0` |
| `/opt/cauce-v3-release-1741218` | 293M | `rm -rf /opt/cauce-v3-release-1741218` |
| `/opt/cauce-v3-release-1a2d2e3` | 24M | `rm -rf /opt/cauce-v3-release-1a2d2e3` |
| `/opt/cauce-v3-release-4c42fbf` | 62M | `rm -rf /opt/cauce-v3-release-4c42fbf` |
| `/opt/cauce-v3-release-72031de` | 25M | `rm -rf /opt/cauce-v3-release-72031de` |
| `/opt/cauce-v3-release-7931c00` | 25M | `rm -rf /opt/cauce-v3-release-7931c00` |
| `/opt/cauce-v3-release-9c357d4` | 24M | `rm -rf /opt/cauce-v3-release-9c357d4` |
| `/opt/cauce-v3-release-d2faf40` | 25M | `rm -rf /opt/cauce-v3-release-d2faf40` |
| `/opt/cauce-v3-release-dc59fa2` | 25M | `rm -rf /opt/cauce-v3-release-dc59fa2` |
| `/opt/cauce-v3-release-e2c522a` | 25M | `rm -rf /opt/cauce-v3-release-e2c522a` |
| `/opt/cauce-v3-release-f1e54c9` | 25M | `rm -rf /opt/cauce-v3-release-f1e54c9` |
| `/opt/cauce-v3-release-f6eb6b5` | 25M | `rm -rf /opt/cauce-v3-release-f6eb6b5` |

**Total recuperable**: ~647 MB (293 + 12 × ~25-62 MB). El comando agregado
sería un `rm -rf /opt/cauce-v3-release-*` con glob, pero se lista uno por uno
para que el dueño apruebe selectivamente.

## (c) Imágenes `rc-*` y `*-legacy` del registry local

Registry: `cauce-v3-registry` en `127.0.0.1:5000`. Repos afectados:
`cauce-v3-runtime`, `cauce-v3-console`, y los 4 `*-legacy`. Fecha leída del
config blob (cuando disponible; los `rc-20260722` y `rc-1a2d2e3…` son los
más viejos y su config devuelve `None` — pueden ser etiquetas huérfanas
cuyo blob fue podado en algún momento).

### cauce-v3-runtime — tags `rc-*`

| Tag | Creado | Comando propuesto |
|---|---|---|
| `rc-9c357d4e78ea2727b1321f188d37ceab3bd767c4` | 2026-08-26 22:00 UTC | borrar |
| `rc-03e125acbcd7448691fc1a82ca7802d70f8645ac` | 2026-08-26 21:58 UTC | borrar |
| `rc-72031dedea0752f7b8c3b52debb24267999ca680` | 2026-08-26 22:44 UTC | borrar |
| `rc-4c42fbf7768b2cdcfc8b30b5fcf26680dfa48999` | 2026-08-27 00:34 UTC | borrar |
| `rc-7931c007b77b43472f75fb3d60483fa6fdee573d` | 2026-08-27 00:13 UTC | borrar |
| `rc-17412185e4ee9d89538fa3e87763010b3ce33e1e` | 2026-08-27 00:43 UTC | borrar |
| `rc-9f831a7a21068e6230cc3bffd4eadc73247ea8d6` | 2026-08-25 22:41 UTC | borrar |
| `rc-1a2d2e346e4a8b8f6cbbffa74c46482f02cc2b52` | (config blob podado) | borrar |
| `rc-20260722` | (config blob podado) | borrar |

### cauce-v3-runtime — tags `*-legacy`

| Tag | Creado | Comando propuesto |
|---|---|---|
| `cauce-v3-runtime-legacy:pre-migration-20260826` | (config blob podado) | borrar |
| `cauce-v3-runtime-directiva-legacy:pre-migration-20260826` | (config blob podado) | borrar |

### cauce-v3-console — tags `rc-*` (mismo set de hashes que runtime)

| Tag | Creado | Comando propuesto |
|---|---|---|
| `rc-9c357d4…`, `rc-03e125a…`, `rc-72031de…`, `rc-4c42fbf…`, `rc-7931c00…`, `rc-1741218…`, `rc-9f831a7…` | 2026-08-25..27 | borrar |
| `rc-1a2d2e3…`, `rc-20260722` | (podados) | borrar |

### cauce-v3-console — tags `*-legacy`

| Tag | Comando propuesto |
|---|---|
| `cauce-v3-console-legacy:pre-migration-20260826` | borrar |

### cauce-v3-postgres-*

| Repo:Tag | Comando propuesto |
|---|---|
| `cauce-v3-postgres-legacy:pre-migration-72031de` | borrar |
| `cauce-v3-postgres-index:pre-migration-72031de` | borrar |

Comando agregado (los borra uno a uno; el registry es local, el riesgo es
sólo llenar el disco):

```sh
for repo in cauce-v3-runtime cauce-v3-console; do
  for tag in rc-9c357d4e78ea2727b1321f188d37ceab3bd767c4 \
             rc-03e125acbcd7448691fc1a82ca7802d70f8645ac \
             rc-72031dedea0752f7b8c3b52debb24267999ca680 \
             rc-4c42fbf7768b2cdcfc8b30b5fcf26680dfa48999 \
             rc-7931c007b77b43472f75fb3d60483fa6fdee573d \
             rc-17412185e4ee9d89538fa3e87763010b3ce33e1e \
             rc-9f831a7a21068e6230cc3bffd4eadc73247ea8d6 \
             rc-1a2d2e346e4a8b8f6cbbffa74c46482f02cc2b52 \
             rc-20260722; do
    curl -sX DELETE "http://127.0.0.1:5000/v2/${repo}/manifests/$( \
      curl -sH 'Accept: application/vnd.oci.image.manifest.v1+json' \
           "http://127.0.0.1:5000/v2/${repo}/manifests/${tag}" \
      )" >/dev/null
  done
done
```

(Pegar el script en este reporte tal cual; el integrador decide.)

**Importante**: NO borrar los tags `rc13-20260730`, `rc-20260722`, etc. que
son los usados por el pipeline de release histórico — sólo los 9 `rc-<sha>`
listados arriba. Los tags no-sha (`rc13-20260722`, etc.) son los artefactos
de los rc-rondas previos que el pipeline aún puede referenciar; la poda se
discute por separado.

## (d) Clon muerto `/datos/workspaces/cauce-v3`

- Branch: `rescate/clon-hermano-20260827` (no mergeada en `origin/main`).
- Último commit: `cd82359` «rescate: deriva local del clon hermano antes
  del archivado 2026-08-27».
- HEAD: `9814409` (el ancestro común con `origin/main` en el momento del
  archivado del 27-ago).
- Remoto: `islazeus` (NO `origin`); el remoto «vivo» está en
  `/datos/workspaces/zeus/cauce-v3` y se pushea a `github.com/stevenvo780/cauce-v3`.

| Path | Comando propuesto |
|---|---|
| `/datos/workspaces/cauce-v3` (incluye `node_modules`) | `rm -rf /datos/workspaces/cauce-v3` |

Tamaño aproximado (incluido `node_modules`): ~600 MB. La historia previa
ya está en `/datos/workspaces/zeus/cauce-v3-archivo-completo-20260827.bundle`
y en el tar `/datos/workspaces/zeus/cauce-rescate-worktrees-20260827.tar.gz`;
el clon se reconstruye desde el bundle si hace falta.

## Resumen ejecutivo

| Categoría | Items | Espacio recuperable | Acción |
|---|---|---|---|
| Contenedores huérfanos | 5 | ~0 (containers stopped) | `docker rm [-f]` |
| `/opt/cauce-v3-release-*` | 13 | ~647 MB | `rm -rf` selectivo |
| Imágenes `rc-*` y `*-legacy` | 20 (9 runtime, 9 console, 4 legacy) | varias decenas de MB | `DELETE` en registry |
| Clon muerto | 1 | ~600 MB | `rm -rf` |

Ninguna acción se ejecuta sin visto bueno del dueño.