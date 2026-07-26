#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readAliasManifest, validateFleetMatrix } from './manifest-matrix.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Aggregates per-host smoke evidence, which is itself runtime-domain bound, so this artifact uses
// the same domain (see ops/scripts/source-digest.py).
const SOURCE_DIGEST_DOMAIN = 'runtime';

async function currentSourceDigest() {
  const { stdout } = await execFileAsync('python3', [path.join(repositoryRoot, 'ops/scripts/source-digest.py'), '--domain', SOURCE_DIGEST_DOMAIN], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  const value = stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error('source digest script returned an invalid digest');
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function validInventory(inventory) {
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) throw new Error('inventory must be an object');
  if (inventory.schemaVersion !== 1) throw new Error('inventory.schemaVersion must be 1');
  if (typeof inventory.controlPlaneHost !== 'string' || !inventory.controlPlaneHost) {
    throw new Error('inventory.controlPlaneHost is required');
  }
  if (!inventory.hosts || typeof inventory.hosts !== 'object' || Array.isArray(inventory.hosts)) {
    throw new Error('inventory.hosts must be an object');
  }
  if (!(inventory.controlPlaneHost in inventory.hosts)) throw new Error('control-plane host must be present in inventory.hosts');
  for (const [host, manifests] of Object.entries(inventory.hosts)) {
    if (!host || !Array.isArray(manifests) || manifests.some((entry) => typeof entry !== 'string')) {
      throw new Error(`inventory host '${host}' must contain manifest paths`);
    }
  }
  return inventory;
}

function checkByHarness(evidence, harness) {
  return Array.isArray(evidence?.checks)
    ? evidence.checks.find((check) => check?.harness === harness)
    : undefined;
}

export async function aggregateHostEvidence({
  inventory: inputInventory,
  evidenceByHost,
  now = new Date(),
  sourceDigest,
}) {
  const inventory = validInventory(inputInventory);
  const boundSourceDigest = sourceDigest ?? await currentSourceDigest();
  if (!/^sha256:[a-f0-9]{64}$/u.test(boundSourceDigest)) throw new Error('sourceDigest is invalid');
  const assignments = [];
  for (const [host, paths] of Object.entries(inventory.hosts)) {
    for (const manifestPath of paths) assignments.push({ host, manifest: await readAliasManifest(manifestPath) });
  }
  validateFleetMatrix(assignments.map((assignment) => assignment.manifest));
  const duplicateAssignments = assignments.filter((assignment, index) =>
    assignments.findIndex((candidate) => candidate.manifest.alias === assignment.manifest.alias) !== index);
  if (duplicateAssignments.length > 0) throw new Error(`alias '${duplicateAssignments[0].manifest.alias}' is assigned more than once`);

  const violations = [];
  const hosts = [];
  for (const host of Object.keys(inventory.hosts).sort()) {
    const expected = assignments.filter((assignment) => assignment.host === host).map((assignment) => assignment.manifest);
    const requiredHarnesses = [...new Set(expected.map((manifest) => manifest.harness))].sort();
    const evidence = evidenceByHost[host];
    const hostViolations = [];
    if (expected.length > 0 && !evidence) hostViolations.push('host evidence is missing');
    if (evidence && evidence.host !== host) hostViolations.push('evidence host identity does not match inventory');
    if (evidence && (evidence.schemaVersion !== 1 || evidence.suite !== 'cauce-v3-host-harness-smoke')) {
      hostViolations.push('evidence schema or suite is invalid');
    }
    if (evidence && evidence.sourceDigest !== boundSourceDigest) hostViolations.push('evidence sourceDigest differs from release source');
    const observedManifests = Array.isArray(evidence?.manifests) ? evidence.manifests : [];
    if (evidence && observedManifests.length !== expected.length) hostViolations.push('evidence manifest count differs from inventory');
    for (const observed of observedManifests) {
      if (!expected.some((manifest) => manifest.alias === observed?.alias)) {
        hostViolations.push(`unexpected manifest evidence for ${String(observed?.alias)}`);
      }
    }
    for (const manifest of expected) {
      const observed = observedManifests.find((entry) => entry?.alias === manifest.alias);
      if (!observed) hostViolations.push(`manifest evidence is missing for ${manifest.alias}`);
      else if (observed.harness !== manifest.harness || observed.sha256 !== manifest.sha256) {
        hostViolations.push(`manifest evidence differs for ${manifest.alias}`);
      }
    }
    for (const harness of requiredHarnesses) {
      const check = checkByHarness(evidence, harness);
      if (!check) hostViolations.push(`${harness} --version/--help evidence is missing`);
      else if (check.status !== 'passed') hostViolations.push(`${harness} --version/--help did not pass`);
      else if (check.evidenceClass !== 'harness-authentic') hostViolations.push(`${harness} evidence is not harness-authentic`);
      else if (!/^[a-f0-9]{64}$/u.test(check.binarySha256 ?? '')) hostViolations.push(`${harness} binary digest is invalid`);
    }
    for (const violation of hostViolations) violations.push(`${host}: ${violation}`);
    hosts.push({
      host,
      role: host === inventory.controlPlaneHost ? 'control-plane' : 'adapter-host',
      aliases: expected.map((manifest) => manifest.alias).sort(),
      requiredHarnesses,
      openClawRequired: requiredHarnesses.includes('openclaw'),
      status: hostViolations.length === 0 ? 'passed' : 'failed',
      violations: hostViolations,
    });
  }
  const openClawEvidenceHosts = hosts.filter((host) => host.openClawRequired).map((host) => host.host);
  return {
    schemaVersion: 1,
    suite: 'cauce-v3-host-smoke-aggregate',
    sourceDigest: boundSourceDigest,
    sourceDigestDomain: SOURCE_DIGEST_DOMAIN,
    controlPlaneHost: inventory.controlPlaneHost,
    policy: 'OpenClaw evidence is required only on hosts assigned OpenClaw manifests',
    finishedAt: now.toISOString(),
    fleet: {
      aliases: assignments.length,
      harnessCounts: validateFleetMatrix(assignments.map((assignment) => assignment.manifest)).counts,
      openClawEvidenceHosts,
      controlPlaneOpenClawRequired: openClawEvidenceHosts.includes(inventory.controlPlaneHost),
    },
    summary: {
      hosts: hosts.length,
      passed: hosts.filter((host) => host.status === 'passed').length,
      failed: hosts.filter((host) => host.status === 'failed').length,
      violations: violations.length,
    },
    hosts,
    violations,
  };
}

export async function writeAggregateArtifacts(report, outputDirectory) {
  const directory = path.resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const cases = report.hosts.map((host) => {
    const failure = host.status === 'failed'
      ? `<failure message="${xmlEscape(host.violations.join('; '))}"/>`
      : '';
    return `  <testcase classname="cauce.host-smoke" name="${xmlEscape(host.host)}">${failure}</testcase>`;
  }).join('\n');
  const junit = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="cauce-v3-host-smoke-aggregate" tests="${report.summary.hosts}" failures="${report.summary.failed}" skipped="0">\n  <properties><property name="sourceDigest" value="${report.sourceDigest}"/></properties>\n${cases}\n</testsuite>\n`;
  await writeFile(path.join(directory, 'report.json'), json, { mode: 0o644 });
  await writeFile(path.join(directory, 'junit.xml'), junit, { mode: 0o644 });
  await writeFile(path.join(directory, 'SHA256SUMS'), `${sha256(json)}  report.json\n${sha256(junit)}  junit.xml\n`, { mode: 0o644 });
}

function one(args, flag) {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function many(args, flag) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) continue;
    if (!args[index + 1]) throw new Error(`${flag} requires a value`);
    result.push(args[index + 1]);
    index += 1;
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const inventoryPath = path.resolve(one(args, '--inventory'));
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  const evidenceByHost = {};
  for (const evidencePath of many(args, '--evidence')) {
    const evidence = JSON.parse(await readFile(path.resolve(evidencePath), 'utf8'));
    if (typeof evidence.host !== 'string' || evidenceByHost[evidence.host]) {
      throw new Error(`duplicate or invalid evidence host in ${evidencePath}`);
    }
    evidenceByHost[evidence.host] = evidence;
  }
  const report = await aggregateHostEvidence({ inventory, evidenceByHost });
  await writeAggregateArtifacts(report, one(args, '--out-dir'));
  process.stdout.write(`${report.summary.failed === 0 ? 'PASS' : 'FAIL'} host smoke aggregate: ${report.summary.passed}/${report.summary.hosts} hosts\n`);
  if (report.summary.failed > 0) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
