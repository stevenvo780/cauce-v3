# 33 — Gobierno de la flota constructora (que no se repita)

**Fase:** 3 (transversal; el dueño decide cuándo) · **Tamaño:** pequeño en líneas, grande en efecto · **Ejecutor:** el dueño + Claude · **Revisor:** —

## Contexto (hallazgo central de la auditoría)
La espiral de 120B tokens no la causó un modelo malo: la causaron **órdenes vigentes** en la capa de instrucciones de la flota, más la ausencia total de frenos mecánicos:
- `/datos/agents/shared/.claude/CLAUDE.md`: «El objetivo es dar los MEJORES resultados, NO ahorrar», «en fan-outs grandes / muchos agentes en paralelo, repartí la carga» (sin tocar desde el 2-ago).
- `role_brief` de zeus: «ORQUESTAS, NO EJECUTAS EN SERIE; hacerlo de a uno vos mismo es el error».
- Prompts fundacionales (27-jul): «El código existente tiene comentarios largos que narran el defecto… **Imitá esa densidad**» — el origen medible de los comentarios-ensayo.
- Frenos: 0 hooks, 0 deny, 0 CI, ADRs muertos desde el 25-jul. Los alias codex tienen tope de paralelismo («máximo cuatro ramas concurrentes»); los alias claude —que construyeron esto— no tienen ninguno.
- Eficiencia medida del fan-out por sus propios registros: 44 agentes / 4M tokens → 8 hallazgos confirmados, 30 refutados (79% ruido). La misma feature replanificada 7 veces en 10 días.

## Tareas

1. **Reescribir el CLAUDE.md compartido de la flota** (con el dueño, a mano, ≤80 líneas). Cambios mínimos:
   - Quitar «NO ahorrar» y el mandato de fan-out. Sustituir por: paralelo solo con sectores disjuntos definidos por escrito ANTES, y tope (p.ej. 4 ramas, como ya tiene codex).
   - Quitar «imitá esa densidad» de cualquier prompt plantilla que sobreviva. Regla nueva: comentarios solo para restricciones que el código no expresa.
   - Regla de entrega: **nada está hecho hasta que se ejecutó en el sistema real y se mostró el efecto** (el curl, el fichero cambiado dentro del contenedor). Conservar el «si no lo probaste, escribí "no lo probé"» — esa regla era buena; lo que faltaba era su pareja.
   - Regla de integración: todo trabajo termina mergeado a main o cerrado explícitamente. Un worktree no es un destino.
2. **Frenos mecánicos** en `.claude/settings` del workspace: deny para `git push --force`, edición de `*.patch`, `packages/store/migrations/**` fuera de rama de FASE 3; hook post-edición que corre typecheck del paquete tocado.
3. **CI mínima** (`.github/workflows/ci.yml` o runner local): typecheck + lint + test:unit en cada push de rama. Es la primera CI del repo en su historia. Protección de main: solo merge con CI verde.
4. **Memoria del proyecto dentro del repo**: los 88 .md sueltos de `/datos/workspaces/zeus/` fueron la única memoria y se perdía entre sesiones. Regla: todo handoff/decisión vigente vive en el repo (`docs/` o `plan-reestructura/`); lo demás NO se archiva: git es el archivo. Un fichero de estado ÚNICO y corto (`ESTADO.md`, ≤40 líneas, sobreescrito, no acumulativo).
5. **Presupuesto por tarea**: antes de lanzar un workflow/fan-out, escribir en una línea: objetivo verificable + tope de tokens + criterio de parada. Si al tope no hay efecto demostrado, se para y se replantea con el dueño — no se relanza más grande.

## Gate de aceptación
Prueba real: encargar a un agente una tarea pequeña con el nuevo gobierno y verificar que (a) trabajó en rama, (b) no escribió ensayo, (c) mostró el efecto, (d) mergeó o cerró. Si algo de eso falla, el gobierno aún tiene un agujero: ajustar y repetir.
