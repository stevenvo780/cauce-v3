import { beforeEach, type TestContext } from 'vitest';
import { dockerTestRequirement } from '../../../tests/helpers/postgres.js';

function fileName(sourceUrl: string): string {
  const path = new URL(sourceUrl).pathname;
  return path.split('/').at(-1) ?? path;
}

function belongsToRunnableScope(context: TestContext, names: ReadonlySet<string>): boolean {
  if (names.has(context.task.name)) return true;
  let suite = context.task.suite;
  while (suite !== undefined) {
    if (names.has(suite.name)) return true;
    suite = suite.suite;
  }
  return false;
}

export function preparePostgresSuite(
  sourceUrl: string,
  setup: () => Promise<void>,
  timeout?: number,
  runnableWithoutPostgres: readonly string[] = [],
): void {
  const coverage = `all PostgreSQL-backed assertions in ${fileName(sourceUrl)}`;
  const requirement = dockerTestRequirement(coverage);
  const runnableNames = new Set(runnableWithoutPostgres);
  let setupPromise: Promise<void> | undefined;

  beforeEach(async (context) => {
    if (belongsToRunnableScope(context, runnableNames)) return;
    if (setupPromise === undefined
        && !process.env.CAUCE_TEST_DATABASE_URL
        && process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1') {
      await requirement.skipIfUnavailable(context.skip);
    }
    setupPromise ??= setup();
    await setupPromise;
  }, timeout);
}
