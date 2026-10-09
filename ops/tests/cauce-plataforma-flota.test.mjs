#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const SCRIPTS = join(REPO, 'ops', 'scripts');

function encode(value) {
  return JSON.stringify(JSON.stringify(value));
}

function makeAgent({ tenant, alias, runtimeKey, room, enabled = true }) {
  const runtimeKeyValue = runtimeKey ?? alias;
  return {
    tenant_id: tenant,
    alias,
    harness_id: 'codex',
    enabled,
    container_name: 'ctrl-infra',
    runtime_user: 'dev',
    home_directory: '/home/dev',
    state_directory: `/home/dev/.local/state/cauce-v3/${runtimeKeyValue}`,
    runtime_key: runtimeKeyValue,
    primary_room_id: room,
  };
}

function makeMembership({ tenant, alias, room = 'grp.steven', role = 'agent', enabled = true }) {
  return { tenant_id: tenant, alias, room_id: room, role, enabled };
}

function makeFixture({ agents = [], memberships = [], purgedRuntimeKeys = [], roles = ['agent'] }) {
  return {
    agents,
    memberships,
    purgedRuntimeKeys,
    rolePolicies: roles.map((role) => ({ role })),
  };
}

function readJsonOrNull(text) {
  if (typeof text !== 'string' || text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function runExportCli({ fixture, cliArgs, companyTenants = null, overlay = {} }) {
  const tmp = mkdtempSync(join(REPO, '.tmp-cauce-wpi-scope-'));
  const placementPath = join(tmp, 'flota-fisica.json');
  const outputPath = join(tmp, 'flota.json');
  writeFileSync(placementPath, JSON.stringify({ schemaVersion: 1, placement: overlay }));

  const script = [
    'import sys, json, importlib.util',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'spec = importlib.util.spec_from_file_location("export_fleet_snapshot",'
      + ` ${JSON.stringify(join(SCRIPTS, 'export-fleet-snapshot.py'))})`,
    'MODULE = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(MODULE)',
    `fixture = json.loads(${encode(fixture)})`,
    `company_tenants_payload = json.loads(${encode(companyTenants)})`,
    'def fake_query(**kwargs):',
    '    return fixture',
    'def fake_company(company, **kwargs):',
    '    if company_tenants_payload is None:',
    '        return frozenset()',
    '    return frozenset(company_tenants_payload)',
    'MODULE.query_database = fake_query',
    'MODULE._query_company_tenants = fake_company',
    `sys.argv = ["x", "--database-url-file", "/dev/null", "--placement", ${JSON.stringify(placementPath)}, "--out", ${JSON.stringify(outputPath)}] + json.loads(${encode(cliArgs)})`,
    'sys.exit(MODULE.main(sys.argv[1:]))',
  ].join('\n');

  const proc = spawnSync('python3', ['-c', script], { encoding: 'utf8', cwd: REPO });
  let output = null;
  try {
    const text = readFileSync(outputPath, 'utf8');
    output = readJsonOrNull(text);
  } catch {
    output = null;
  }
  rmSync(tmp, { recursive: true, force: true });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr, output };
}

function importMaterializer() {
  const script = [
    'import sys, json, importlib.util',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'spec = importlib.util.spec_from_file_location("fleet_runtime_materialization",'
      + ` ${JSON.stringify(join(SCRIPTS, 'fleet_runtime_materialization.py'))})`,
    'MODULE = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(MODULE)',
    'sys.stdout.write(json.dumps({"ok": True}))',
  ].join('\n');
  return spawnSync('python3', ['-c', script], { encoding: 'utf8', cwd: REPO });
}

function renderArtifacts({ fixture, allowedTenants = null, company = null }) {
  const allowedExpr = allowedTenants === null
    ? 'None'
    : `frozenset(json.loads(${encode(allowedTenants)}))`;
  const script = [
    'import sys, json, importlib.util',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'spec = importlib.util.spec_from_file_location("fleet_runtime_materialization",'
      + ` ${JSON.stringify(join(SCRIPTS, 'fleet_runtime_materialization.py'))})`,
    'MODULE = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(MODULE)',
    `source = json.loads(${encode(fixture)})`,
    'try:',
    `    files = MODULE.render_artifacts(source, {}, allowed_tenants=${allowedExpr}, company=${company === null ? 'None' : JSON.stringify(company)})`,
    '    decoded = {name: files[name].decode("utf-8", errors="replace") for name in files}',
    '    print(json.dumps({"ok": True, "files": decoded}))',
    'except Exception as e:',
    '    print(json.dumps({"ok": False, "error": type(e).__name__, "message": str(e)}))',
  ].join('\n');
  const proc = spawnSync('python3', ['-c', script], { encoding: 'utf8', cwd: REPO });
  return { status: proc.status, payload: readJsonOrNull(proc.stdout), stderr: proc.stderr };
}

function materializeScoped({ allowedTenants }) {
  const stateDirectory = mkdtempSync('/var/tmp/cauce-wpi-mat-');
  const fixture = {
    agents: [makeAgent({ tenant: 'Steven', alias: 'kant', room: 'grp.steven' })],
    memberships: [makeMembership({ tenant: 'Steven', alias: 'kant', room: 'grp.steven' })],
    rolePolicies: [{ role: 'agent' }],
  };
  const script = [
    'import sys, json, pathlib, importlib.util',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'spec = importlib.util.spec_from_file_location("fleet_runtime_materialization",'
      + ` ${JSON.stringify(join(SCRIPTS, 'fleet_runtime_materialization.py'))})`,
    'MODULE = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(MODULE)',
    `source = json.loads(${encode(fixture)})`,
    `state = pathlib.Path(${JSON.stringify(stateDirectory)})`,
    `allowed = json.loads(${encode(allowedTenants)})`,
    'try:',
    '    MODULE.materialize(source, {}, state, allowed_tenants=frozenset(allowed), company="humanizar")',
    '    print(json.dumps({"ok": True}))',
    'except Exception as e:',
    '    print(json.dumps({"ok": False, "error": type(e).__name__,',
    '                      "published": (state / "desired-fleet.json").exists()}))',
  ].join('\n');
  const proc = spawnSync('python3', ['-c', script], { encoding: 'utf8', cwd: REPO });
  const payload = readJsonOrNull(proc.stdout);
  rmSync(stateDirectory, { recursive: true, force: true });
  return { status: proc.status, payload, stderr: proc.stderr };
}

const TOTAL = { pass: 0, fail: 0 };
function scenario(label, body) {
  try {
    body();
    TOTAL.pass += 1;
    process.stdout.write(`ok  ${label}\n`);
  } catch (error) {
    TOTAL.fail += 1;
    process.stdout.write(`FAIL ${label}\n${error?.stack ?? error}\n`);
  }
}

scenario('positivo: source mezclado + overlay mezclado devuelve solo la empresa seleccionada', () => {
  const fixture = makeFixture({
    agents: [
      makeAgent({ tenant: 'Steven', alias: 'kant', room: 'grp.steven' }),
      makeAgent({ tenant: 'Hospital', alias: 'kant', runtimeKey: 'praxis-kant', room: 'grp.hospital' }),
      makeAgent({ tenant: 'Hospital', alias: 'operador', runtimeKey: 'praxis-op', room: 'grp.hospital' }),
    ],
    memberships: [
      makeMembership({ tenant: 'Steven', alias: 'kant', room: 'grp.steven' }),
      makeMembership({ tenant: 'Hospital', alias: 'kant', room: 'grp.hospital' }),
      makeMembership({ tenant: 'Hospital', alias: 'operador', room: 'grp.hospital' }),
    ],
  });
  const overlay = {
    kant: { dockerHost: 'kratos' },
    'praxis-kant': { dockerHost: 'server2' },
    'praxis-op': { dockerHost: 'server2' },
  };

  const global = runExportCli({ fixture, cliArgs: [], overlay });
  assert.equal(global.status, 0, `global export failed: ${global.stderr}`);
  assert.ok('kant' in global.output.fleet, 'global must include Steven/kant');
  assert.ok('praxis-kant' in global.output.fleet, 'global must include Hospital/kant');
  assert.ok('praxis-op' in global.output.fleet, 'global must include Hospital/operador');
  assert.ok('praxis-kant' in global.output.placement, 'global placement must keep praxis-kant');
  assert.ok('praxis-op' in global.output.placement, 'global placement must keep praxis-op');

  const humanizar = runExportCli({
    fixture, cliArgs: ['--company=humanizar'], companyTenants: ['Steven'], overlay,
  });
  assert.equal(humanizar.status, 0,
    `humanizar export must succeed with mixed source and overlay: ${humanizar.stderr}`);
  assert.ok('kant' in humanizar.output.fleet, 'humanizar fleet should include Steven/kant');
  assert.ok(!('praxis-kant' in humanizar.output.fleet), 'humanizar fleet must exclude Hospital/kant');
  assert.ok(!('praxis-op' in humanizar.output.fleet), 'humanizar fleet must exclude Hospital/operador');
  assert.ok(!('praxis-kant' in humanizar.output.placement),
    'humanizar placement must drop Hospital/foreign overlay silently');
  assert.ok(!('praxis-op' in humanizar.output.placement),
    'humanizar placement must drop foreign Hospital/operador overlay silently');
  assert.ok('kant' in humanizar.output.placement,
    'humanizar placement must keep Steven/kant overlay');

  const praxis = runExportCli({
    fixture, cliArgs: ['--company=praxis'], companyTenants: ['Hospital'], overlay,
  });
  assert.equal(praxis.status, 0, `praxis export failed: ${praxis.stderr}`);
  assert.ok('praxis-kant' in praxis.output.fleet, 'praxis fleet should include Hospital/kant');
  assert.ok('praxis-op' in praxis.output.fleet, 'praxis fleet should include Hospital/operador');
  assert.ok(!('kant' in praxis.output.fleet), 'praxis fleet must exclude Steven/kant');
  assert.ok('praxis-kant' in praxis.output.placement, 'praxis placement must keep Hospital/kant overlay');
  assert.ok('praxis-op' in praxis.output.placement, 'praxis placement must keep Hospital/operador overlay');
});

scenario('overlay de alias realmente inexistente sigue siendo ERROR', () => {
  const fixture = makeFixture({
    agents: [makeAgent({ tenant: 'Steven', alias: 'kant', room: 'grp.steven' })],
    memberships: [makeMembership({ tenant: 'Steven', alias: 'kant', room: 'grp.steven' })],
  });
  const overlay = {
    kant: { dockerHost: 'kratos' },
    'unknown-from-another-realm': { dockerHost: 'server2' },
  };
  const r = runExportCli({
    fixture, cliArgs: ['--company=humanizar'], companyTenants: ['Steven'], overlay,
  });
  assert.notEqual(r.status, 0, `unknown alias overlay must fail: ${r.stderr}`);
  assert.match(r.stderr, /non-fleet|unknown/i);
});

scenario('una fila inválida de otra empresa no rompe ni se imprime en la paridad de esta empresa', () => {
  const foreignBroken = { ...makeAgent({ tenant: 'Hospital', alias: 'operador', runtimeKey: 'praxis-op',
    room: 'grp.hospital' }), harness_id: 'unsupported-harness', unexpected_column: 'x' };
  const foreignDrift = { ...makeAgent({ tenant: 'Hospital', alias: 'teseo', runtimeKey: 'praxis-teseo',
    room: 'grp.hospital' }), state_directory: '/home/dev/elsewhere' };
  const fixture = makeFixture({
    agents: [makeAgent({ tenant: 'Steven', alias: 'kant', room: 'grp.steven' }), foreignBroken, foreignDrift],
    memberships: [
      makeMembership({ tenant: 'Steven', alias: 'kant', room: 'grp.steven' }),
      { ...makeMembership({ tenant: 'Hospital', alias: 'operador', room: 'grp.hospital' }), role: 'missing-role' },
    ],
  });
  const overlay = { kant: { dockerHost: 'kratos' }, 'praxis-op': { dockerHost: 'server2' } };
  const humanizar = runExportCli({ fixture, cliArgs: ['--company=humanizar'], companyTenants: ['Steven'], overlay });
  assert.equal(humanizar.status, 0, `another company's rows must not fail this export: ${humanizar.stderr}`);
  assert.deepEqual(Object.keys(humanizar.output.fleet), ['kant']);
  assert.doesNotMatch(humanizar.stdout + humanizar.stderr, /Hospital|operador|teseo|praxis/u);
  const global = runExportCli({ fixture, cliArgs: [], overlay });
  assert.notEqual(global.status, 0, 'the global export stays strict over every row');
});

scenario('render_artifacts con company filtra tanto source como overlay', () => {
  const fixture = makeFixture({
    agents: [
      makeAgent({ tenant: 'Steven', alias: 'kant', room: 'grp.steven' }),
      makeAgent({ tenant: 'Hospital', alias: 'operador', runtimeKey: 'praxis-op', room: 'grp.hospital' }),
    ],
    memberships: [
      makeMembership({ tenant: 'Steven', alias: 'kant', room: 'grp.steven' }),
      makeMembership({ tenant: 'Hospital', alias: 'operador', room: 'grp.hospital' }),
    ],
  });
  const r = renderArtifacts({ fixture, allowedTenants: ['Steven'], company: 'humanizar' });
  assert.equal(r.status, 0, `render_artifacts must succeed: ${r.stderr}`);
  assert.equal(r.payload.ok, true, `render_artifacts must succeed: ${r.payload?.message}`);
  const files = r.payload.files;
  assert.ok('flota.json' in files, 'flota.json must be present');
  const flota = JSON.parse(files['flota.json']);
  assert.ok('kant' in flota.fleet, 'flota.fleet must include Steven/kant');
  assert.ok(!('praxis-op' in flota.fleet), 'flota.fleet must exclude Hospital/operador');
  assert.ok(!('praxis-op' in (flota.placement || {})),
    'flota.placement must drop foreign Hospital/operador overlay');
  for (const [name, body] of Object.entries(files)) {
    assert.ok(!body.includes('praxis-op'),
      `artifact ${name} must not reference foreign runtime key praxis-op`);
    assert.ok(!body.includes('"tenant":"Hospital"'),
      `artifact ${name} must not include Hospital tenant rows`);
  }
});

scenario('render_artifacts sin allowed_tenants preserva source y overlay completos', () => {
  const fixture = makeFixture({
    agents: [
      makeAgent({ tenant: 'Steven', alias: 'kant', room: 'grp.steven' }),
      makeAgent({ tenant: 'Hospital', alias: 'operador', runtimeKey: 'praxis-op', room: 'grp.hospital' }),
    ],
    memberships: [
      makeMembership({ tenant: 'Steven', alias: 'kant', room: 'grp.steven' }),
      makeMembership({ tenant: 'Hospital', alias: 'operador', room: 'grp.hospital' }),
    ],
  });
  const r = renderArtifacts({ fixture });
  assert.equal(r.status, 0, `render_artifacts without tenant filter must succeed: ${r.stderr}`);
  assert.equal(r.payload.ok, true, r.payload?.message);
  const files = r.payload.files;
  const flota = JSON.parse(files['flota.json']);
  assert.ok('kant' in flota.fleet, 'global render must include Steven/kant');
  assert.ok('praxis-op' in flota.fleet, 'global render must include Hospital/operador');
});

scenario('materialize rechaza publicar una flota de una sola empresa como desired-fleet.json compartido', () => {
  const r = materializeScoped({ allowedTenants: ['Steven'] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.payload.ok, false, 'a company-scoped materialization must be refused');
  assert.equal(r.payload.error, 'TypeError');
  assert.equal(r.payload.published, false, 'nothing may be published when the company scope is refused');
});

scenario('_query_company_tenants no expone secretos del stderr de psql', () => {
  const SECRET = 'psql://user:SECRET_TOKEN_d0_not_leak@host/db';
  const script = [
    'import sys, importlib.util',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'spec = importlib.util.spec_from_file_location("export_fleet_snapshot",'
      + ` ${JSON.stringify(join(SCRIPTS, 'export-fleet-snapshot.py'))})`,
    'MODULE = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(MODULE)',
    'import subprocess',
    `SECRET = ${JSON.stringify(SECRET)}`,
    'def fake_run(command, **kwargs):',
    '    return subprocess.CompletedProcess(args=command, returncode=2, stdout="", stderr=SECRET)',
    'MODULE.subprocess.run = fake_run',
    'try:',
    '    MODULE._query_company_tenants("humanizar", database_url_file=__import__("pathlib").Path("/dev/null"))',
    '    print(json.dumps({"ok": True}))',
    'except Exception as e:',
    '    import json',
    '    print(json.dumps({"ok": False, "message": str(e), "type": type(e).__name__}))',
  ].join('\n');
  const proc = spawnSync('python3', ['-c', script], { encoding: 'utf8', cwd: REPO });
  const payload = readJsonOrNull(proc.stdout);
  assert.ok(payload && payload.ok === false, `must raise SnapshotError: ${payload}`);
  assert.ok(payload.message && !payload.message.includes('SECRET_TOKEN_d0_not_leak'),
    `exception message must not leak psql stderr: ${payload.message}`);
  assert.match(payload.message, /company tenants query failed/);
  assert.doesNotMatch(payload.message, /SECRET_TOKEN|user:|postgresql:|psql:/);
});

scenario('slug de 64 caracteres (regex {0,63}) es valido y NO falla en regex', () => {
  const script = [
    'import sys, importlib.util',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'spec = importlib.util.spec_from_file_location("export_fleet_snapshot",'
      + ` ${JSON.stringify(join(SCRIPTS, 'export-fleet-snapshot.py'))})`,
    'MODULE = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(MODULE)',
    'import subprocess, json, pathlib',
    'captured = {}',
    'def fake_run(command, **kwargs):',
    '    captured["variable"] = next((arg for arg in command if arg.startswith("--variable=")), None)',
    '    return subprocess.CompletedProcess(args=command, returncode=0, stdout="Steven\\n", stderr="")',
    'MODULE.subprocess.run = fake_run',
    `slug = "a${"b".repeat(63)}"`,
    'assert len(slug) == 64, len(slug)',
    'tenants = MODULE._query_company_tenants(slug, database_url_file=pathlib.Path("/dev/null"))',
    'print(json.dumps({"ok": True, "variable": captured["variable"], "tenants": sorted(tenants)}))',
  ].join('\n');
  const proc = spawnSync('python3', ['-c', script], { encoding: 'utf8', cwd: REPO });
  const payload = readJsonOrNull(proc.stdout);
  assert.ok(payload && payload.ok === true, `valid 64-char slug must not fail: ${payload} stderr=${proc.stderr}`);
  assert.match(payload.variable ?? '', /^--variable=company_id=/,
    `psql variable must use company_id (companies.id), got: ${payload.variable}`);
  assert.deepEqual(payload.tenants, ['Steven']);
});

scenario('slug con caracteres peligrosos se rechaza por regex antes de psql', () => {
  const cases = [
    "Steven'; DROP TABLE tenants;--",
    'Steven;DROP',
    'STEVEN',
    '1empresa',
    'a b',
    '',
  ];
  for (const slug of cases) {
    const script = [
      'import sys, importlib.util',
      `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
      'spec = importlib.util.spec_from_file_location("export_fleet_snapshot",'
        + ` ${JSON.stringify(join(SCRIPTS, 'export-fleet-snapshot.py'))})`,
      'MODULE = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(MODULE)',
      'import subprocess, json, pathlib',
      'def fake_run(command, **kwargs):',
      '    raise AssertionError("psql must not run for invalid slug")',
      'MODULE.subprocess.run = fake_run',
      `slug = json.loads(${encode(slug)})`,
      'try:',
      '    MODULE._query_company_tenants(slug, database_url_file=pathlib.Path("/dev/null"))',
      '    print(json.dumps({"ok": True}))',
      'except Exception as e:',
      '    print(json.dumps({"ok": False, "message": str(e), "type": type(e).__name__}))',
    ].join('\n');
    const proc = spawnSync('python3', ['-c', script], { encoding: 'utf8', cwd: REPO });
    const payload = readJsonOrNull(proc.stdout);
    assert.equal(payload?.ok, false, `slug must be rejected at regex: ${JSON.stringify(slug)}`);
    assert.match(payload.message, /invalid|company/i);
  }
});

scenario('rechazo de empresa desconocida (consulta devuelve vacio)', () => {
  const fixture = makeFixture({
    agents: [makeAgent({ tenant: 'Steven', alias: 'kant', room: 'grp.steven' })],
    memberships: [makeMembership({ tenant: 'Steven', alias: 'kant', room: 'grp.steven' })],
  });
  const r = runExportCli({ fixture, cliArgs: ['--company=ghost'], companyTenants: [] });
  assert.notEqual(r.status, 0, `unknown company must fail: ${r.stderr}`);
  assert.match(r.stderr, /ghost|unknown|tenant|company/i);
});

scenario('global (sin --company) preserva el comportamiento previo', () => {
  const fixture = makeFixture({
    agents: [
      makeAgent({ tenant: 'Steven', alias: 'kant', room: 'grp.steven' }),
      makeAgent({ tenant: 'Hospital', alias: 'operador', runtimeKey: 'praxis-op', room: 'grp.hospital' }),
    ],
    memberships: [
      makeMembership({ tenant: 'Steven', alias: 'kant', room: 'grp.steven' }),
      makeMembership({ tenant: 'Hospital', alias: 'operador', room: 'grp.hospital' }),
    ],
  });
  const r = runExportCli({ fixture, cliArgs: [] });
  assert.equal(r.status, 0, `global failed: ${r.stderr}`);
  assert.ok('kant' in r.output.fleet, 'global fleet must include Steven/kant');
  assert.ok('praxis-op' in r.output.fleet, 'global fleet must include Hospital/operador');
});

scenario('company exige salida explícita fuera del catálogo global', () => {
  for (const output of [[], ['--out', join(REPO, 'ops', 'flota.json')]]) {
    const script = [
      'import sys, importlib.util',
      `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
      `spec = importlib.util.spec_from_file_location("exporter", ${JSON.stringify(join(SCRIPTS, 'export-fleet-snapshot.py'))})`,
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'def forbidden(**kwargs):',
      '    raise AssertionError("must reject before querying")',
      'module.query_database = forbidden',
      `module.main(json.loads(${encode(['--company', 'humanizar', '--database-url-file', '/dev/null', ...output])}))`,
    ];
    script.splice(0, 0, 'import json');
    const proc = spawnSync('python3', ['-c', script.join('\n')], { encoding: 'utf8', cwd: REPO });
    assert.equal(proc.status, 2, proc.stderr);
    assert.match(proc.stderr, /company.*out|out.*company/i);
  }
});

scenario('allowed_tenants sin company conserva el rechazo de tenants ajenos', () => {
  const fixture = makeFixture({
    agents: [makeAgent({ tenant: 'Hospital', alias: 'operador', room: 'grp.hospital' })],
    memberships: [makeMembership({ tenant: 'Hospital', alias: 'operador', room: 'grp.hospital' })],
  });
  const r = renderArtifacts({ fixture, allowedTenants: ['Steven'] });
  assert.equal(r.payload?.ok, false);
  assert.match(r.payload.message, /outside the allowed tenants/);
  const empty = renderArtifacts({ fixture, allowedTenants: [], company: 'humanizar' });
  assert.equal(empty.payload?.ok, false);
  assert.match(empty.payload.message, /non-empty tenants/);
});

if (importMaterializer().status !== 0) {
  process.stdout.write('FAIL materializer import sanity\n');
  process.exit(2);
}

process.stdout.write(`\n${TOTAL.pass} passed, ${TOTAL.fail} failed of ${TOTAL.pass + TOTAL.fail} scenarios\n`);
if (TOTAL.fail > 0) process.exitCode = 1;
