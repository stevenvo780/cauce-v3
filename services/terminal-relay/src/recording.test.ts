import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RECORDING_MAX_BYTES,
  RecordingUnavailableError,
  SessionRecording,
} from './recording.js';

const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'terminal-recording-'));
  directories.push(directory);
  return join(directory, 'recordings');
}

function open(directory: string | undefined, overrides: Record<string, unknown> = {}): SessionRecording {
  let clock = 1_700_000_000_000;
  return SessionRecording.open(SESSION_ID, {
    directory,
    cols: 120,
    rows: 40,
    now: () => {
      clock += 250;
      return clock;
    },
    ...overrides,
  });
}

describe('session recording', () => {
  it('writes an asciicast v2 file only its owner can read, append-only and digested', async () => {
    const directory = await scratch();
    const recording = open(directory);
    recording.recordOutput(Buffer.from('claw@jarvis:~$ '));
    recording.recordInput(Buffer.from('id -un\r'));
    recording.recordOutput(Buffer.from('claw\r\n'));
    const report = recording.close();

    const path = join(directory, `${SESSION_ID}.cast`);
    const contents = await readFile(path, 'utf8');
    const lines = contents.split('\n').filter((line) => line.length > 0);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ version: 2, width: 120, height: 40 });
    expect(JSON.parse(lines[1] ?? '[]')).toEqual([expect.any(Number), 'o', 'claw@jarvis:~$ ']);
    expect(JSON.parse(lines[2] ?? '[]')).toEqual([expect.any(Number), 'i', 'id -un\r']);
    expect(JSON.parse(lines[3] ?? '[]')).toEqual([expect.any(Number), 'o', 'claw\r\n']);
    expect(lines).toHaveLength(4);

    expect(report.input_batches).toBe(1);
    expect(report.capped).toBe(false);
    expect(report.bytes).toBe(Buffer.byteLength(contents, 'utf8'));
    expect(report.sha256).toMatch(/^[0-9a-f]{64}$/u);

    const file = await stat(path);
    const folder = await stat(directory);
    expect(file.mode & 0o777).toBe(0o600);
    expect(folder.mode & 0o777).toBe(0o700);
  });

  it('produces the same digest for the same stream and a different one for different bytes', async () => {
    const first = open(await scratch());
    first.recordOutput(Buffer.from('same'));
    const firstReport = first.close();
    const second = open(await scratch());
    second.recordOutput(Buffer.from('same'));
    const secondReport = second.close();
    const third = open(await scratch());
    third.recordOutput(Buffer.from('other'));
    const thirdReport = third.close();

    expect(secondReport.sha256).toBe(firstReport.sha256);
    expect(thirdReport.sha256).not.toBe(firstReport.sha256);
  });

  it('carries a split multibyte sequence across chunks instead of corrupting it', async () => {
    const directory = await scratch();
    const recording = open(directory);
    const euro = Buffer.from('€', 'utf8');
    recording.recordOutput(euro.subarray(0, 1));
    recording.recordOutput(euro.subarray(1));
    recording.close();

    const lines = (await readFile(join(directory, `${SESSION_ID}.cast`), 'utf8'))
      .split('\n').filter((line) => line.length > 0);
    expect(lines.map((line) => (JSON.parse(line) as unknown[])[2]).slice(1).join('')).toBe('€');
  });

  it('refuses to open without a directory, on an unwritable one, and on a second open', async () => {
    expect(() => open(undefined)).toThrow(RecordingUnavailableError);

    const directory = await scratch();
    await writeFile(directory, 'not a directory', { mode: 0o600 });
    expect(() => open(directory)).toThrow(RecordingUnavailableError);

    const usable = await scratch();
    const first = open(usable);
    try {
      expect(() => open(usable)).toThrow(RecordingUnavailableError);
    } finally {
      first.close();
    }
  });

  it('stops at the byte cap with a marker instead of truncating the session', async () => {
    const directory = await scratch();
    const recording = open(directory, { maxBytes: 512 });
    for (let index = 0; index < 40; index += 1) recording.recordOutput(Buffer.alloc(64, 0x41));
    recording.recordInput(Buffer.from('still typing'));
    const report = recording.close();

    expect(report.capped).toBe(true);
    expect(report.bytes).toBeLessThan(1_024);
    const lines = (await readFile(join(directory, `${SESSION_ID}.cast`), 'utf8'))
      .split('\n').filter((line) => line.length > 0);
    const last = JSON.parse(lines.at(-1) ?? '[]') as unknown[];
    expect(last[1]).toBe('m');
    expect(last[2]).toBe('cauce:recording_capped');
    expect(lines.filter((line) => line.includes('still typing'))).toHaveLength(0);
  });

  it('publishes a bounded default cap so an unset limit cannot fill the volume', () => {
    expect(DEFAULT_RECORDING_MAX_BYTES).toBe(32 * 1024 * 1024);
  });
});
