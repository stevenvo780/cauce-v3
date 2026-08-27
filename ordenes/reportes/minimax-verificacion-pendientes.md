# Re-verificación de `PENDIENTES-DEL-DUEÑO.md` — cada cifra, con su comando

El dueño va a firmar sobre ese documento, así que cada número y cada afirmación se ha vuelto a comprobar **hoy** con un comando cuya salida está pegada en los parciales (`_parcial-verif-fase3.md`, `_parcial-verif-censo.md`, `_parcial-verif-vistas.md`, `_parcial-verif-flota.md`). **Este reporte no modifica `PENDIENTES-DEL-DUEÑO.md`**: el fichero tiene cambios sin commitear de otra instancia y no es mi sector. Es una lista de correcciones lista para aplicar.

## Resumen: 26 afirmaciones comprobadas

| | |
|---|---:|
| VERDADERAS tal como están escritas | 9 |
| MATIZADAS (el fondo es correcto, la frase engaña) | 10 |
| **FALSAS con cifra equivocada** | **4** |
| NO RESPALDADAS (afirmación sin fuente) | 2 |
| NO VERIFICABLES sin tocar producción | 1 |

---

## Las 4 cifras FALSAS — corregir antes de firmar

### 1. «~2,3 GB recuperables» de residuos de host → **~1,1 GB**

`PENDIENTES-DEL-DUEÑO.md:88`. La inflación está en la fila de imágenes locales: **las 4 imágenes `cauce-rollback-bridge:repro-*` son 2 imágenes con 4 etiquetas**, y las dos comparten las 26 capas. Sumar 4 × 310 MB cuenta cuatro veces un contenido que está una vez.

```
$ docker images cauce-rollback-bridge --no-trunc --format '{{.Tag}}  {{.ID}}'
repro-v4-a              sha256:f535e48a7ef41c83caacf32f32a64d115779590ccdcd84907317ebff5ef11c1c
repro-v4-b              sha256:f535e48a7ef41c83caacf32f32a64d115779590ccdcd84907317ebff5ef11c1c
repro-598a2ab7          sha256:a95920a50963f25bb24000c0cbc66dbc3d06582ecde82f9b1559038332f62772
repro-598a2ab7-second   sha256:a95920a50963f25bb24000c0cbc66dbc3d06582ecde82f9b1559038332f62772

$ docker images cauce-rollback-bridge -q --no-trunc | sort -u | wc -l
2
```

Y las capas confirman que ni las dos imágenes distintas ocupan el doble:

```
capas comunes a las 4 etiquetas: 26
  repro-598a2ab7:        26 capas, 0 exclusivas suyas
  repro-598a2ab7-second: 26 capas, 0 exclusivas suyas
  repro-v4-a:            26 capas, 0 exclusivas suyas
  repro-v4-b:            26 capas, 0 exclusivas suyas
capas EXCLUSIVAS de las 5 imágenes (no usadas por ninguna otra): 25 de 39
```

Tamaño real por imagen (`docker image inspect --format '{{.Size}}'`, no la columna SIZE de `docker images`, que suma capas compartidas):

| fila del reporte | declarado | medido hoy |
|---|---:|---:|
| 13 árboles `/opt/cauce-v3-release-*` | 620 MB | **620 MB — correcto** (`du -sh --total`) |
| clon muerto `/datos/workspaces/cauce-v3` | 366 MB | **366 MB — correcto** |
| 5 imágenes locales | 1.320 MB | **~89 MB** (68 MiB de rollback-bridge + 21 MiB de `verificacion-dockerfile-fix`) |
| **total** | **~2,3 GB** | **~1,1 GB** |

No cambia la decisión (todo sigue siendo basura recuperable), pero el dueño debe firmar 1,1 GB, no 2,3 GB.

### 2. «8 vistas de consola, ~1.027 líneas reales de src» → **783 líneas**, y solo 2 retiradas son limpias

`PENDIENTES-DEL-DUEÑO.md:81`. Los 244 que faltan son `console/src/features/topology/HyperGraph.tsx`, **borrado el mismo día a las 16:13, antes de que se firmara el documento a las 17:07**:

```
$ git show 847e896 --stat | grep -i hyper
 console/src/features/topology/HyperGraph.tsx  | 244 ----------
```

Y de esas 783 líneas, solo una parte es retirable de verdad:

| | líneas |
|---|---:|
| retirada limpia (`jobs`, `fleet/:tenant/:alias`) | 231 |
| exige co-edición de vistas que se conservan (`chains`, `audit`, `adapters`, `role-brief-tab`) | 385 |
| ficheros compartidos que NO se pueden contar | 167 |

Dos de las ocho **no se pueden retirar**: `relays` es un sub-componente de `ObservabilityPage`, y `topology` ya es un alias en `App.tsx:110` cuyos ficheros los usa `/live`. La advertencia del doc sobre `hypergraph-layout` sigue vigente y verificada:

```
$ grep -rn "hypergraph-layout" console/src --include=*.tsx
console/src/features/live/LiveHypergraph.tsx:19:} from '../topology/hypergraph-layout';
console/src/features/live/live-hypergraph/FlowArrow.tsx:1:import type { Point } from '../../topology/hypergraph-layout';
```

**Cifra firmable: 231 líneas de retirada limpia, 616 si se acepta la co-edición.** No 1.027.

### 3. «7 tests huérfanos» → **11**

`PENDIENTES-DEL-DUEÑO.md:74`. Son 4 `.test.mjs` + 7 `test_*.py`. El censo omitió `test_fleet_watchdog.py` y `test_quota_collector.py`. Detalle con rutas en `_parcial-verif-censo.md` §B4c.

### 4. D4: «heraclito/tales son 2 de los 12 del kill-list» → son **2 ADEMÁS de los 12**

`PENDIENTES-DEL-DUEÑO.md:37`. El BLOQUE A del kill-list tiene 12 PIDs sobre 8 alias; heraclito y tales están en el BLOQUE B, que es opcional y aparte. El total sería **14 PIDs sobre 10 alias**, no 12.

---

## El hallazgo más importante: heraclito y tales están VIVOS y trabajando

`PENDIENTES-DEL-DUEÑO.md:37` los describe con «churn cero, alias ya fuera del mapa» y D1 propone deshabilitarlos. **Las dos mitades son ciertas por separado y juntas dan una conclusión falsa**: están fuera del catálogo (`enabled=false` en la 029) pero llevan dos semanas corriendo con sesiones de agente activas.

```
$ docker ps --format '{{.Names}}' | grep -E 'heraclito|tales'
agv2-jhon-heraclito-oc
agv2-jhon-tales-oc
```

| contenedor | corriendo desde | proceso dentro | pty-agent |
|---|---|---|---|
| `agv2-jhon-heraclito-oc` | 2026-08-12 10:18:47Z | `claude --continue` PID 172287, vivo desde el 17-ago, +57:50 de CPU | PID 474171 (el mismo del BLOQUE B) |
| `agv2-jhon-tales-oc` | 2026-08-15 02:16:35Z | `codex` PID 43801, vivo desde el 20-ago | PID 74697 (el mismo del BLOQUE B) |

«Churn cero en el relay» es cierto (0 eventos en 24 h) y no significa que el agente esté muerto: significa que **no está publicando por el bus**. La respuesta ya escrita del dueño (línea 39: «heraclito y tales son de jhon deberían estar totalmente operativos») coincide con lo que mide el host, no con lo que dice el documento.

### Y la excepción: la «ficción» del bucle de dedalo/salva es real

El dueño escribió (línea 44) que el bucle de `dedalo`/`salva` en otra máquina «producto de las contaminaciones de contextos se inventaron esa ficción». La evidencia dice lo contrario: esos contenedores no existen en el docker local, sus ids no están en el overlay local, hay un túnel SSH vivo a kratos (`ssh -N -L 0.0.0.0:12222:10.88.88.31:22 kratos`, PID 3958943), y `ops/pty-agent/cauce-pty-launcher.sh:5` documenta que corren en kratos como `stev`. **La afirmación del documento es correcta; conviene que el dueño la revise antes de firmar.**

---

## Contradicciones internas que hay que resolver antes de firmar

No son errores de medición: son decisiones que se anulan entre sí tal como está escrito hoy.

1. **Línea 24 vs línea 44 (el dueño se contradice a sí mismo).** La 24 dice «realmente solo muere todo el equipo de pablo»; la 44 dice que `dedalo` — que es de Pablo — «debería estar plenamente operativo». Hay que decidir si Pablo se da de alta (lo que hace la 029) o se retira.
2. **Línea 24 vs D1(b).** D1(b) propone dar de alta a los 4 de Pablo; la respuesta pide lo contrario. Si se mantiene la respuesta, **la migración 029 hay que editarla antes de aplicarla**, y eso toca `packages/store/migrations/**`, que es zona NADIE hasta FASE 3: es una decisión del dueño, no de una instancia.
3. **Línea 39 vs D1(a) y D4.** El documento propone deshabilitar y matar heraclito/tales; la respuesta los quiere operativos. Con la evidencia de arriba, la respuesta gana.
4. **D2 y (2)(e)** son la misma decisión con dos respuestas distintas; conviene fundirlas en una.

---

## Las 2 afirmaciones SIN FUENTE

| afirmación | dónde | qué falta |
|---|---|---|
| «todas con 0 visitas humanas en 3,5 días» (las 8 vistas) | línea 82 | El dato se repite 10 veces en el dossier **sin una sola fuente pegada**: ni log de nginx, ni consulta a `audit_events`, ni artefacto reproducible. Es la premisa de toda la decisión (3) y no está respaldada. |
| «churn cero» de heraclito/tales/gaia | línea 37 | El dato es cierto (0 eventos en 24 h en el relay) pero el reporte no pegaba la medición, y sin ella la frase se leyó como «están muertos» — que es falso. |

---

## Lo que sí está bien medido (9 verdaderas)

- **D2: «7 variables a aprovisionar»** — exactamente 7 `CAUCE_ALERTMANAGER_*`. Correcto.
- **D3: «cambia el source de 4 binds»** — exactamente 4 (`compose.yaml:516`, `:536`, `:537` y `compose.postgres.yaml:40`). Correcto.
- **Línea 10: «`deploy/runtime/`, ~11 refs»** — exactamente 11 ficheros. Correcto.
- **D1: «flota 14→18, 15 enabled»** — la 029 declara 15 deseados + 3 históricos = 18; hay 15 manifiestos en `ops/manifests/` y `container-aliases.json` dice 15+3. Correcto.
- **D1: «fila y FKs se preservan»** — la 029 usa `ON CONFLICT DO NOTHING` con `enabled=false`; no hay un solo `DELETE`. Correcto.
- **D1: «nacen sin perfil»** — la 029 no toca `agent_profiles`; la 026 siembra solo si `role_brief IS NOT NULL`; la 035 solo crea la FK. Correcto.
- **(2)(b): «dlq_cli.py + 5 wrappers + 3 schemas»** — correcto, con nombres actualizados (dos `telegram-*-request` se borraron en la purga P10).
- **(2)(c): «6 ficheros de medición CDP, sin integración ni CI»** — 6 exactos, y nada los invoca: ni `package.json`, ni `ops/Makefile`, ni `validate.sh`, ni el CI, ni systemd.
- **(2)(f): `CREDENTIAL-INVENTORY.local`** — existe, modo 600, cubierto por `.gitignore:29`, no trackeado.
- **13 árboles `/opt/cauce-v3-release-*` = 620 MB** y **clon muerto = 366 MB**: los dos, exactos.

## Los matices que cambian cómo se lee el documento

- **D2: «el servicio no está en el compose»** → está en un *overlay*, no en el compose base. La alerta `CauceAlertmanagerDown` solo queda encendida para siempre si se despliega el perfil de observabilidad sin el overlay del alertmanager. La decisión sigue en pie; el diagnóstico es más fino.
- **FASE 3: «migrar 026–037»** → son **12 migraciones sin huecos**, pero **la 027 no tiene su `down/`**. Un rollback de la ventana no puede deshacer la 027 automáticamente. Esto merece estar en el guion antes de abrir la ventana.
- **FASE 3: «2,4 s medidos»** → el dossier registra **2,4–3,3 s** de SQL. La transacción única y el rollback automático sí están probados contra el clon; la cifra puntual está redondeada a la baja.
- **«producción está en la 024»** → coherente y documentado (dossier del 27-08 y el contenedor `cauce-inspect-migration024`, que sigue en `docker ps -a` con `Exited (0)`). No re-confirmable hoy sin tocar la base, y no se tocó.
- **(2)(a): `cauce-portatil` «cero uso»** → `compilar-en-torre` sí es cero refs, pero `cauce-portatil` tiene un consumidor real: `ops/scripts/install-cauce-cli.sh:36`. Además es un casi-duplicado (9 líneas de diferencia) de `ops/guardias/cauce-envoltorio-local.sh` — el mismo patrón que documenta `minimax-duplicados.md` G-O2.
- **(2)(f): `deploy/liveness-probe.mjs`** → cero cableado en runtime (ni compose, ni Dockerfile, ni systemd), pero **2 tests de vitest lo invocan**: borrarlo pone dos tests en rojo.
- **(2)(f): `Makefile` raíz** → 13 targets, cero invocaciones desde CI, docs o scripts. La nota del censo que decía que `ci.yml` llama a `make validate` está obsoleta: hoy `ci.yml` no contiene la palabra `make`.
- **(4) 8 contenedores huérfanos** → los 8 siguen existiendo hoy, pero **5 están `running`** (tres postgres `healthy` con nombres aleatorios de `docker run`, más `cauce-test-zeus` y `cauce-v3-restore-drill-20260825`). Borrarlos exige `rm -f`, no `rm`; el dueño debe saber que está parando procesos vivos, aunque sean de pruebas.

## Lo que quedaría por hacer

- Aplicar estas correcciones al documento (sector de Claude + dueño; el fichero además tiene cambios sin commitear ahora mismo).
- Respaldar o retirar la premisa de «0 visitas humanas»: es la base de la decisión (3) y hoy no tiene evidencia.
- Resolver las cuatro contradicciones de arriba, en especial la de Pablo, porque decide si la 029 se aplica tal cual o se edita.
