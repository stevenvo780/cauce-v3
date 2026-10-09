#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '../..');
const catalogoScript = join(repoRoot, 'ops/guardias/catalogo-mouseion-health.sh');
const attachScript = join(repoRoot, 'ops/guardias/cauce-attach');

test('catalogo-mouseion-health: fails closed and does not attempt egress without destination', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'catalogo-guard-test-'));
  try {
    const urlsFile = join(tmp, 'urls.txt');
    const logFile = join(tmp, 'health.log');
    const curlLog = join(tmp, 'curl_calls.log');

    writeFileSync(urlsFile, 'https://test.example/app\tok\n');
    const fakeCurl = `#!/usr/bin/env bash
for arg in "$@"; do
  if [[ "$arg" == *"egress/notifications"* ]] || [[ "$arg" == *"/v3/messages"* ]]; then
    echo "EGRESS_ATTEMPT: $*" >> "${curlLog}"
  fi
done
echo "500 0 https://test.example/app"
`;
    const fakeCurlPath = join(tmp, 'curl');
    writeFileSync(fakeCurlPath, fakeCurl);
    chmodSync(fakeCurlPath, 0o755);

    const env = {
      PATH: `${tmp}:${process.env.PATH}`,
      CATALOGO_URLS: urlsFile,
      CATALOGO_INFORME: logFile,
      CATALOGO_TIMEOUT: '1',
      CATALOGO_REINTENTO: '0',
      CAUCE_PKI: tmp,
      CAUCE_DESTINO_AVISO: '',
      CAUCE_AVISO_CONF: join(tmp, 'nonexistent.json'),
    };

    const res = spawnSync('bash', [catalogoScript], { env, encoding: 'utf8' });

    assert.equal(res.status, 2, 'a guard without any notice route fails its unit (exit 2), not success (1)');
    assert.match(res.stderr, /sin ruta de aviso/u);
    let egressCalled = false;
    try {
      const content = readFileSync(curlLog, 'utf8');
      if (content.includes('EGRESS_ATTEMPT')) {
        egressCalled = true;
      }
    } catch {
      egressCalled = false;
    }
    assert.equal(egressCalled, false, 'catalogo guard must not attempt egress when destination is absent');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('catalogo-mouseion-health: explicit destination enables egress attempt', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'catalogo-guard-explicit-'));
  try {
    const urlsFile = join(tmp, 'urls.txt');
    const logFile = join(tmp, 'health.log');
    const curlLog = join(tmp, 'curl_calls.log');

    writeFileSync(urlsFile, 'https://test.example/app\tok\n');
    const fakeCurl = `#!/usr/bin/env bash
for arg in "$@"; do
  if [[ "$arg" == *"egress/notifications"* ]]; then
    echo "EGRESS: $*" >> "${curlLog}"
    echo "202"
    exit 0
  fi
done
echo "500 0 https://test.example/app"
`;
    const fakeCurlPath = join(tmp, 'curl');
    writeFileSync(fakeCurlPath, fakeCurl);
    chmodSync(fakeCurlPath, 0o755);

    const pkiZeus = join(tmp, 'zeus');
    mkdirSync(pkiZeus, { recursive: true });
    writeFileSync(join(pkiZeus, 'client.crt'), 'fake');
    writeFileSync(join(pkiZeus, 'client.key'), 'fake');
    writeFileSync(join(pkiZeus, 'ca.crt'), 'fake');

    const env = {
      PATH: `${tmp}:${process.env.PATH}`,
      CATALOGO_URLS: urlsFile,
      CATALOGO_INFORME: logFile,
      CATALOGO_TIMEOUT: '1',
      CATALOGO_REINTENTO: '0',
      CAUCE_PKI: tmp,
      CAUCE_DESTINO_AVISO: 'destino_personalizado',
    };

    const res = spawnSync('bash', [catalogoScript], { env, encoding: 'utf8' });
    assert.equal(res.status, 1, 'catalogo guard exits 1 when urls fail');

    let egressCalled = false;
    try {
      const content = readFileSync(curlLog, 'utf8');
      if (content.includes('EGRESS:')) {
        egressCalled = true;
      }
    } catch {
      egressCalled = false;
    }
    assert.equal(egressCalled, true, 'catalogo guard must attempt egress when explicit destination is provided');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('catalogo-mouseion-health: explicit CAUCE_EMPRESA missing in config fails closed without egress attempt', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'catalogo-guard-empresa-'));
  try {
    const urlsFile = join(tmp, 'urls.txt');
    const logFile = join(tmp, 'health.log');
    const curlLog = join(tmp, 'curl_calls.log');
    const confFile = join(tmp, 'aviso.json');

    writeFileSync(urlsFile, 'https://test.example/app\tok\n');
    writeFileSync(confFile, JSON.stringify({
      destino: 'steven_dm_global',
      empresas: {
        Steven: { destino: 'steven_dm' },
      },
    }));

    const fakeCurl = `#!/usr/bin/env bash
for arg in "$@"; do
  if [[ "$arg" == *"egress/notifications"* ]] || [[ "$arg" == *"/v3/messages"* ]]; then
    echo "EGRESS_ATTEMPT: $*" >> "${curlLog}"
  fi
done
echo "500 0 https://test.example/app"
`;
    const fakeCurlPath = join(tmp, 'curl');
    writeFileSync(fakeCurlPath, fakeCurl);
    chmodSync(fakeCurlPath, 0o755);

    const env = {
      PATH: `${tmp}:${process.env.PATH}`,
      CATALOGO_URLS: urlsFile,
      CATALOGO_INFORME: logFile,
      CATALOGO_TIMEOUT: '1',
      CATALOGO_REINTENTO: '0',
      CAUCE_PKI: tmp,
      CAUCE_DESTINO_AVISO: '',
      CAUCE_AVISO_CONF: confFile,
      CAUCE_EMPRESA: 'NonExistentEmpresa',
    };

    const res = spawnSync('bash', [catalogoScript], { env, encoding: 'utf8' });
    assert.equal(res.status, 2);

    let egressCalled = false;
    try {
      const content = readFileSync(curlLog, 'utf8');
      if (content.includes('EGRESS_ATTEMPT')) {
        egressCalled = true;
      }
    } catch {
      egressCalled = false;
    }
    assert.equal(egressCalled, false, 'must not fall back to global destino when explicit CAUCE_EMPRESA is missing');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('cauce-attach: destino_de handles missing, explicit, and multi-empresa config cleanly', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'attach-guard-test-'));
  try {
    const fakeConf = join(tmp, 'conf.json');
    writeFileSync(fakeConf, JSON.stringify({
      destino: 'global_fallback',
      empresas: {
        EmpresaA: { destino: 'destino_a' },
      },
    }));

    const pyCode = `
import sys, importlib.machinery, importlib.util, os
loader = importlib.machinery.SourceFileLoader('attach', sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
attach = importlib.util.module_from_spec(spec)
loader.exec_module(attach)

attach.AVISO_CONF = sys.argv[2]
os.environ['CAUCE_AVISO_CONF'] = sys.argv[2]

dest = attach.destino_de('zeus')
assert dest != 'steven_dm', f'unexpected {dest}'
assert dest == 'global_fallback', f'expected global_fallback, got {dest}'

class FakeMod:
    def __init__(self):
        self.gateway_called = False
    def gateway(self, *args, **kwargs):
        self.gateway_called = True
        return 202, {}

os.environ['CAUCE_EMPRESA'] = 'NonExistentEmpresa'
dest_missing_empresa = attach.destino_de('zeus')
assert dest_missing_empresa is None, f'must fail closed when CAUCE_EMPRESA is missing, got {dest_missing_empresa}'

mod_closed = FakeMod()
out_closed = attach.avisar(mod_closed, 'zeus', 'mensaje', 'sufijo')
assert not mod_closed.gateway_called
assert 'sin destino' in out_closed.lower()

os.environ['CAUCE_EMPRESA'] = 'EmpresaA'
dest_empresa = attach.destino_de('zeus')
assert dest_empresa == 'destino_a', f'expected destino_a, got {dest_empresa}'

del os.environ['CAUCE_EMPRESA']
for body in ['{', '[]', 'null', '{"aliases": []}',
             '{"aliases": {"zeus": []}}',
             '{"empresa":"EmpresaA","empresas":{"EmpresaA":[]},"destino":"global"}']:
    with open(sys.argv[2], 'w') as handle:
        handle.write(body)
    mod_malformed = FakeMod()
    assert attach.destino_de('zeus') is None
    assert 'sin destino' in attach.avisar(mod_malformed, 'zeus', 'mensaje', 'sufijo')
    assert not mod_malformed.gateway_called

os.environ['CAUCE_DESTINO_AVISO'] = 'alerta_manual'
dest_manual = attach.destino_de('zeus')
assert dest_manual == 'alerta_manual'

mod_explicit = FakeMod()
out_explicit = attach.avisar(mod_explicit, 'zeus', 'mensaje', 'sufijo')
assert mod_explicit.gateway_called
`;

    const res = spawnSync('python3', ['-c', pyCode, attachScript, fakeConf], {
      env: { ...process.env, CAUCE_DESTINO_AVISO: '', CAUCE_EMPRESA: '' },
      encoding: 'utf8',
    });

    assert.equal(res.status, 0, `Python test failed:\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('catalogo-mouseion-health: bus fallback requires an explicit tenant and room', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'catalogo-guard-bus-'));
  try {
    const urls = join(tmp, 'urls');
    const conf = join(tmp, 'conf.json');
    const calls = join(tmp, 'calls');
    writeFileSync(urls, 'https://test.example/app\tok\n');
    writeFileSync(conf, JSON.stringify({ empresas: { praxis: { destino: 'praxis_dm' } } }));
    mkdirSync(join(tmp, 'zeus'));
    for (const name of ['client.crt', 'client.key', 'ca.crt']) {
      writeFileSync(join(tmp, 'zeus', name), 'fake');
    }
    writeFileSync(join(tmp, 'curl'), `#!/usr/bin/env bash
for arg in "$@"; do
  if [[ "$arg" == *"/v3/messages"* ]]; then
    cat >> "${calls}"
    echo 202
    exit 0
  elif [[ "$arg" == *"/egress/notifications"* ]]; then
    echo 403
    exit 0
  fi
done
echo "500 0 https://test.example/app"
`);
    chmodSync(join(tmp, 'curl'), 0o755);
    const env = {
      PATH: `${tmp}:${process.env.PATH}`, CAUCE_EMPRESA: 'praxis', CAUCE_AVISO_CONF: conf,
      CAUCE_PKI: tmp, CATALOGO_URLS: urls, CATALOGO_INFORME: join(tmp, 'health.log'),
      CATALOGO_REINTENTO: '0',
    };
    const closed = spawnSync('bash', [catalogoScript], { env, encoding: 'utf8' });
    assert.equal(closed.status, 1);
    assert.throws(() => readFileSync(calls));
    assert.match(closed.stderr, /tenant.*sala/i);
    const explicit = spawnSync('bash', [catalogoScript], {
      env: { ...env, CAUCE_TENANT_AVISO: 'Hospital', CAUCE_SALA_AVISO: 'grp.hospital' },
      encoding: 'utf8',
    });
    assert.equal(explicit.status, 1);
    const payload = JSON.parse(readFileSync(calls, 'utf8'));
    assert.equal(payload.room_id, 'grp.hospital');
    assert.equal(payload.recipients[0].tenant_id, 'Hospital');
    rmSync(calls);
    rmSync(join(tmp, 'health.avisadas'), { force: true });
    const busOnly = spawnSync('bash', [catalogoScript], {
      env: { ...env, CAUCE_EMPRESA: '', CAUCE_AVISO_CONF: join(tmp, 'missing.json'),
        CAUCE_TENANT_AVISO: 'Hospital', CAUCE_SALA_AVISO: 'grp.hospital' },
      encoding: 'utf8',
    });
    assert.equal(busOnly.status, 1, busOnly.stderr);
    assert.match(busOnly.stderr, /sin destino de aviso/u);
    assert.equal(JSON.parse(readFileSync(calls, 'utf8')).recipients[0].tenant_id, 'Hospital');
    const halfBus = spawnSync('bash', [catalogoScript], {
      env: { ...env, CAUCE_EMPRESA: '', CAUCE_AVISO_CONF: join(tmp, 'missing.json'), CAUCE_TENANT_AVISO: 'Hospital' },
      encoding: 'utf8',
    });
    assert.equal(halfBus.status, 2, halfBus.stderr);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
