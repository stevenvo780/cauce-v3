# Calidad y gates

El gate de despliegue vigente tiene tres pasos: `typecheck`, `lint` y `qa:runtime-packaging`. La comprobación funcional consiste en recorrer los flujos afectados en la consola o la CLI y verificar sus efectos. El procedimiento de publicación está en [Operación](operacion.md).

## Preparar un cambio

- Conserva el trabajo ajeno y añade o commitea únicamente tus rutas. Publicar una rama o un PR no autoriza a integrar ni desplegar.
- Para cambios de código, ejecuta `pnpm typecheck` y `pnpm lint`, y comprueba la función afectada usando el producto. Documenta el resultado real y cualquier limitación de autenticación o acceso.
- Para documentación, comprueba las rutas, enlaces y afirmaciones contra la implementación y el historial de despliegues; editar una guía no acredita una comprobación en producción.
- Mantén la revisión independiente y separa lo implementado, lo probado en local y lo comprobado en el despliegue. Un comando no ejecutado se declara pendiente.

## Gate de despliegue

Consulta la lista que exige el código del candidato:

```sh
scripts/release-gates.sh --list
```

La salida predeterminada es:

```text
pnpm typecheck
pnpm lint
pnpm qa:runtime-packaging
```

`scripts/release-gates.sh` exige un checkout limpio y escribe un recibo ligado al SHA con los comandos y sus resultados. El empaquetado comprueba los artefactos del runtime y exige usuario normal. Las herramientas de lint, incluidos sus controles de calidad aún presentes en `package.json`, forman parte de `pnpm lint`.

El operador autorizado usa `.delegados/v4/corte.sh` para cortar el candidato y obtener su recibo en un clon limpio. Después, `deploy1-local.sh <sha-completo> <directorio-recibo>` comprueba ese recibo, publica las ramas y transfiere el bundle; `deploy1-vps.sh` separa las fases de comprobación, copia de seguridad, clon, enclave y despliegue. Estos auxiliares pertenecen al entorno privado de operación y no se distribuyen en el repositorio público. Consulta sus pasos y la verificación posterior en [Operación](operacion.md).

El gate no comprueba el comportamiento publicado: después del despliegue hay que recorrer los flujos afectados y contrastar su revisión con [el historial](../deploy/HISTORIAL.md).

## Pruebas y matrices anteriores

Histórico: el gate completo obligatorio, las matrices de aceptación y los trinquetes como procedimiento de cierre fueron retirados; consulta el gate de tres pasos y [Operación](operacion.md).

El nivel `CAUCE_RELEASE_GATES_NIVEL=completo` sigue disponible en el script para ejecuciones opcionales. Sus suites, cobertura, layout y verificaciones adicionales no forman parte del gate predeterminado de despliegue. Ejecutarlo no reemplaza el recorrido funcional del producto.

## Concurrencia de vitest

Para las pruebas ejecutadas bajo demanda, `vitest.config.ts` ajusta los workers al alcance: las suites rápidas usan el valor predeterminado de Vitest; las de datos usan `CAUCE_TEST_DATA_WORKERS` o un cuarto de los núcleos, con mínimo de dos; las de pila completa se serializan. Una partición puede reducir ese límite y no aumentarlo. Esto describe el ejecutor disponible, sin añadir pasos al gate de despliegue.

<a id="gate-de-maquetado-pnpm-qalayout"></a>

La descripción anterior del gate de maquetado es histórica. `pnpm qa:layout` continúa disponible como herramienta opcional; la interfaz se comprueba recorriendo las vistas afectadas.
