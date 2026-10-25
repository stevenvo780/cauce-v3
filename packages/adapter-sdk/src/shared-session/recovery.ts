import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { assertCommandPins } from '../sdk/command-pins.js';
import { exactCodexLaunch } from './codex-resume.js';
import { paneWorkspaceState } from './exact-launch.js';
import { ensureSharedSession, type EnsureOptions, type SharedSessionSpec } from './session.js';
import { paneCommandMatches, SESSION_ALIAS_OPTION, SESSION_HARNESS_OPTION } from './session/identity.js';
import { exactSessionTarget, inspectSolePaneHarness, sessionOption, type PaneHarnessIdentity, type TmuxController } from './tmux.js';
import { atomicCas, mutateExactPane } from './tmux/mutation.js';
import { sessionName, TUI_WINDOW, type ResumeLaunchPlan } from './types.js';

export interface SessionRecoveryOutcome {
  readonly type: 'session';
  readonly state: 'present' | 'absent' | 'resumed' | 'recreated' | 'unsupported' | 'conflict' | 'failed';
  readonly resumable: boolean;
  readonly fingerprint: string | null;
  readonly reason: string;
}
export interface SessionRecoveryInput {
  readonly spec: SharedSessionSpec;
  readonly namespace: string;
  readonly stateDirectory: string;
  readonly configDirectory: string;
}
type Launch = Extract<ResumeLaunchPlan, { state: 'launch' }>;
interface Observation { readonly outcome: SessionRecoveryOutcome; readonly plan?: Launch; readonly pane?: PaneHarnessIdentity; readonly dead?: boolean }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reply = (state: SessionRecoveryOutcome['state'], reason: string, resumable = false, fingerprint: string | null = null): SessionRecoveryOutcome =>
  ({ type: 'session', state, resumable, fingerprint, reason });
const noTmuxServer = (code: number | null, stderr: string): boolean => code === 1 && /no server running|No such file or directory/u.test(stderr);

async function removedSession(tmux: TmuxController, pane: PaneHarnessIdentity): Promise<boolean> {
  const listed = await tmux.run(['list-sessions', '-F', '#{session_name}\t#{session_id}']);
  if (noTmuxServer(listed.exitCode, listed.stderr)) return true;
  return listed.exitCode === 0 && !listed.stdout.trim().split('\n').some(row => {
    const [name, id] = row.split('\t');
    return name === pane.sessionName || id === pane.sessionId;
  });
}

async function deadRecoveryPane(tmux: TmuxController, id: string, spec: SharedSessionSpec): Promise<PaneHarnessIdentity | undefined> {
  const fields = ['session_id', 'session_name', 'window_id', 'window_name', 'pane_id', 'pane_pid', 'pane_dead', 'pane_start_command'];
  const listed = await tmux.run(['list-panes', '-s', '-t', id, '-F', fields.map(field => `#{${field}}`).join('\t')]);
  if (listed.exitCode !== 0) return undefined;
  const rows = listed.stdout.trim().split('\n');
  if (rows.length !== 1) return undefined;
  const values = rows[0]?.split('\t');
  if (values?.length !== 8) return undefined;
  const [sessionId, name, windowId, windowName, paneId, panePid, dead, command] = values;
  if (sessionId !== id || name !== sessionName(spec.alias) || windowName !== TUI_WINDOW || dead !== '1'
    || windowId === undefined || !/^@[0-9]+$/u.test(windowId) || paneId === undefined || !/^%[0-9]+$/u.test(paneId)
    || panePid !== '' || !command) return undefined;
  const path = await tmux.run(['display-message', '-p', '-t', paneId, '#{pane_start_path}']);
  if (path.exitCode !== 0 || await realpath(path.stdout.trim()) !== await realpath(spec.workspace)) return undefined;
  // A dead pane has no PID; its mutation must require pane_dead=1 in the same server command.
  return { sessionId, sessionName: name, windowId, windowName, paneId, panePid: '0', paneStartCommand: command };
}

async function removeDeadPane(tmux: TmuxController, pane: PaneHarnessIdentity, spec: SharedSessionSpec): Promise<boolean> {
  const fields = { session_id: pane.sessionId, session_name: pane.sessionName, window_id: pane.windowId,
    window_name: pane.windowName, pane_id: pane.paneId, pane_dead: '1',
    [SESSION_ALIAS_OPTION]: spec.alias, [SESSION_HARNESS_OPTION]: spec.harness };
  const condition = Object.entries(fields).map(([key, value]) => `#{==:#{${key}},${value}}`)
    .reduce((left, right) => `#{&&:${left},${right}}`);
  const result = await atomicCas(tmux, pane.paneId, condition, `kill-pane -t ${pane.paneId}`);
  return result.branch === 'accepted' || await removedSession(tmux, pane);
}

async function exactLaunch(input: SessionRecoveryInput): Promise<ResumeLaunchPlan> {
  return input.spec.harness === 'codex' ? exactCodexLaunch({ ...input, workspace: input.spec.workspace })
    : input.spec.resume?.resolveLaunch?.() ?? { state: 'blocked', detail: 'No hay reanudación exacta disponible.' };
}

async function observeRecovery(tmux: TmuxController, input: SessionRecoveryInput): Promise<Observation> {
  const spec = input.spec;
  await assertCommandPins(spec.command ?? spec.harness, spec.commandPins);
  const plan = await exactLaunch(input);
  if (plan.state !== 'launch' || !plan.resumed) {
    return { outcome: reply('unsupported', 'No se acreditó una conversación exacta. Reiniciar podría perder el contexto; no se modificó la sesión.') };
  }
  const listed = await tmux.run(['list-sessions', '-F', '#{session_name}\t#{session_id}']);
  const noServer = noTmuxServer(listed.exitCode, listed.stderr);
  if (listed.exitCode !== 0 && !noServer) return { outcome: reply('failed', 'No se pudo consultar el servidor de terminales.') };
  const id = await exactSessionTarget(tmux, sessionName(spec.alias));
  let pane: PaneHarnessIdentity | undefined;
  let dead = false;
  if (id !== undefined) {
    const inspected = await inspectSolePaneHarness(tmux, id, TUI_WINDOW);
    pane = inspected.state === 'present' ? inspected.pane : await deadRecoveryPane(tmux, id, spec);
    dead = inspected.state !== 'present';
    const alias = await sessionOption(tmux, id, SESSION_ALIAS_OPTION);
    const harness = await sessionOption(tmux, id, SESSION_HARNESS_OPTION);
    const windows = await tmux.run(['list-windows', '-t', id, '-F', '#{window_id}']);
    if (pane === undefined || !alias.ok || alias.value !== spec.alias || !harness.ok || harness.value !== spec.harness
      || windows.exitCode !== 0 || windows.stdout.trim().split('\n').length !== 1
      || !paneCommandMatches(spec, pane.paneStartCommand)
      || (!dead && await paneWorkspaceState(tmux, pane, spec.workspace) !== 'match')) {
      return { outcome: reply('conflict', 'La terminal no acredita una única sesión del agente. Se conserva intacta.') };
    }
  } else if (listed.stdout.split('\n').some(row => row.split('\t')[0] === sessionName(spec.alias))) {
    return { outcome: reply('conflict', 'La sesión cambió durante la comprobación. Vuelve a verificar.') };
  }
  const fingerprint = digest({ alias: spec.alias, harness: spec.harness, workspace: spec.workspace,
    state: input.stateDirectory, namespace: input.namespace, config: input.configDirectory,
    command: spec.command ?? spec.harness, pins: spec.commandPins, arguments: spec.harnessArguments,
    environment: spec.environment, unset: spec.unsetEnvironment, pane: pane ?? null, dead, plan: plan.args });
  return { outcome: reply(pane === undefined || dead ? 'absent' : 'present', pane === undefined || dead
    ? 'La terminal falta y la conversación exacta puede reanudarse.'
    : 'La terminal existe. Reiniciarla requiere confirmación y reanudará la conversación acreditada.', true, fingerprint), plan,
    ...(pane === undefined ? {} : { pane, dead }) };
}

export async function previewSessionRecovery(tmux: TmuxController, input: SessionRecoveryInput): Promise<SessionRecoveryOutcome> {
  try { return (await observeRecovery(tmux, input)).outcome; }
  catch { return reply('failed', 'No se pudo acreditar una reanudación segura. No se modificó la sesión.'); }
}

export async function applySessionRecovery(tmux: TmuxController, input: SessionRecoveryInput,
  expectedFingerprint: string, force: boolean,
  options: EnsureOptions & { readonly recoveryExpiresAt?: number }): Promise<SessionRecoveryOutcome> {
  try {
    const expired = (): boolean => options.signal?.aborted === true
      || options.recoveryExpiresAt !== undefined && Date.now() >= options.recoveryExpiresAt;
    if (expired()) return reply('failed', 'La autorización venció antes de ejecutar la recuperación.');
    const current = await observeRecovery(tmux, input);
    if (!current.outcome.resumable || current.plan === undefined) return current.outcome;
    if (current.outcome.fingerprint !== expectedFingerprint) return reply('conflict', 'La sesión o la conversación cambió. Vuelve a verificar.');
    if (current.pane !== undefined && current.dead !== true && !force) return reply('conflict', 'La terminal existe. Confirma su reinicio antes de continuar.', true, expectedFingerprint);
    if (expired()) return reply('failed', 'La recuperación fue cancelada antes de modificar la sesión.');
    const freshPlan = await exactLaunch(input);
    if (freshPlan.state !== 'launch' || !freshPlan.resumed || digest(freshPlan.args) !== digest(current.plan.args)) {
      return reply('conflict', 'La conversación cambió antes de detener la terminal. Vuelve a verificar.');
    }
    if (current.pane !== undefined) {
      if (expired()) return reply('failed', 'La autorización venció antes de detener la terminal.');
      const markers = `#{&&:#{&&:#{==:#{${SESSION_ALIAS_OPTION}},${input.spec.alias}},#{==:#{${SESSION_HARNESS_OPTION}},${input.spec.harness}}},#{==:#{pane_dead},${current.dead === true ? '1' : '0'}}}`;
      const stopped = current.dead === true ? await removeDeadPane(tmux, current.pane, input.spec)
        : await mutateExactPane(tmux, current.pane, `kill-pane -t ${current.pane.paneId}`,
          undefined, 'full', markers, true) === 'applied';
      if (!stopped && !await removedSession(tmux, current.pane)) {
        return reply('conflict', 'La terminal cambió antes de detenerse. No se confirmó el reinicio.');
      }
    }
    const original = current.plan;
    const spec: SharedSessionSpec = { ...input.spec, resume: { resolveLaunch: async () => {
      const fresh = await exactLaunch(input);
      return fresh.state === 'launch' && fresh.resumed && digest(fresh.args) === digest(original.args)
        ? fresh : { state: 'blocked', detail: 'La conversación cambió antes de reanudar.' };
    } } };
    const { log: _log, ...ensureOptions } = options;
    if (expired()) return reply('failed', 'La autorización venció antes de reanudar la terminal.');
    const ensured = await ensureSharedSession(tmux, spec, ensureOptions);
    if (!ensured.ready || !ensured.created || ensured.resumed !== true) return reply('failed', 'La terminal no confirmó la reanudación exacta. No se intentó un arranque en blanco.');
    return reply(current.outcome.state === 'absent' ? 'recreated' : 'resumed', current.outcome.state === 'absent'
      ? 'Terminal recreada reanudando la conversación exacta.' : 'Agente reiniciado y conversación exacta reanudada.', true, expectedFingerprint);
  } catch { return reply('failed', 'No se confirmó la recuperación segura. Verifica la terminal antes de reintentar.'); }
}
