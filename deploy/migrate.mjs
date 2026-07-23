#!/usr/bin/env node

import { assertProductionPostgresTls } from './postgres-tls.mjs';

await assertProductionPostgresTls(Number(process.env.HEALTH_TIMEOUT_MS || 5000));
await import('../packages/store/dist/migrate-cli.js');
