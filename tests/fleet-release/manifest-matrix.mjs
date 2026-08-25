import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const EXPECTED_ALIAS_COUNT = 15;
export const EXPECTED_HARNESS_COUNTS = Object.freeze({
  openclaw: 5,
  claude: 3,
  hermes: 1,
  codex: 6,
  opencode: 0,
});
export const HARNESS_IDS = Object.freeze(Object.keys(EXPECTED_HARNESS_COUNTS));

function scalar(text, key, context) {
  const expression = new RegExp(`^  ${key}:\\s*([^\\s#{}]+)\\s*$`, 'mu');
  const value = expression.exec(text)?.[1];
  if (!value) throw new Error(`${context} is missing spec.${key}`);
  return value;
}

export async function readAliasManifest(manifestPath) {
  const absolutePath = path.resolve(manifestPath);
  const text = await readFile(absolutePath, 'utf8');
  const metadataName = /^ {2}name:\s*([^\s#{}]+)\s*$/mu.exec(text.slice(0, text.search(/^spec:\s*$/mu)))?.[1];
  if (!metadataName) throw new Error(`${absolutePath} is missing metadata.name`);
  const alias = scalar(text, 'alias', absolutePath);
  const harness = scalar(text, 'harness', absolutePath);
  const tenant = scalar(text, 'tenant', absolutePath);
  const room = scalar(text, 'room', absolutePath);
  if (metadataName !== alias) throw new Error(`${absolutePath} metadata.name and spec.alias differ`);
  if (!HARNESS_IDS.includes(harness)) throw new Error(`${absolutePath} has unsupported harness '${harness}'`);
  return {
    alias,
    harness,
    tenant,
    room,
    path: absolutePath,
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

export async function readFleetManifests(directory) {
  const absolute = path.resolve(directory);
  const names = (await readdir(absolute))
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
    .sort();
  return Promise.all(names.map((name) => readAliasManifest(path.join(absolute, name))));
}

export function validateFleetMatrix(manifests) {
  if (manifests.length !== EXPECTED_ALIAS_COUNT) {
    throw new Error(`fleet matrix requires exactly ${EXPECTED_ALIAS_COUNT} aliases, found ${manifests.length}`);
  }
  const aliases = new Set();
  const counts = Object.fromEntries(HARNESS_IDS.map((harness) => [harness, 0]));
  for (const manifest of manifests) {
    if (aliases.has(manifest.alias)) throw new Error(`duplicate alias '${manifest.alias}'`);
    aliases.add(manifest.alias);
    if (!(manifest.harness in counts)) throw new Error(`unsupported harness '${manifest.harness}'`);
    counts[manifest.harness] += 1;
  }
  for (const [harness, expected] of Object.entries(EXPECTED_HARNESS_COUNTS)) {
    if (counts[harness] !== expected) {
      throw new Error(`fleet matrix requires ${expected} ${harness} aliases, found ${counts[harness]}`);
    }
  }
  return { aliases: [...aliases].sort(), counts };
}
