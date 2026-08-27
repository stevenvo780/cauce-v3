import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scripts = path.join(root, '_legado/ops-scripts');
const ops = path.join(root, 'ops');

const wiring = [
  ['release-build.sh', ['--domain runtime', '--domain console']],
  ['validate-release-evidence.py', ['"--domain", domain']],
  ['release-candidate.py', ['"--domain", domain']],
  ['verification-rounds.mjs', ["'--domain', SOURCE_DIGEST_DOMAIN"]],
];
for (const [relative, needles] of wiring) {
  const contents = await readFile(path.join(scripts, relative), 'utf8');
  for (const needle of needles) {
    assert(contents.includes(needle), `_legado/ops-scripts/${relative} must pass ${needle} to source-digest.py`);
  }
}

for (const [relative, domain] of [
  ['build-evidence.schema.json', 'runtime'],
  ['verification-evidence.schema.json', 'full'],
]) {
  const schema = JSON.parse(await readFile(path.join(ops, 'schemas', relative), 'utf8'));
  assert(schema.required.includes('sourceDigestDomain'), `${relative} must require sourceDigestDomain`);
  assert.equal(schema.properties.sourceDigestDomain.const, domain, `${relative} must pin sourceDigestDomain to ${domain}`);
}
const candidate = JSON.parse(await readFile(path.join(ops, 'schemas/release-candidate.schema.json'), 'utf8'));
assert(
  candidate.properties.evidence.items.required.includes('sourceDigestDomain'),
  'the release candidate must record which domain backs each aggregated artifact',
);
