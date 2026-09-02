import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GUION = join(RAIZ, 'ops/scripts/auditoria-de-dependencias.mjs');
const HOY = '2100-01-01';
const VIGENTE = '2100-06-30';
const VENCIDO = '2099-12-31';

function aviso({ id, ghsa, paquete, severidad }) {
  return {
    id,
    github_advisory_id: ghsa,
    module_name: paquete,
    severity: severidad,
    title: `fallo de prueba en ${paquete}`,
    url: `https://github.com/advisories/${ghsa}`,
    findings: [{ version: '1.0.0', paths: [`services__gateway>${paquete}`], dev: false }],
  };
}

const ALTO = aviso({ id: 900001, ghsa: 'GHSA-aaaa-bbbb-cccc', paquete: 'paquete-alto', severidad: 'high' });
const MEDIO = aviso({ id: 900002, ghsa: 'GHSA-dddd-eeee-ffff', paquete: 'paquete-medio', severidad: 'moderate' });

function permiso(advisory, paquete, revisar = VIGENTE) {
  return { advisory, paquete, razon: 'sin parche upstream, alcance acotado', revisar_antes_de: revisar };
}

// Hermetic: the script reads a fixture instead of running pnpm, and "today" comes from the env.
function correr(nombre, avisosDeSalida, permitidos) {
  const directorio = mkdtempSync(join(tmpdir(), `cauce-auditoria-${nombre}-`));
  try {
    const entrada = join(directorio, 'audit.json');
    const lista = join(directorio, 'permitida.json');
    const advisories = Object.fromEntries(avisosDeSalida.map((candidato) => [String(candidato.id), candidato]));
    const conteo = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
    for (const candidato of avisosDeSalida) conteo[candidato.severity] += 1;
    writeFileSync(entrada, JSON.stringify({ advisories, metadata: { vulnerabilities: conteo } }));
    writeFileSync(lista, JSON.stringify({ permitidos }));
    return spawnSync(process.execPath, [GUION], {
      cwd: RAIZ,
      encoding: 'utf8',
      env: {
        ...process.env,
        CAUCE_AUDITORIA_ENTRADA: entrada,
        CAUCE_AUDITORIA_PERMITIDOS: lista,
        CAUCE_AUDITORIA_HOY: HOY,
      },
    });
  } finally {
    rmSync(directorio, { recursive: true, force: true });
  }
}

test('un high sin permiso deja rojo el gate y nombra el paquete', () => {
  const resultado = correr('alto-sin-permiso', [ALTO, MEDIO], []);
  assert.equal(resultado.status, 1);
  assert.match(resultado.stdout, /high\s+paquete-alto\s+GHSA-aaaa-bbbb-cccc/u);
  assert.match(resultado.stdout, /services__gateway>paquete-alto/u);
  assert.match(resultado.stdout, /FALLO: 1 advisories high\/critical sin permiso/u);
});

test('el mismo high permitido deja verde el gate', () => {
  const resultado = correr('alto-permitido', [ALTO, MEDIO], [permiso('GHSA-aaaa-bbbb-cccc', 'paquete-alto')]);
  assert.equal(resultado.status, 0);
  assert.match(resultado.stdout, /permitidos vigentes \(1\)/u);
  assert.match(resultado.stdout, /auditoria: VERDE/u);
});

test('el id numerico tambien identifica un permiso', () => {
  const resultado = correr('alto-por-id', [ALTO], [permiso('900001', 'paquete-alto')]);
  assert.equal(resultado.status, 0);
});

test('un permiso que la auditoria ya no reporta deja rojo el gate', () => {
  const resultado = correr('permiso-que-sobra', [MEDIO], [permiso('GHSA-aaaa-bbbb-cccc', 'paquete-alto')]);
  assert.equal(resultado.status, 1);
  assert.match(resultado.stdout, /FALLO: permiso que sobra: GHSA-aaaa-bbbb-cccc/u);
});

test('un permiso con la fecha de revision pasada deja rojo el gate', () => {
  const resultado = correr('permiso-vencido', [ALTO], [permiso('GHSA-aaaa-bbbb-cccc', 'paquete-alto', VENCIDO)]);
  assert.equal(resultado.status, 1);
  assert.match(resultado.stdout, /FALLO: permiso vencido: GHSA-aaaa-bbbb-cccc/u);
});

test('un moderate sin permiso deja verde el gate', () => {
  const resultado = correr('moderate-sin-permiso', [MEDIO], []);
  assert.equal(resultado.status, 0);
  assert.match(resultado.stdout, /1 moderate/u);
  assert.match(resultado.stdout, /auditoria: VERDE/u);
});

test('un permiso mal formado corta con codigo 2 en vez de pasar por verde', () => {
  const resultado = correr('permiso-mal-formado', [ALTO], [{ advisory: 'GHSA-aaaa-bbbb-cccc' }]);
  assert.equal(resultado.status, 2);
  assert.match(resultado.stderr, /debe declarar exactamente/u);
});
