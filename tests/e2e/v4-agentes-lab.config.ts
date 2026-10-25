import { mergeConfig } from 'vitest/config';
import base from '../../vitest.config.js';

export default mergeConfig(base, { test: { env: { CAUCE_PLAZOS_FACTOR: '4' } } });
