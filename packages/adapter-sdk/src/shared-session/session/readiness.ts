import { readFile } from 'node:fs/promises';
import { signalAborted } from '../../runtime-state.js';
import { assertCommandPins } from '../../sdk/command-pins.js';
import { inputBoxState } from '../pane.js';
import { capturePane, inspectSolePaneHarness, panePid, samePaneIdentity, sessionIdStillNamed, sessionOption,
  type PaneHarnessIdentity, type TmuxController } from '../tmux.js';
import { sessionName, TUI_WINDOW } from '../types.js';
import type { EnsureOptions } from '../session.js';
import { SESSION_ALIAS_OPTION, SESSION_HARNESS_OPTION,
  type SharedSessionSpec } from './identity.js';

const DEFAULT_READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 1_000;
type TuiReadiness = 'ready' | 'gone' | 'timeout' | 'cancelled' | 'changed';

async function processStarttime(pid: string): Promise<string | undefined> {
  if (!/^[1-9][0-9]*$/u.test(pid)) return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/u);
    const starttime = fields[19];
    return fields[0] !== 'Z' && fields[0] !== 'X' && starttime !== undefined
      && /^[0-9]+$/u.test(starttime) ? starttime : undefined;
  } catch { return undefined; }
}

export async function waitForAccreditedTui(
  tmux: TmuxController, spec: SharedSessionSpec, pane: PaneHarnessIdentity, options: EnsureOptions,
): Promise<Exclude<TuiReadiness, 'timeout'>> {
  if (signalAborted(options.signal)) return 'cancelled';
  const starttime = await processStarttime(pane.panePid);
  if (signalAborted(options.signal)) return 'cancelled';
  if (starttime === undefined) return 'gone';
  const identityCurrent = async (): Promise<boolean> => {
    if (signalAborted(options.signal)) return false;
    if (!await sessionIdStillNamed(tmux, sessionName(spec.alias), pane.sessionId)) return false;
    const alias = await sessionOption(tmux, pane.sessionId, SESSION_ALIAS_OPTION);
    const harness = await sessionOption(tmux, pane.sessionId, SESSION_HARNESS_OPTION);
    if (!alias.ok || alias.value !== spec.alias || !harness.ok || harness.value !== spec.harness) return false;
    const identity = await inspectSolePaneHarness(tmux, pane.sessionId, TUI_WINDOW);
    return identity.state === 'present' && samePaneIdentity(pane, identity.pane)
      && pane.paneStartCommand === identity.pane.paneStartCommand
      && await sessionIdStillNamed(tmux, sessionName(spec.alias), pane.sessionId)
      && await processStarttime(pane.panePid) === starttime;
  };
  for (;;) {
    if (signalAborted(options.signal)) return 'cancelled';
    await assertCommandPins(spec.command ?? spec.harness, spec.commandPins);
    const result = await waitForTui(tmux, pane.paneId, options, identityCurrent);
    if (result === 'ready') {
      await assertCommandPins(spec.command ?? spec.harness, spec.commandPins);
      if (signalAborted(options.signal)) return 'cancelled';
      if (!await identityCurrent()) return signalAborted(options.signal) ? 'cancelled' : 'changed';
    }
    if (result !== 'timeout') return result;
    options.log?.('tui_starting');
  }
}

export async function waitForTui(
  tmux: TmuxController, target: string, options: EnsureOptions,
  identityCurrent?: () => Promise<boolean>,
): Promise<TuiReadiness> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  for (;;) {
    if (signalAborted(options.signal)) return 'cancelled';
    if (identityCurrent !== undefined && !await identityCurrent()) {
      return signalAborted(options.signal) ? 'cancelled' : 'changed';
    }
    const pane = await capturePane(tmux, target, { styled: true });
    if (signalAborted(options.signal)) return 'cancelled';
    if (identityCurrent !== undefined && !await identityCurrent()) {
      return signalAborted(options.signal) ? 'cancelled' : 'changed';
    }
    const input = inputBoxState(pane);
    if (!input.occupied || input.unfocused === true) return 'ready';
    if (await panePid(tmux, target) === undefined) return 'gone';
    if (signalAborted(options.signal)) return 'cancelled';
    if (now() >= deadline) return 'timeout';
    await options.sleep(READY_POLL_MS);
    if (signalAborted(options.signal)) return 'cancelled';
  }
}
