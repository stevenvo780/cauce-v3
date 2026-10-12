import { readFile } from 'node:fs/promises';
import { migrationSourcesForApply } from '../src/index.js';

/** The real downs from the newest bundled migration back through `version`, newest first (each down refuses while a later one is applied). */
export async function downsThrough(version: string): Promise<string[]> {
  const versions = (await migrationSourcesForApply()).map(source => source.version);
  const index = versions.indexOf(version);
  if (index < 0) throw new Error(`migration is not bundled: ${version}`);
  return Promise.all(versions.slice(index).reverse()
    .map(later => readFile(new URL(`../migrations/down/${later}`, import.meta.url), 'utf8')));
}
