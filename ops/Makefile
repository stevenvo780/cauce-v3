SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

ENV_DEV ?= config/dev.env
ENV_PROD ?= config/prod.env
ARTIFACT_DIR ?= artifacts

.PHONY: help test test-contract test-doubles test-real test-compose test-compose-authentic test-runtime-authentic test-restarts test-container-supervisor test-container-reaping test-container-cutover smoke-cli smoke-adapters validate manifest verify-manifest \
	dev-up dev-down dev-health prod-health backup manifests

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

test-container-cutover: ## Exclusión de familias y cutover container
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
	python3 scripts/generate-container-units.py --rootless --output generated/container-systemd/rootless

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

prod-health: ## Comprueba salud TLS/DB desde los containers
	CAUCE_ENV_FILE="$(ENV_PROD)" ./scripts/stack-health.sh prod

backup: ## Crea backup consistente y TLS
	./scripts/backup.sh
