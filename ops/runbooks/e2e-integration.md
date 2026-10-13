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
2. Confirmar que `make -C ops test-doubles` termina sin fallos. Corre el contrato en doble (`ops/harness/contract-runner.mjs --mock`, con el caso `double consumer rejected`) y `smoke-adapters`. No retiene fencing: ese caso es `double consumer rejected and fencing retained` en `ops/harness/runner.mjs` y solo corre con `--live`.
3. Verificar que `make -C ops smoke-cli` genera evidencia en `ops/artifacts/cli/` acreditando `--version` y `--help` de los runtimes sin abrir prompts interactivos.
4. El paso 1 no valida reportes de Testcontainers. Eso lo hace `make -C ops test-real` (`ops/scripts/run-testcontainers.sh`): ejecuta `pnpm test:e2e` con `CAUCE_REQUIRE_TESTCONTAINERS=1` y `CAUCE_EVIDENCE_CLASS=testcontainers`, y `ops/scripts/validate-testcontainers-evidence.py` comprueba el schema, el digest de runtime y el digest del harness de Testcontainers.

## Deshacer
1. Detener y remover contenedores residuales de Testcontainers:
   ```sh
   docker rm -f $(docker ps -aq --filter "label=org.testcontainers=true") 2>/dev/null || true
   ```
2. Limpiar reportes y artefactos generados:
   ```sh
   rm -rf ops/artifacts/cli ops/artifacts/mock ops/artifacts/testcontainers ops/artifacts/real ops/artifacts/restarts
   ```
