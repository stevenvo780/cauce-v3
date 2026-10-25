import { mergeConfig } from 'vitest/config';
import configuration from '../../vitest.config.js';

export default mergeConfig(configuration, { test: { env: { H8E_SDK_UNDER_TEST: 'before' } } });
