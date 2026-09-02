import crypto from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  redactUrl,
  renderHarnessArtifacts,
  waitUntil,
  writeHarnessArtifacts,
  xmlEscape,
} from '../../ops/harness/harness-utils.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true })
  ));
});

function fixtureReport() {
  return {
    schemaVersion: 1,
    suite: 'fixture',
    startedAt: '2026-09-01T12:34:56.000Z',
    summary: { tests: 3, passed: 1, failed: 1, skipped: 1 },
    tests: [
      { name: 'passes & stays', status: 'passed', durationMs: 1_250 },
      {
        name: 'fails <fast>',
        status: 'failed',
        durationMs: 5,
        error: 'bad "input" & value',
        stack: "stack > cause 'quoted'",
      },
      { name: 'skip > later', status: 'skipped', durationMs: 10, error: 'needs <fixture>' },
    ],
  };
}

describe('harness utility contracts', () => {
  it('redacts URL credentials and sensitive query parameters', () => {
    const value = redactUrl(
      'https://alice:password@example.test/path?token=secret-token&api_key=secret-key&authorization=secret-auth&plain=visible#anchor'
    );

    expect(value).toBe(
      'https://example.test/path?token=REDACTED&api_key=REDACTED&authorization=REDACTED&plain=visible#anchor'
    );
    expect(value).not.toContain('alice');
    expect(value).not.toContain('password');
    expect(value).not.toContain('secret-');
  });

  it('escapes every XML-sensitive code point', () => {
    expect(xmlEscape(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });

  it('preserves polling success and the last operation error', async () => {
    let attempts = 0;
    await expect(waitUntil(() => {
      attempts += 1;
      return attempts === 2 ? 'ready' : undefined;
    }, 100)).resolves.toBe('ready');

    const expected = new Error('last failure');
    await expect(waitUntil(() => Promise.reject(expected), 35)).rejects.toBe(expected);
    await expect(waitUntil(() => false, 1)).rejects.toThrow('condition timeout after 1ms');
  });

  it('renders byte-stable JSON, JUnit and SHA256 output for contract skips', () => {
    const report = fixtureReport();
    const artifacts = renderHarnessArtifacts(report, {
      suiteName: 'cauce-v3-contract-e2e',
      className: 'cauce.contract',
      includeSkipped: true,
    });
    const expectedJunit = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<testsuite name="cauce-v3-contract-e2e" tests="3" failures="1" skipped="1" time="1.265" timestamp="2026-09-01T12:34:56.000Z">',
      '  <testcase classname="cauce.contract" name="passes &amp; stays" time="1.250"></testcase>',
      '  <testcase classname="cauce.contract" name="fails &lt;fast&gt;" time="0.005"><failure message="bad &quot;input&quot; &amp; value">stack &gt; cause &apos;quoted&apos;</failure></testcase>',
      '  <testcase classname="cauce.contract" name="skip &gt; later" time="0.010"><skipped message="needs &lt;fixture&gt;"/></testcase>',
      '</testsuite>',
      '',
    ].join('\n');
    const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

    expect(artifacts.json).toBe(`${JSON.stringify(report, null, 2)}\n`);
    expect(artifacts.junit).toBe(expectedJunit);
    expect(artifacts.checksums).toBe(
      `${digest(artifacts.json)}  report.json\n${digest(expectedJunit)}  junit.xml\n`
    );
  });

  it('keeps real-suite skip rendering disabled and replaces permissive files as 0644', async () => {
    const report = fixtureReport();
    const directory = await mkdtemp(path.join(tmpdir(), 'cauce-harness-utils-'));
    temporaryDirectories.push(directory);
    const options = {
      suiteName: 'cauce-v3-real-e2e',
      className: 'cauce.real',
      includeSkipped: false,
    };
    const expected = renderHarnessArtifacts(report, options);
    for (const name of ['report.json', 'junit.xml', 'SHA256SUMS']) {
      const target = path.join(directory, name);
      await writeFile(target, 'stale artifact');
      await chmod(target, 0o666);
    }

    await writeHarnessArtifacts(directory, report, options);

    const [json, junit, checksums] = await Promise.all([
      readFile(path.join(directory, 'report.json'), 'utf8'),
      readFile(path.join(directory, 'junit.xml'), 'utf8'),
      readFile(path.join(directory, 'SHA256SUMS'), 'utf8'),
    ]);
    expect({ json, junit, checksums }).toEqual(expected);
    expect(junit).toContain('name="skip &gt; later" time="0.010"></testcase>');
    expect(junit).not.toContain('<skipped');

    for (const name of ['report.json', 'junit.xml', 'SHA256SUMS']) {
      expect((await stat(path.join(directory, name))).mode & 0o777).toBe(0o644);
    }
  });

  it('rejects symbolic artifact destinations without following them', async () => {
    const report = fixtureReport();
    const directory = await mkdtemp(path.join(tmpdir(), 'cauce-harness-utils-'));
    temporaryDirectories.push(directory);
    const outsidePath = path.join(directory, 'outside.txt');
    const reportPath = path.join(directory, 'report.json');
    await writeFile(outsidePath, 'must stay unchanged');
    await symlink(outsidePath, reportPath);

    await expect(writeHarnessArtifacts(directory, report, {
      suiteName: 'cauce-v3-real-e2e',
      className: 'cauce.real',
      includeSkipped: false,
    })).rejects.toThrow('refusing to replace symbolic link');

    expect(await readFile(outsidePath, 'utf8')).toBe('must stay unchanged');
    expect((await lstat(reportPath)).isSymbolicLink()).toBe(true);
  });
});
