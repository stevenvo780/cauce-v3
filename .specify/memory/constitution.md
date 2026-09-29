# Constitución de Cauce V3

Destila lo no negociable de `docs/doctrina-del-dueno.md`, `AGENTS.md` y
`ordenes/00-PROTOCOLO.md` en forma de gates verificables. Todo spec, plan y
task de `specs/` debe pasar el chequeo de constitución antes de implementarse.

## Principios centrales

### I. Efecto demostrado (NO NEGOCIABLE)

Nada está "hecho" sin la salida del gate pegada. Nada está "desplegado" sin el
efecto verificado contra el sistema vivo. Declarar sin evidencia es un defecto,
no un avance.

### II. Una sola fuente de verdad

- La flota es lo que está activo hoy en la BD (`agents` + `memberships`).
  Alta o baja = una fila + aprovisionar, nunca tocar código.
- El compose corre desde el repo; nada se copia a `/opt`.
- Los parámetros del orquestador se MIDEN (por alias, en runtime) o los fija el
  dueño; jamás se inventan constantes que dupliquen un hecho medido.

### III. Legibilidad primero, poda del monstruo (NO NEGOCIABLE)

Toda estructura nueva se mide contra legibilidad: dominios evidentes, un patrón
consistente, nombres que describen qué hacen. El código muerto se BORRA con
`git rm` (git es el archivo; no existen cuarentenas). Topes: los trinquete de
`scripts/calidad.mjs` sólo pueden bajar; ningún fichero nuevo supera el tope
vigente.

### IV. Revisor distinto del autor, convivencia en `dev`

Sin ramas de tarea: todo el trabajo vive en `dev`, un sector por instancia,
`git add` sólo de rutas propias y commit siempre con pathspec. Ninguna
instancia se autoaprueba. `main` sólo lo publica el dueño con autorización
explícita.

### V. Fencing y fail-closed

Toda entrega se reclama con `claim_token` + `epoch` + intento; el desacuerdo
cierra, nunca adivina. Un arnés no soportado, un ticket caducado o un lease
perdido degradan a estado seguro y visible, jamás a éxito silencioso.

### VI. Credenciales y secretos intocables

`ops/private/credentials/` está git-ignorada a propósito. Ninguna instancia ni
subagente borra, mueve o reescribe nada ahí dentro. Ninguna URL con credencial
acaba en un fichero versionado.

### VII. Spec-first

Todo cambio funcional nace en `specs/NNN-nombre/`: `spec.md` (qué y por qué) →
`plan.md` (cómo) → `tasks.md` (pasos) → implementación → validación. La
documentación que no se verifica contra el árbol o el sistema vivo se borra;
un `.md` que miente es peor que su ausencia.

## Restricciones

- Stack: TypeScript + pnpm (workspaces), PostgreSQL 16 única fuente durable,
  vitest, Docker Compose. Python con `ruff`, shell con `shellcheck`.
- Idioma: `.md` en español, identificadores y comentarios exportados en inglés.
  Comentarios sin narrativa, sin fechas, sin nombres: sólo restricciones que el
  código no expresa por sí solo.
- La flota y sus gates corren como root (entorno real de la VPS); no se cablean
  guardias anti-root. Excepción única: `pnpm qa:runtime-packaging`.
- GitHub Actions prohibido: el gate completo corre en el propio host
  (`cauce-v3-ci-local.timer`), no en un servicio pagado.
- Zonas de NADIE (ni leer para editar, ni tocar): `packages/store/migrations/`
  (se borran enteras, no se editan), `*.patch`, `/etc/cauce-v3`, `/opt`, la BD
  productiva, contenedores y unidades systemd de producción.

## Flujo de desarrollo y gates

1. Todo commit que toque código pasa `pnpm typecheck && pnpm lint &&
   pnpm test:unit` en verde (commits solo-`.md` exentos).
2. Tras tocar cualquier cosa de la flota: `ops/scripts/validate.sh`
   (identidad byte a byte de lo generado desde `ops/flota.json`).
3. `pnpm test` (`scripts/test-all.mjs`) es el gate completo; `VACIA` sin fallo
   por defecto no cuenta como verde para dar algo por probado.
4. La pila de pruebas `ops/compose.test.yaml` (postgres efímera + migrador +
   gateway + dispatcher + arnés e2e) es la validación de sistema; el procedimiento
   vive en el `quickstart.md` de cada spec.
5. Commits ≤20 ficheros, uno por tarea, inmediatos; `git mv` separado de
   ediciones; al terminar, `push origin dev` y checkout en `dev`.

## Gobernanza

La constitución prevalece sobre cualquier otra práctica del repo. Enmendarla
requiere propuesta escrita, aprobación explícita del dueño y plan de migración
para los specs afectados. Todo plan declara su chequeo de constitución; toda
violación justificada se registra en la tabla de complejidad del plan.

**Version**: 1.0.0 | **Ratified**: 2026-09-27 | **Last Amended**: 2026-09-27
