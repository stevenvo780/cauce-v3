# Inventario de residuos del host — ronda 6 minimax

Inventario de residuos en la máquina, **solo reporte con comando de borrado
propuesto por fila**. El dueño aprueba, nadie borra. Tareas explícitas:
(a) contenedores docker de test huérfanos con fechas; (b) los 13 árboles
`/opt/cauce-v3-release-*` con tamaño; (c) imágenes `rc-*`/`*-legacy`/
`verificacion-dockerfile-fix` del registry local y del daemon, con fechas
y tamaño; (d) el clon muerto `/datos/workspaces/cauce-v3`.

Medido el **2026-08-27** contra `main` (HEAD `7a0f0d3`). Producción viva
**intacta**: containers `cauce-v3-prod-*`, registry local, `cauce-v3`
no se tocan. NO se incluyen las imágenes activas `cauce-sep/{ctrl-infra,
ws-humanizar, ws-prizma}`: son el runtime de la flota viva
(medidas: 15 GB / 32 GB / 57 GB). Sí entran candidatos huérfanos del
daemon y rc-s del registry.

## (a) Contenedores docker de test huérfanos

Producción es el stack `cauce-v3-prod-*` (`gateway`, `dispatcher`,
`telegram-bridge`, `terminal-relay`, `console`, `postgres`, `outbox-metrics`,
`otel-collector`, `prometheus`, `migrator`, `registry`). También son vivos
y se quedan: `cauce-v3-registry`, `koinonia-{web,api,postgres}`,
`medico-nav-{console,gateway,postgres}-1`, `claw`, `claw-miguel`,
`claw-iza`, `ws-{zeus,humanizar,prizma}`, `agv2-miguel-finca-oc`,
`graf-hub-dev-*`, `single-node-wazuh-*`, `headscale`, `headplane`,
`vaultwarden`, `demeter-postgres`, `xenia-dev-postgres`, `agora-host-sync`.
Sale de este grupo el stack `agv2-*` y los `edu-worker-*`.

Huérfanos reales hoy (medido el 2026-08-27 ~05:08 UTC):

| Contenedor | Imagen | Creado | Estado | Comando propuesto |
|---|---|---|---|---|
| `cauce-v3-restore-drill-20260825` | `57c72fd2a128` (postgres:16-alpine) | 2026-08-25 16:16 UTC | Up 37 h | `docker rm -f cauce-v3-restore-drill-20260825` |
| `cauce-test-zeus` | `57c72fd2a128` | 2026-08-24 22:09 UTC | Up 2 días | `docker rm -f cauce-test-zeus` |
| `cauce-inspect-migration024` | `7b88c1e8dc4e` | 2026-08-25 16:18 UTC | Exited (0) hace 37 h | `docker rm cauce-inspect-migration024` |
| `dreamy_murdock` | `815cf6d03e5a` | 2026-08-25 22:59 UTC | Exited (1) hace 31 h | `docker rm dreamy_murdock` |
| `eloquent_beaver` | `b5592a5fcdc2` | 2026-08-25 22:42 UTC | Exited (1) hace 31 h | `docker rm eloquent_beaver` |
| `hopeful_hopper` | `57c72fd2a128` | 2026-08-26 17:48 UTC | Up 12 h (healthy) | `docker rm -f hopeful_hopper` |
| `practical_heyrovsky` | `57c72fd2a128` | 2026-08-26 06:36 UTC | Up 23 h (healthy) | `docker rm -f practical_heyrovsky` |
| `frosty_meninsky` | `57c72fd2a128` | 2026-08-25 18:32 UTC | Up 35 h (healthy) | `docker rm -f frosty_meninsky` |

Los tres `*_hopper/*_heyrovsky/*_meninsky` están `Up (healthy)` y son
postgres:16-alpine. No hay identificación de quién los levantó
(nombres aleatorios de `docker run`). El dueño decide si son de tests
pasados o quedaron enganchados.

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

**Total recuperable**: **~620 MB** (293 + 12 × ~25–62 MB). El comando agregado
sería un `rm -rf /opt/cauce-v3-release-*` con glob, pero se lista uno por uno
para que el dueño apruebe selectivamente.

## (c) Imágenes `rc-*`/`*-legacy`/`verificacion-dockerfile-fix` del registry y del daemon

### c.1 — registry `127.0.0.1:5000` — tags `rc-<sha>` huérfanos

Sólo los 9 `rc-<sha>` listados abajo: el resto de tags del registry (incluidos
`rc13-20260722`, `rc-20260722`, `release-20260822`, etc.) los referencia el
pipeline de release histórico y no se podan. Repos afectados: `cauce-v3-runtime`
(63 tags totales, 9 `rc-<sha>`) y `cauce-v3-console` (50 tags totales, 9
`rc-<sha>`); mismo set de hashes en ambos.

| Tag (runtime y console) | Creado | Comando propuesto |
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

### c.2 — registry `127.0.0.1:5000` — tags `*-legacy`

| Repo:Tag | Tamaño (runtime) | Comando propuesto |
|---|---|---|
| `cauce-v3-runtime-legacy:pre-migration-20260826` | 313 MB | borrar |
| `cauce-v3-runtime-directiva-legacy:pre-migration-20260826` | 313 MB | borrar |
| `cauce-v3-console-legacy:pre-migration-20260826` | 79 MB | borrar |
| `cauce-v3-postgres-legacy:pre-migration-72031de` | — | borrar |
| `cauce-v3-postgres-index:pre-migration-72031de` | — | borrar |

`cauce-v3-postgres-restore` no está huérfano (lo lee el flujo de restore real).

### c.3 — imágenes locales del daemon (no en registry)

Distintas de las anteriores: viven sólo en el daemon local, **no han
llegado al registry**, y no las levanta ningún container vivo.

| Repo:Tag | Tamaño | Creado | Comando propuesto |
|---|---|---|---|
| `cauce-v3-runtime:verificacion-dockerfile-fix` | 80 MB | 2026-08-27 05:07 UTC | `docker rmi cauce-v3-runtime:verificacion-dockerfile-fix` |
| `cauce-rollback-bridge:repro-598a2ab7` | 310 MB | — | `docker rmi cauce-rollback-bridge:repro-598a2ab7` |
| `cauce-rollback-bridge:repro-598a2ab7-second` | 310 MB | — | `docker rmi cauce-rollback-bridge:repro-598a2ab7-second` |
| `cauce-rollback-bridge:repro-v4-a` | 310 MB | — | `docker rmi cauce-rollback-bridge:repro-v4-a` |
| `cauce-rollback-bridge:repro-v4-b` | 310 MB | — | `docker rmi cauce-rollback-bridge:repro-v4-b` |

El de nombre `verificacion-dockerfile-fix` se construyó hoy (39 min antes
de la medición) y es muy probable que sea un artefacto del integrador o de
un agente reciente; ningún container productivo lo usa. La familia
`cauce-rollback-bridge:repro-*` son reproducciones de un bug cerrado; ni
el bridge de rollback ni release alguna la invocan hoy.

NO se incluyen en este grupo `cauce-sep/{ctrl-infra, ws-humanizar, ws-prizma}`
(15/32/57 GB; runtime de la flota viva), ni `cauce-v3:{platform-evidence-focal,
directiva-20260825, 20260823-integrada}` (las usa `medico-nav-*` o son
imágenes vigentes del release), ni `cauce-console:platform-evidence-focal` /
`cauce-console:20260823-integrada` (las usan los `medico-nav-console-1` y
`cauce-v3-prod-console-1`).

### c.4 — script de borrado del registry (uno a uno)

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
    digest=$(curl -sH 'Accept: application/vnd.oci.image.manifest.v1+json' \
                 "http://127.0.0.1:5000/v2/${repo}/manifests/${tag}" \
                 | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('config',{}).get('digest','?'))")
    curl -sX DELETE "http://127.0.0.1:5000/v2/${repo}/manifests/${digest}" >/dev/null
  done
done

for repo_tag in \
  cauce-v3-runtime-legacy:pre-migration-20260826 \
  cauce-v3-runtime-directiva-legacy:pre-migration-20260826 \
  cauce-v3-console-legacy:pre-migration-20260826 \
  cauce-v3-postgres-legacy:pre-migration-72031de \
  cauce-v3-postgres-index:pre-migration-72031de; do
  repo=${repo_tag%:*}; tag=${repo_tag#*:}
  digest=$(curl -sH 'Accept: application/vnd.oci.image.manifest.v1+json' \
               "http://127.0.0.1:5000/v2/${repo}/manifests/${tag}" \
               | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('config',{}).get('digest','?'))")
  curl -sX DELETE "http://127.0.0.1:5000/v2/${repo}/manifests/${digest}" >/dev/null
done
```

## (d) Clon muerto `/datos/workspaces/cauce-v3`

- Branch `HEAD`: `cd82359` «rescate: deriva local del clon hermano antes
  del archivado 2026-08-27».
- Remoto `islazeus` apunta a `/datos/workspaces/zeus/cauce-v3` (el clon
  vivo); `origin` apunta a `github.com/stevenvo780/cauce-v3.git`.
- Tamaño medido el 2026-08-27: **366 MB** (era 600 MB antes del archivado;
  incluye `node_modules` y otros).

| Path | Comando propuesto |
|---|---|
| `/datos/workspaces/cauce-v3` | `rm -rf /datos/workspaces/cauce-v3` |

La historia previa ya está en
`/datos/workspaces/zeus/cauce-v3-archivo-completo-20260827.bundle`
(7.3 MB) y en el tar
`/datos/workspaces/zeus/cauce-rescate-worktrees-20260827.tar.gz`
(14.1 MB); el clon se reconstruye desde el bundle si hace falta.

## Resumen ejecutivo

| Categoría | Items | Espacio recuperable | Acción |
|---|---|---|---|
| Contenedores huérfanos | 8 (3 healthy postgres + 5 stopped/exited) | ~0 (containers) | `docker rm [-f]` |
| `/opt/cauce-v3-release-*` | 13 | **~620 MB** | `rm -rf` selectivo |
| Registry rc-sha (runtime+console) | 18 (9 × 2 repos) | varios cientos de MB | `DELETE` del manifest |
| Registry *-legacy | 5 | varios cientos de MB | `DELETE` del manifest |
| Imágenes locales del daemon | 5 (verificacion-dockerfile + 4 rollback-bridge repro) | ~1.3 GB | `docker rmi` |
| Clon muerto | 1 | ~366 MB | `rm -rf` |

**Total recuperable: ~2.3 GB** (suma conservadora antes de GC de blobs en
el registry). Ninguna acción se ejecuta sin visto bueno del dueño.
