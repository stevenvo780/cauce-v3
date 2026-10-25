import { mergeConfig } from 'vitest/config';
import configuration from '../../vitest.config.js';

export default mergeConfig(configuration, { test: { env: { CAUCE_PLAZOS_FACTOR: '4' } } });
