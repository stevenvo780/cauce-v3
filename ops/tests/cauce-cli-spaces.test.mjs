import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FleetOperationRequestSchema, configurationMutationHashInput, sha256Hex } from '../../packages/protocol/dist/index.js';

const testFile = fileURLToPath(new URL('./cauce-cli-spaces.py', import.meta.url));
const result = spawnSync('python3', [testFile], {
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  encoding: 'utf8',
  timeout: 60_000,
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
assert.equal(result.status, 0, result.error?.message ?? 'cauce spaces protocol tests failed');

const fixture = spawnSync('python3', ['-c', `import json,runpy,sys
test = runpy.run_path(sys.argv[1], run_name='cauce_spaces_protocol_fixture')
module = test['MODULE']
request = {'kind': 'create', 'target': {'resource': 'agent', 'tenant_id': 'Alpha', 'alias': 'canary'},
           'expected_revision': 7, 'idempotency_key': 'create-canary', 'parameters': module['parameters'](test['PARAMETERS'])}
mutation = {'resource': 'agent', 'action': 'create', 'tenant_id': 'Alpha', 'alias': 'canary',
            'value': {'display_name': 'Canario de prueba', 'enabled': False, 'max_concurrent_deliveries': 2}}
print(json.dumps({'request': request, 'request_hash': module['request_hash'](request), 'mutation': mutation,
                  'mutation_hash': module['hashlib'].sha256(('cauce-v3:configuration-mutation:v1\\n' + module['canonical'](mutation)).encode()).hexdigest()}))`, testFile], {
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 10_000,
});
assert.equal(fixture.status, 0, fixture.stderr);
const { request, request_hash: requestHash, mutation, mutation_hash: mutationHash } = JSON.parse(fixture.stdout);
assert.equal(requestHash, sha256Hex(FleetOperationRequestSchema.parse(request)));
assert.equal(mutationHash, sha256Hex(configurationMutationHashInput(mutation)));
process.stdout.write('spaces: HTTP protocol, durable states and TypeScript receipt hashes verified\n');
