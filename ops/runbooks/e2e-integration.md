# Runbook: Clases de QA y Evidencia de Integración

## Cuándo usar
Ejecutar y validar las suites de integración E2E, dobles de protocolo y pruebas de disponibilidad de CLIs. Caveat operativo: la QA externa y validación de imágenes finales quedan aplazadas a FASE 3; Testcontainers valida el árbol de código fuente pero no imágenes finales empaquetadas.

## Pasos
1. Ejecutar pruebas de transporte real con Testcontainers:
   ```sh
   pnpm test:e2e
   ```
2. Ejecutar dobles de protocolo y parsers de adapter:
   ```sh
   make -C ops test-doubles
   ```
3. Ejecutar smoke test de disponibilidad de binarios de CLIs:
   ```sh
   make -C ops smoke-cli
   ```

## Verificar efecto
1. Validar que la ejecución de `pnpm test:e2e` complete con cero errores.
2. Confirmar que `make -C ops test-doubles` valida contratos y fencing sin fallos.
3. Verificar que `make -C ops smoke-cli` genera evidencia en `artifacts/cli/` acreditando `--version` y `--help` de los runtimes sin abrir prompts interactivos.
4. Confirmar que los reportes de Testcontainers validan contra el schema y digest de runtime.

## Deshacer
1. Detener y remover contenedores residuales de Testcontainers:
   ```sh
   docker rm -f $(docker ps -aq --filter "label=org.testcontainers=true") 2>/dev/null || true
   ```
2. Limpiar reportes y artefactos generados:
   ```sh
   rm -rf artifacts/cli artifacts/testcontainers
   ```
