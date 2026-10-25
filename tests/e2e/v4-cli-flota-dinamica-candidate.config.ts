import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../../vitest.config.js';

export default defineConfig(({ mode }) => {
  const revision = /^[a-f0-9]{40}$/u.test(mode) ? mode : process.env.CAUCE_FLEET_CLI_REVISION;
  if (revision === undefined || !/^[a-f0-9]{40}$/u.test(revision)) throw new Error('select the exact CLI candidate commit with --mode');
  process.env.CAUCE_FLEET_CLI_REVISION = revision;
  return mergeConfig(base, { test: { env: { CAUCE_FLEET_CLI_REVISION: revision } } });
});
