# 31 — Despliegue simple (la pieza que faltó siempre)

**Fase:** 3 · **Tamaño:** mediano pero delicado · **Ejecutor:** Claude (Opus) CON el dueño presente · **Revisor:** GPT 5.6 Ultra
**Rama:** ninguna — directo a `main` · **Depende de:** 21 cerrado (gate completo en verde)

## Contexto (por qué esto es LA tarea)
Las dos features pedidas están escritas desde el 26-ago y hay 7 pares de imágenes RC construidas y paradas. No se desplegaron porque el gate exige evidencia imposible (gitignored, borrada por clean, caducada por cualquier commit; 6 de 8 paquetes jamás existieron). Producción hoy: corre desde `/opt/cauce-v3` (no es repo git, compose que ningún commit produjo), mosaico de 3–4 imágenes, BD en migración 024 de 037, y el pin de prod.env es decorativo para 3 de 6 servicios. Se intentó desplegar 17 veces en una noche: 0 éxitos.

## Objetivo
Un despliegue **aburrido y posible**: un script corto, un solo origen (el repo), imágenes por digest, migraciones aplicadas, y un smoke test que ejercita el efecto real. La maquinaria vieja ya quedó en `_legado/` (fichero 12).

## Tareas
1. **`deploy/deploy.sh` (~50–80 líneas)**: `git describe` limpio → `docker build` de runtime+console con label del commit → push al registry local → actualizar UN fichero de pins por digest → `docker compose up -d --wait` → smoke test → si falla, `compose up` con los digests anteriores (rollback = re-apuntar pins).
2. **Un solo compose canónico**: reconciliar `deploy/compose.yaml` del repo con lo que de verdad corre (el de `/opt` difiere en 117 líneas y tiene overrides encadenados en `/etc/cauce-v3/compose-overrides/`). El resultado: el repo es la única fuente; `/opt/cauce-v3` deja de existir como origen; los overrides se reducen a UN fichero de entorno privado (secretos) fuera del repo.
3. **Migraciones**: plan explícito 025→037 (11 pendientes, 3.649 líneas SQL — incluir revisión una a una ANTES de aplicar: fueron escritas en un commit monolítico y jamás ejecutadas contra datos reales). Backup de BD verificado antes (`cauce-v3-db-backup` existe). Aplicar en ventana con el dueño mirando.
4. **Smoke test post-deploy (el "curl del efecto")**, guardado como `deploy/smoke.sh`:
   - publicar un mensaje de prueba entre dos agentes y verlo `done`;
   - `GET .../agents/zeus/documents` devuelve el inventario (¡ya no 404!);
   - editar un fichero de prueba desde la API y **leerlo cambiado dentro del contenedor** (`docker exec cat`);
   - abrir sesión de terminal y recibir bytes >0.
5. **Orden de despliegue coordinado** (lección del mismatch 0x5E): relay y pty-agent se actualizan en el MISMO rollout; consola y gateway en el mismo rollout. El fichero 32 cubre el lado flota.
6. **Procedencia**: toda imagen con labels de commit (`org.opencontainers.image.revision`); prohibido arrancar un contenedor de una imagen sin label (la de hoy tiene `Labels: null`).
7. **Registrar cada deploy**: append de una línea (fecha, commit, digests, resultado del smoke) a `deploy/HISTORIAL.md`. Nada de 17 intentos invisibles: la noche del 26-ago no dejó ni una línea de journal.

## Reglas duras
- El dueño presente y confirmando en cada paso que toque producción.
- Backup de BD verificado antes de migrar. Los `migrations/down/` existen pero jamás se probaron: no confiar en ellos como plan de rollback; el rollback de BD es el backup.
- Si un paso falla dos veces, PARAR y documentar — no encadenar fixes de fontanería como el 26-ago (14 commits fix: en 3 horas).

## Gate de aceptación
`deploy/smoke.sh` en verde contra producción, ejecutado dos veces (deploy + un re-deploy trivial para probar repetibilidad). La consola sirve el bundle del commit desplegado y el editor guarda de verdad (efecto visible con `docker exec cat`).
