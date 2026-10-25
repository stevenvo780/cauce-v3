import { mergeConfig } from 'vitest/config';
import base from '../../vitest.config.js';

export default mergeConfig(base, { test: { env: {
  CAUCE_PLAZOS_FACTOR: '4',
  CAUCE_E2E_ARTIFACT_DIR: '.delegados/v4/recibos/e2e-a6-chat-1025b',
} } });
