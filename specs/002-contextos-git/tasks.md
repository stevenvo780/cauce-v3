# Tareas

- [x] Inspeccionar autoridades existentes y documentación primaria de arneses.
- [x] Publicar alcance y propiedad; aislar worktree de candidatos congelados.
- [x] Especificar modelo, estados, migración, aplicación y rollback.
- [x] Implementar admisión estricta reutilizando perfil y redacción existentes.
- [x] Implementar lectura de objetos y comparación, sin afirmar observación local.
- [x] Limitar la versión a siete campos, exigir ID del diario y revisar retención.
- [x] Probar con repositorios efímeros sintéticos y suites de contexto existentes.
- [x] Ejecutar gates disponibles y registrar bloqueos sin instalar herramientas.
- [x] Entregar diff, árbol candidato, hashes y evidencia al revisor.

## Validación de la composición anterior

426 pruebas de contexto y 32 regresiones focalizadas de consola correctas.
Typecheck completo, lint estricto de zonas, ciclos, tooling y calidad correctos.
Test unitario global: 5121 correctas y 29 fallidas por falta de tmux.
Lint global bloqueado por shellcheck; lint Python por ruff; PostgreSQL sin URL
de pruebas. No se acredita arnés nativo, aplicación al runtime, UI visual ni E2E.
Los 38 casos Git usan repositorios locales sintéticos; los casos de carrera y
entorno inyectan el momento/configuración. Las 34 pruebas de modelo son puras;
las regresiones existentes de gateway/consola usan sondas y servicios simulados.

## Correcciones de revisión

- [x] Retirar procesos Git y observación porcelain; cerrar storage no soportado.
- [x] Escanear valores decodificados y rechazar claves JSON duplicadas.
- [x] Mantener `not_observed` ante cambios locales e indicadores del índice.
- [x] Validar defensivamente esta revisión y preparar evidencia verificable.

443 pruebas de contexto correctas en 18 archivos: 41 de modelo, 48 con Git
efímero y 354 regresiones existentes. Typecheck completo, lint focalizado normal
y estricto, ciclos y calidad correctos. Calidad incluye los cinco TS nuevos
mediante índice temporal, sin modificar el índice real.
La política de no ejecución se comprueba estáticamente y con configuración y
atributos inertes; no se construyen programas de explotación. Las pruebas de
escaneo incompleto y escritura concurrente usan inyección; las demás pruebas
Git usan objetos locales sintéticos, incluidos SHA-256 y storage no soportado.
No se repitieron gates globales bloqueados ni se acredita runtime nativo,
PostgreSQL, visual o E2E. El recibo externo registra el reemplazo Library con
guardia de versión y los hashes; no forma parte del árbol candidato.

## Composición vigente

- [x] Verificar los 2168 blobs de dev `7bdf7a9` y conservar los mensajes publicados.
- [x] Admitir tenant canónico con capitalización, sin ampliar permisos ni rutas.
- [x] Cubrir capitalización, igualdad exacta, segmentos inválidos y alias canónico.
- [x] Conectar binding explícito del servidor, ACL y diario a rutas de lectura.
- [x] Conectar panel de comparación Git con validación de identidad y respuestas viejas.
- [x] Cerrar gates de la composición final y revisión independiente.

## Validación final en el host autorizado

Typecheck y lint globales correctos; 5505 pruebas unitarias globales y 145 pruebas de
binding, modelo, lectura Git y rutas correctas. Build de consola correcto. Se documentaron
las dos variables opt-in del binding, sin configurarlas en producción. Revisión independiente
de fuente frontend y backend sin bloqueos; Chromium local verificó el panel cerrado, estado
sin configuración y comparación sintética a 360 y 1440 px sin desborde ni escrituras.
No se acredita inspección de un repositorio productivo, adopción del arnés ni PostgreSQL real
en esta funcionalidad. La aceptación autenticada del operador sigue pendiente.
