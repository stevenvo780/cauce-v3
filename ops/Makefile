SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

ENV_DEV ?= config/dev.env
ENV_PROD ?= config/prod.env
ARTIFACT_DIR ?= artifacts

.PHONY: help test test-contract test-doubles test-real test-compose test-compose-authentic test-runtime-authentic test-restarts test-container-supervisor test-container-reaping test-container-cutover smoke-cli smoke-adapters validate manifest verify-manifest \
	dev-up dev-down dev-health prod-up prod-down prod-health migrate backup restore manifests release-build release-gate release-bootstrap-legacy release-bootstrap-two-selector release-bootstrap-manifest-sha release-capture-writer-snapshot release-bootstrap-writer-snapshot release-deploy-preflight release-deploy release-rotate-writer-snapshot release-console release-console-rollback release-console-verify

help: ## Lista objetivos
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_.-]+:.*## / {printf "%-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

test: validate test-real ## Validación y QA con transporte/DB reales y harnesses dobles

test-contract: ## Contrato legado contra doble (evidencia mocked)
	@mkdir -p "$(ARTIFACT_DIR)"
	node harness/contract-runner.mjs --mock --artifact-dir "$(ARTIFACT_DIR)/mock"

test-doubles: test-contract smoke-adapters ## Dobles de protocolo y adapters con ejecutables fake

smoke-cli: ## Solo disponibilidad/version/help de CLIs auténticas; no ejecuta prompts
	CAUCE_CLI_ARTIFACT_DIR="$(ARTIFACT_DIR)/cli" ./scripts/smoke-cli-availability.sh

smoke-adapters: ## Adapters con ejecutables fake; nunca invoca CLIs auténticas
	./scripts/smoke-adapter-doubles.sh

test-container-supervisor: ## Supervisor Docker host-side con Docker falso y lifecycle PID exacto
	node tests/container-supervisor.test.mjs

test-container-reaping: ## Fuga de zombis del supervisor: leak reproducido y cosecha sin perder el exit code
	python3 tests/test_container_runtime_reaping.py

test-container-cutover: ## Exclusión de familias, cutover y rollback container
	node tests/container-cutover.test.mjs

test-real: ## Testcontainers: procesos de test + PostgreSQL; reportes versionados por corrida
	./scripts/run-testcontainers.sh

test-compose: ## Stack QA descartable con transporte y PostgreSQL reales
	./scripts/compose.sh test up --build --abort-on-container-exit --exit-code-from e2e

test-compose-authentic: ## Cinco binarios finales; Compose o fallback honesto docker-run
	./scripts/smoke-compose-authentic.sh

test-runtime-authentic: ## Fallback docker-run, nunca aceptado por release productivo
	./scripts/smoke-runtime-authentic.sh

test-restarts: test-compose-authentic ## Restart/fencing/durabilidad dentro de evidencia authentic separada

validate: ## YAML/JSON/schema/scripts/manifiestos; Compose se exige con CAUCE_RELEASE_VALIDATION=1
	./scripts/validate.sh

manifests: ## Valida 15 manifests y genera units host-native y para containers
	python3 scripts/validate-manifests.py
	python3 scripts/generate-units.py
	python3 scripts/generate-container-units.py

manifest: ## Genera manifiesto SHA256 de artefactos QA
	./scripts/manifest.sh "$(ARTIFACT_DIR)"

verify-manifest: ## Verifica el manifiesto SHA256 existente
	./scripts/verify-manifest.sh "$(ARTIFACT_DIR)"

dev-up: ## Levanta entorno dev HTTP, privado y aislado
	CAUCE_ENV_FILE="$(ENV_DEV)" ./scripts/compose.sh dev up -d --wait

dev-health: ## Comprueba salud real dev
	CAUCE_ENV_FILE="$(ENV_DEV)" ./scripts/stack-health.sh dev

dev-down: ## Baja dev sin borrar volúmenes
	CAUCE_ENV_FILE="$(ENV_DEV)" ./scripts/compose.sh dev down

prod-up: ## Levanta producción bajo el lock autenticado; no ejecuta cutover
	CAUCE_ENV_FILE="$${CAUCE_ENV_FILE:-$(ENV_PROD)}" ./scripts/deploy-release.sh prod-up

prod-health: ## Comprueba salud TLS/DB desde los containers
	CAUCE_ENV_FILE="$(ENV_PROD)" ./scripts/stack-health.sh prod

prod-down: ## Baja runtime prod sin borrar volúmenes ni tocar V2
	CAUCE_ENV_FILE="$${CAUCE_ENV_FILE:-$(ENV_PROD)}" ./scripts/deploy-release.sh prod-down

release-build: ## Construye runtime/consola y genera evidencia con IDs
	./scripts/release-build.sh

release-gate: ## Exige Compose v2, build y compose-authentic del mismo digest
	CAUCE_ENV_FILE="$(ENV_PROD)" ./scripts/release-gate.sh

release-bootstrap-legacy: ## Publica create-only el primer selector completo bajo lock
	@CAUCE_ENV_FILE="$${CAUCE_ENV_FILE:-$(ENV_PROD)}" \
	  python3 ./scripts/pin-production-release.py bootstrap \
	    --env-file "$${CAUCE_ENV_FILE:-$(ENV_PROD)}" \
	    --candidate-env-file "$${CAUCE_BOOTSTRAP_CANDIDATE_ENV_FILE:?definir CAUCE_BOOTSTRAP_CANDIDATE_ENV_FILE}" \
	    --expected-candidate-env-sha256 "$${CAUCE_BOOTSTRAP_CANDIDATE_ENV_SHA256:?definir CAUCE_BOOTSTRAP_CANDIDATE_ENV_SHA256}" \
	    --expected-override-manifest-sha256 "$${CAUCE_BOOTSTRAP_OVERRIDE_MANIFEST_SHA256:?definir CAUCE_BOOTSTRAP_OVERRIDE_MANIFEST_SHA256}"

release-bootstrap-two-selector: ## Migra atomicamente un selector fragmentado de 2 a 6 campos
	@python3 ./scripts/pin-production-release.py bootstrap-two-selector \
	    --env-file "$${CAUCE_ENV_FILE:-$(ENV_PROD)}" \
	    --expected-env-sha256 "$${CAUCE_BOOTSTRAP_TWO_SELECTOR_ENV_SHA256:?definir CAUCE_BOOTSTRAP_TWO_SELECTOR_ENV_SHA256}" \
	    --runtime-image "$${CAUCE_BOOTSTRAP_RUNTIME_IMAGE:?definir CAUCE_BOOTSTRAP_RUNTIME_IMAGE}" \
	    --console-image "$${CAUCE_BOOTSTRAP_CONSOLE_IMAGE:?definir CAUCE_BOOTSTRAP_CONSOLE_IMAGE}" \
	    --override-manifest "$${CAUCE_BOOTSTRAP_OVERRIDE_MANIFEST:?definir CAUCE_BOOTSTRAP_OVERRIDE_MANIFEST}" \
	    --override-manifest-sha256 "$${CAUCE_BOOTSTRAP_OVERRIDE_MANIFEST_SHA256:?definir CAUCE_BOOTSTRAP_OVERRIDE_MANIFEST_SHA256}" \
	    --rollback-baseline "$${CAUCE_BOOTSTRAP_ROLLBACK_BASELINE:?definir CAUCE_BOOTSTRAP_ROLLBACK_BASELINE}" \
	    --rollback-baseline-sha256 "$${CAUCE_BOOTSTRAP_ROLLBACK_BASELINE_SHA256:?definir CAUCE_BOOTSTRAP_ROLLBACK_BASELINE_SHA256}" \
	    --backup-env-file "$${CAUCE_BOOTSTRAP_BACKUP_ENV_FILE:?definir CAUCE_BOOTSTRAP_BACKUP_ENV_FILE}"

release-bootstrap-manifest-sha: ## Migra atomicamente un selector legacy de 5 a 6 campos
	@python3 ./scripts/pin-production-release.py bootstrap-manifest-sha \
	    --env-file "$${CAUCE_ENV_FILE:-$(ENV_PROD)}" \
	    --expected-env-sha256 "$${CAUCE_BOOTSTRAP_LEGACY_ENV_SHA256:?definir CAUCE_BOOTSTRAP_LEGACY_ENV_SHA256}" \
	    --expected-override-manifest "$${CAUCE_BOOTSTRAP_OVERRIDE_MANIFEST:?definir CAUCE_BOOTSTRAP_OVERRIDE_MANIFEST}" \
	    --expected-override-manifest-sha256 "$${CAUCE_BOOTSTRAP_OVERRIDE_MANIFEST_SHA256:?definir CAUCE_BOOTSTRAP_OVERRIDE_MANIFEST_SHA256}"

release-capture-writer-snapshot: ## Captura create-only el inventario exacto de writers bajo lock
	@args=(); \
	case "$${CAUCE_DEPLOY_ZEUS_MAINTENANCE:-0}" in \
	  0) ;; 1) args+=(--maintenance-offline-zeus) ;; \
	  *) printf 'CAUCE_DEPLOY_ZEUS_MAINTENANCE debe ser 0 o 1\n' >&2; exit 2 ;; \
	esac; \
	CAUCE_ENV_FILE="$${CAUCE_ENV_FILE:-$(ENV_PROD)}" \
	  ./scripts/capture-release-writer-snapshot.sh \
	    "$${CAUCE_RELEASE_WRITER_SNAPSHOT_FILE:?definir CAUCE_RELEASE_WRITER_SNAPSHOT_FILE}" \
	    "$${args[@]}"

release-bootstrap-writer-snapshot: ## Migra atomicamente un selector legacy de 6 a 8 campos
	@python3 ./scripts/pin-production-release.py bootstrap-writer-snapshot \
	    --env-file "$${CAUCE_ENV_FILE:-$(ENV_PROD)}" \
	    --expected-env-sha256 "$${CAUCE_BOOTSTRAP_SIX_SELECTOR_ENV_SHA256:?definir CAUCE_BOOTSTRAP_SIX_SELECTOR_ENV_SHA256}" \
	    --writer-snapshot "$${CAUCE_RELEASE_WRITER_SNAPSHOT_FILE:?definir CAUCE_RELEASE_WRITER_SNAPSHOT_FILE}" \
	    --writer-snapshot-sha256 "$${CAUCE_RELEASE_WRITER_SNAPSHOT_SHA256:?definir CAUCE_RELEASE_WRITER_SNAPSHOT_SHA256}"

release-deploy-preflight: ## Preflight read-only; liga CAS y snapshot legacy exacto si hay fragmentacion
	@args=(); \
	case "$${CAUCE_DEPLOY_ZEUS_MAINTENANCE:-0}" in \
	  0) ;; 1) args+=(--maintenance-offline-zeus) ;; \
	  *) printf 'CAUCE_DEPLOY_ZEUS_MAINTENANCE debe ser 0 o 1\n' >&2; exit 2 ;; \
	esac; \
	CAUCE_ENV_FILE="$${CAUCE_ENV_FILE:-$(ENV_PROD)}" \
	  ./scripts/deploy-release.sh preflight "$${args[@]}"

release-deploy: ## Normalizacion reversible, CAS, migrator, health, evidencia y compensacion
	@args=(); \
	case "$${CAUCE_DEPLOY_ZEUS_MAINTENANCE:-0}" in \
	  0) ;; 1) args+=(--maintenance-offline-zeus) ;; \
	  *) printf 'CAUCE_DEPLOY_ZEUS_MAINTENANCE debe ser 0 o 1\n' >&2; exit 2 ;; \
	esac; \
	CAUCE_ENV_FILE="$${CAUCE_ENV_FILE:-$(ENV_PROD)}" \
	  ./scripts/deploy-release.sh deploy "$${args[@]}"

release-rotate-writer-snapshot: ## Rota 8→8 el snapshot tras reactivar Zeus y cierra el gate estricto
	@CAUCE_ENV_FILE="$${CAUCE_ENV_FILE:-$(ENV_PROD)}" \
	  ./scripts/deploy-release.sh rotate-writer-snapshot

# Tombstones deliberadas: automatizaciones antiguas obtienen un error explicito antes de mutar.
# El unico release es release-build + CAS completo; la reversa es scripts/rollback.sh console.
release-console: ## RETIRADO: falla cerrado; usar release-build y CAS completo
	@./scripts/release-console.sh desplegar

release-console-rollback: ## RETIRADO: falla cerrado; usar rollback.sh console
	@./scripts/release-console.sh revertir

release-console-verify: ## Valida read-only un RepoDigest; no acredita el deploy vivo
	@./scripts/release-console.sh verificar

migrate: ## DESHABILITADO: las migraciones productivas sólo ocurren dentro de deploy-release
	@./scripts/migrate.sh

backup: ## Crea backup consistente y TLS
	./scripts/backup.sh

restore: ## Restaura backup con confirmaciones de seguridad
	./scripts/restore.sh "$${BACKUP_FILE:?definir BACKUP_FILE}"
