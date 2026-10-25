import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'vitest';
import { ProcessExecutionError } from '../../packages/adapter-sdk/src/sdk/errors.js';
import { turnInFlight } from '../../packages/adapter-sdk/src/shared-session/pane.js';
import { paneIdentity, samePaneProcess } from '../../packages/adapter-sdk/src/shared-session/tmux.js';
import {
  CORRELATION_MS, SILENT_WORK_MS, receipt, startControlledTui, waitForState,
} from './v4-shared-tui-timeouts.helpers.js';

async function timeoutError(operation: Promise<unknown>): Promise<ProcessExecutionError> {
  try { await operation; } catch (error) {
    assert.ok(error instanceof ProcessExecutionError);
    assert.equal(error.code, 'EXECUTION_TIMEOUT_AMBIGUOUS');
    assert.equal(error.retryable, false);
    return error;
  }
  return assert.fail('The stalled real TUI must exhaust its configured deadline');
}

describe('shared TUI deadlines through real tmux', () => {
  test('a correlated terminal API error fails promptly without exposing provider text', async () => {
    const fixture = await startControlledTui('api-error');
    try {
      const running = fixture.execute(7_000).catch((error: unknown) => error);
      const submitted = await waitForState(fixture, state => state.submits === 1);
      const error: unknown = await running;
      const elapsedMs = Date.now() - submitted.submittedAt;
      assert.ok(error instanceof ProcessExecutionError);
      assert.equal(error.code, 'PROCESS_EXIT_AMBIGUOUS');
      assert.equal(error.retryable, false);
      assert.match(error.message, /terminal API error/u);
      assert.doesNotMatch(error.message, /PRIVATE_PROVIDER_ERROR/u);
      assert.ok(elapsedMs < 2_000, error.message);
      assert.equal(turnInFlight(await fixture.pane()), false);
      await receipt('terminal-api-error', { result: 'PASS', elapsedMs, noProgressMs: 7_000,
        error: error.message, retryable: error.retryable, submits: (await fixture.state()).submits });
    } finally { await fixture.cleanup(); }
  });

  test('a correlated silent tool turn survives an idle-looking pane beyond the quiet cutoff', async () => {
    const fixture = await startControlledTui('idle-live');
    try {
      const running = fixture.execute(7_000);
      void running.catch(() => undefined);
      const submitted = await waitForState(fixture, state => state.submits === 1);
      await delay(Math.max(0, submitted.submittedAt + CORRELATION_MS + 350 - Date.now()));
      const idlePane = await fixture.pane();
      assert.equal(turnInFlight(idlePane), false);
      assert.equal((await readFile(fixture.transcript, 'utf8')).trim().split('\n').length, 1);
      const output = await running;
      const completed = await waitForState(fixture, state => state.finishedAt !== undefined);
      const elapsedMs = (completed.finishedAt ?? 0) - submitted.submittedAt;
      assert.equal(output.reply, 'silent turn completed');
      assert.ok(elapsedMs >= SILENT_WORK_MS - 50);
      assert.equal(completed.submits, 1);
      await receipt('correlated-idle-alive', { result: 'PASS', elapsedMs, noProgressMs: 7_000,
        transcriptEntriesAtQuietCutoff: 1, idlePane, submits: completed.submits });
    } finally { await fixture.cleanup(); }
  });

  test('a silent uncorrelated turn survives the correlation cutoff while its pane is generating', async () => {
    const fixture = await startControlledTui('silent');
    try {
      const running = fixture.execute(7_000);
      void running.catch(() => undefined);
      const submitted = await waitForState(fixture, state => state.submits === 1);
      await delay(Math.max(0, submitted.submittedAt + CORRELATION_MS + 350 - Date.now()));
      const generatingPane = await fixture.pane();
      assert.equal(turnInFlight(generatingPane), true);
      assert.equal(await readFile(fixture.transcript, 'utf8'), '',
        'No transcript progress or correlated user entry may keep this turn alive');
      const output = await running;
      const completed = await waitForState(fixture, state => state.finishedAt !== undefined);
      const elapsedMs = (completed.finishedAt ?? 0) - submitted.submittedAt;
      assert.match(output.reply ?? '', /turn_merged[\s\S]*silent turn completed$/u);
      assert.ok(elapsedMs >= SILENT_WORK_MS - 50);
      assert.equal(completed.submits, 1);
      await receipt('silent-alive', { result: 'PASS', elapsedMs, noProgressMs: 7_000,
        transcriptAtCorrelationCutoff: 'empty', generatingPane, submits: completed.submits });
    } finally { await fixture.cleanup(); }
  });

  test('an idle lost paste times out at the real correlation deadline and reports that deadline', async () => {
    const fixture = await startControlledTui('lost');
    try {
      const running = timeoutError(fixture.execute(10_000));
      const submitted = await waitForState(fixture, state => state.submits === 1);
      const error = await running;
      const elapsedMs = Date.now() - submitted.submittedAt;
      assert.match(error.message, /correlat/iu);
      assert.match(error.message, /600 ms/u);
      assert.doesNotMatch(error.message, /180 min|earlier harness-specific/u);
      assert.ok(elapsedMs >= CORRELATION_MS - 50 && elapsedMs < 5_000, error.message);
      assert.equal(turnInFlight(await fixture.pane()), false);
      assert.equal(await readFile(fixture.transcript, 'utf8'), '');
      await receipt('lost-idle', { result: 'PASS', elapsedMs, noProgressMs: 10_000,
        error: error.message, pane: await fixture.pane() });
    } finally { await fixture.cleanup(); }
  });

  test('a repainting frozen spinner cannot restart the no-progress clock', async () => {
    const fixture = await startControlledTui('spinner');
    try {
      const noProgressMs = 1_400;
      const running = timeoutError(fixture.execute(noProgressMs));
      const submitted = await waitForState(fixture, state => state.submits === 1);
      const error = await running;
      const elapsedMs = Date.now() - submitted.submittedAt;
      const state = await waitForState(fixture, current => current.paints > 5);
      assert.equal(turnInFlight(await fixture.pane()), true);
      assert.equal(await readFile(fixture.transcript, 'utf8'), '');
      assert.match(error.message, /1400 ms/u);
      assert.ok(elapsedMs >= noProgressMs - 100 && elapsedMs < 6_000, error.message);
      const prevented = await fixture.execute(noProgressMs).catch((error: unknown) => error);
      assert.ok(prevented instanceof ProcessExecutionError);
      assert.equal(prevented.code, 'SHARED_TUI_UNAVAILABLE');
      assert.equal((await fixture.state()).submits, 1);
      await receipt('spinner-hung', { result: 'PASS', elapsedMs, noProgressMs, paints: state.paints,
        error: error.message, followupError: prevented.code, pane: await fixture.pane() });
    } finally { await fixture.cleanup(); }
  });

  test('a correlated turn with no further transcript progress also times out', async () => {
    const fixture = await startControlledTui('correlated-hang');
    try {
      const noProgressMs = 1_400;
      const running = timeoutError(fixture.execute(noProgressMs));
      const submitted = await waitForState(fixture, state => state.submits === 1);
      const error = await running;
      const elapsedMs = Date.now() - submitted.submittedAt;
      const entries = (await readFile(fixture.transcript, 'utf8')).trim().split('\n');
      assert.equal(entries.length, 1);
      assert.match(error.message, /1400 ms/u);
      assert.ok(elapsedMs >= noProgressMs - 100 && elapsedMs < 6_000, error.message);
      await receipt('correlated-hung', { result: 'PASS', elapsedMs, noProgressMs,
        transcriptEntries: entries.length, error: error.message, pane: await fixture.pane() });
    } finally { await fixture.cleanup(); }
  });

  test('a timed-out turn continues in the same pane and its late envelope is rescued before the next paste', async () => {
    const fixture = await startControlledTui('late');
    try {
      const error = await timeoutError(fixture.execute(900));
      assert.equal(turnInFlight(await fixture.pane()), true);
      const stillRunning = await paneIdentity(fixture.tmux, fixture.identity.paneId);
      assert.ok(stillRunning && samePaneProcess(stillRunning, fixture.identity));
      const blocked = await fixture.execute(900).catch((error: unknown) => error);
      assert.ok(blocked instanceof ProcessExecutionError);
      assert.equal(blocked.code, 'SHARED_TUI_UNAVAILABLE');
      assert.equal((await fixture.state()).submits, 1);
      await waitForState(fixture, state => state.finishedAt !== undefined);
      const next = await fixture.execute(3_000);
      assert.equal(next.reply, 'next turn completed');
      const rescuedFiles = await readdir(join(fixture.directory, 'resultados-tardios'));
      assert.equal(rescuedFiles.length, 1);
      const rescued = JSON.parse(await readFile(join(fixture.directory, 'resultados-tardios',
        rescuedFiles[0] ?? ''), 'utf8')) as { texto: string };
      assert.match(rescued.texto, /late turn completed/u);
      assert.equal((await fixture.state()).submits, 2);
      await receipt('late-rescue', { result: 'PASS', noProgressMs: 900, error: error.message,
        originalPaneStillRunningAfterTimeout: true, pasteBlockedWhileRunning: true,
        rescuedCount: rescuedFiles.length, nextReply: next.reply, submits: 2,
        noticeCount: fixture.notices.length });
    } finally { await fixture.cleanup(); }
  });
});
