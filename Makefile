PNPM ?= pnpm

.PHONY: install build lint typecheck test test-unit test-services test-integration verify migrate-dev dev-gateway dev-dispatcher dev-telegram-bridge
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
verify: lint typecheck test build
migrate-dev:
	$(PNPM) migrate:dev
dev-gateway:
	$(PNPM) dev:gateway
dev-dispatcher:
	$(PNPM) dev:dispatcher
dev-telegram-bridge:
	$(PNPM) dev:telegram-bridge
