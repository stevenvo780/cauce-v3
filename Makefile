PNPM ?= pnpm

.PHONY: install build lint typecheck test test-unit test-services test-integration test-fleet-release verify verify-three-rounds migrate dev-gateway dev-dispatcher dev-relay-worker dev-shadow-router dev-telegram-bridge
install:
	$(PNPM) install --frozen-lockfile
build:
	$(PNPM) build
lint:
	$(PNPM) lint
typecheck:
	$(PNPM) typecheck
test:
	$(PNPM) test
test-unit:
	$(PNPM) test:unit
test-services:
	$(PNPM) test:services
test-integration:
	$(PNPM) test:integration
test-fleet-release:
	$(PNPM) test:fleet-release
verify: lint typecheck test build
verify-three-rounds:
	$(PNPM) verify:three-rounds
migrate:
	$(PNPM) migrate
dev-gateway:
	$(PNPM) dev:gateway
dev-dispatcher:
	$(PNPM) dev:dispatcher
dev-relay-worker:
	$(PNPM) dev:relay-worker
dev-shadow-router:
	$(PNPM) dev:shadow-router
dev-telegram-bridge:
	$(PNPM) dev:telegram-bridge
