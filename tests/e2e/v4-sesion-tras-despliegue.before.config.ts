import { mergeConfig } from 'vitest/config';
import configuration from '../../vitest.config.js';

export default mergeConfig(configuration, { test: { env: { H13_RELEASE_B_SOURCE: 'baseline' } } });
