import crypto from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitUntil(operation, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) { lastError = error; }
    await sleep(30);
  }
  throw lastError || new Error(`condition timeout after ${timeoutMs}ms`);
}

export function redactUrl(value) {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/token|key|secret|auth/i.test(key)) url.searchParams.set(key, 'REDACTED');
  }
  return url.toString();
}

export function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function renderHarnessArtifacts(report, { suiteName, className, includeSkipped }) {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const totalSeconds = report.tests.reduce((sum, item) => sum + item.durationMs, 0) / 1_000;
  const cases = report.tests.map((test) => {
    const detail = test.status === 'failed'
      ? `<failure message="${xmlEscape(test.error)}">${xmlEscape(test.stack || test.error)}</failure>`
      : includeSkipped && test.status === 'skipped'
        ? `<skipped message="${xmlEscape(test.error)}"/>`
        : '';
    return `  <testcase classname="${className}" name="${xmlEscape(test.name)}" time="${(test.durationMs / 1_000).toFixed(3)}">${detail}</testcase>`;
  }).join('\n');
  const junit = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${suiteName}" tests="${report.summary.tests}" failures="${report.summary.failed}" skipped="${report.summary.skipped}" time="${totalSeconds.toFixed(3)}" timestamp="${report.startedAt}">\n${cases}\n</testsuite>\n`;
  const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const checksums = `${digest(json)}  report.json\n${digest(junit)}  junit.xml\n`;
  return { json, junit, checksums };
}

async function rejectSymbolicLink(targetPath) {
  try {
    const target = await lstat(targetPath);
    if (target.isSymbolicLink()) {
      throw new Error(`refusing to replace symbolic link: ${targetPath}`);
    }
    return target;
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeArtifactAtomically(artifactDir, name, contents) {
  const targetPath = path.join(artifactDir, name);
  const temporaryPath = path.join(
    artifactDir,
    `.${name}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`
  );
  let handle;

  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.chmod(0o644);
    await handle.sync();
    await handle.close();
    handle = undefined;

    await rejectSymbolicLink(targetPath);
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch((unlinkError) => {
      if (unlinkError?.code !== 'ENOENT') throw unlinkError;
    });
    throw error;
  }
}

export async function writeHarnessArtifacts(artifactDir, report, options) {
  const artifacts = renderHarnessArtifacts(report, options);
  await mkdir(artifactDir, { recursive: true });
  const artifactDirectory = await rejectSymbolicLink(artifactDir);
  if (!artifactDirectory?.isDirectory()) {
    throw new Error(`artifact path is not a directory: ${artifactDir}`);
  }

  const files = [
    ['report.json', artifacts.json],
    ['junit.xml', artifacts.junit],
    ['SHA256SUMS', artifacts.checksums],
  ];
  await Promise.all(files.map(([name]) => rejectSymbolicLink(path.join(artifactDir, name))));
  for (const [name, contents] of files) {
    await writeArtifactAtomically(artifactDir, name, contents);
  }
}
