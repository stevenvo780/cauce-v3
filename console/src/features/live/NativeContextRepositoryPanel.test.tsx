import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { NativeContextRepositoryPanel } from './NativeContextRepositoryPanel';
import type { NativeContextRepositoryInspection } from '../../api/client/native-context-repository-client';
import type { ConsoleAuthState } from '../../api/types';

const mock = vi.hoisted(() => ({ inspect: vi.fn(), subscribe: vi.fn() }));
vi.mock('../../api/context', () => ({ useApi: () => api }));
let api = { inspectNativeContextRepository: mock.inspect, onAuthSession: mock.subscribe };
const COMMIT = 'a'.repeat(40);
const PREVIOUS = 'b'.repeat(40);
const props = { tenantId: 'Steven', alias: 'helper', instanceId: 'fixture', commit: COMMIT, previous: '' };
const content = '<script>alert("x")</script> ![image](https://example.test/image) @import other.md';
function result(): NativeContextRepositoryInspection {
  const file = { path: 'tenants/Steven/agents/helper/native/codex/AGENTS.md', bytes: content.length, content, sha256: 'c'.repeat(64) };
  return { desired: { scope: { tenant_id: 'Steven', alias: 'helper', instance_id: 'fixture' }, commit: COMMIT, tree: 'd'.repeat(40),
    profile: { purpose: null, role_summary: null, human_brief: null, responsibilities: [], restrictions: [], tools: [], operating_rules: [] },
    profileSource: { ...file, path: 'tenants/Steven/agents/helper/profile.json' }, manualSource: file,
    sourceAgent: { tenant_id: 'Steven', alias: 'helper', source_journal: null, native_manual: { harness: 'codex' } } },
  previous: null, changes: null, sourceState: 'not_observed', application: 'not_evaluated', applySupported: false };
}
let listener: ((state: ConsoleAuthState) => void) | undefined;
beforeEach(() => {
  api = { inspectNativeContextRepository: mock.inspect, onAuthSession: mock.subscribe };
  mock.inspect.mockReset().mockResolvedValue(result());
  mock.subscribe.mockImplementation((fn: typeof listener) => { listener = fn; return () => { listener = undefined; }; });
});
async function open() { await userEvent.click(screen.getByText('Manual nativo de Git · sólo inspección')); }
async function inspect() { await userEvent.click(screen.getByRole('button', { name: 'Inspeccionar manual' })); }
it('stays compact, reads on demand and displays source text without active markup', async () => {
  const view = render(<NativeContextRepositoryPanel {...props} />);
  expect(mock.inspect).not.toHaveBeenCalled();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  await open(); expect(mock.inspect).not.toHaveBeenCalled();
  await inspect();
  expect(await screen.findByText(content)).toBeInTheDocument();
  expect(screen.getByText(/runtime y adopción de sesión no comprobados/)).toBeInTheDocument();
  expect(view.container.querySelector('script,img,a')).toBeNull();
  expect(screen.queryByRole('button', { name: /aplicar|guardar/i })).not.toBeInTheDocument();
  expect(mock.inspect).toHaveBeenCalledWith('Steven', 'helper', 'fixture', COMMIT, undefined);
});
it('shows bounded errors and retries without keeping old results', async () => {
  mock.inspect.mockRejectedValueOnce(new Error('private backend detail'));
  render(<NativeContextRepositoryPanel {...props} />); await open(); await inspect();
  expect(await screen.findByRole('alert')).not.toHaveTextContent('private backend detail');
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar manual' }));
  expect(await screen.findByText(content)).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it.each(['tenantId', 'alias', 'instanceId', 'commit', 'previous'] as const)('discards late responses when %s changes', async (field) => {
  let release: ((value: NativeContextRepositoryInspection) => void) | undefined;
  mock.inspect.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const view = render(<NativeContextRepositoryPanel {...props} />); await open(); await inspect();
  expect(screen.getByRole('status')).toBeInTheDocument();
  view.rerender(<NativeContextRepositoryPanel {...props} {...{ [field]: field === 'commit' || field === 'previous' ? PREVIOUS : 'other' }} />);
  await act(async () => { release?.(result()); });
  expect(screen.queryByText(content)).not.toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
it('discards pending reads on close and does not restore them after reopening', async () => {
  let release: ((value: NativeContextRepositoryInspection) => void) | undefined;
  mock.inspect.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  render(<NativeContextRepositoryPanel {...props} />); await open(); await inspect(); await open();
  await waitFor(() => { expect(screen.queryByRole('button')).not.toBeInTheDocument(); });
  await act(async () => { release?.(result()); }); await open();
  expect(screen.queryByText(content)).not.toBeInTheDocument();
});
it('invalidates current and pending results on account notification', async () => {
  render(<NativeContextRepositoryPanel {...props} />); await open(); await inspect();
  expect(await screen.findByText(content)).toBeInTheDocument();
  act(() => { listener?.({ authenticated: false }); });
  expect(screen.queryByText(content)).not.toBeInTheDocument();
  let release: ((value: NativeContextRepositoryInspection) => void) | undefined;
  mock.inspect.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })); await inspect();
  act(() => { listener?.({ authenticated: true, subject: 'new-account' }); });
  await act(async () => { release?.(result()); });
  expect(screen.queryByText(content)).not.toBeInTheDocument();
});
it('uses explicit comparison and renders removed and added sources separately', async () => {
  const data = result(); const before = { ...data.desired.manualSource, path: 'tenants/Steven/agents/helper/native/claude/CLAUDE.md', content: 'old manual' };
  const previous = { ...data.desired, commit: PREVIOUS, manualSource: before,
    sourceAgent: { ...data.desired.sourceAgent, native_manual: { harness: 'claude' as const } } };
  const changes: NativeContextRepositoryInspection['changes'] = [{ path: before.path, kind: 'removed', before, after: null },
    { path: data.desired.manualSource.path, kind: 'added', before: null, after: data.desired.manualSource }];
  mock.inspect.mockResolvedValue({ ...data, previous, changes });
  render(<NativeContextRepositoryPanel {...props} previous={PREVIOUS} />); await open(); await inspect();
  expect(await screen.findByText(/Fuente retirada:/)).toBeInTheDocument();
  expect(screen.getByText(/Fuente añadida:/)).toBeInTheDocument();
  expect(mock.inspect).toHaveBeenCalledWith('Steven', 'helper', 'fixture', COMMIT, PREVIOUS);
  await userEvent.click(screen.getByText(/Fuente retirada:/));
  await userEvent.click(screen.getByText(/Fuente retirada:/));
  expect(screen.getByRole('region', { name: 'Inspección de manual nativo' })).toBeInTheDocument();
});
it('does not send abbreviated commits or repeat pending requests', async () => {
  const view = render(<NativeContextRepositoryPanel {...props} commit="abcd" />); await open();
  expect(screen.getByRole('button')).toBeDisabled();
  view.rerender(<NativeContextRepositoryPanel {...props} />);
  mock.inspect.mockReturnValue(new Promise(() => undefined));
  const button = screen.getByRole('button'); fireEvent.click(button); fireEvent.click(button);
  expect(mock.inspect).toHaveBeenCalledTimes(1);
});

it('hides results immediately when the API provider changes', async () => {
  const view = render(<NativeContextRepositoryPanel {...props} />); await open(); await inspect();
  expect(await screen.findByText(content)).toBeInTheDocument();
  api = { ...api };
  view.rerender(<NativeContextRepositoryPanel {...props} />);
  expect(screen.queryByText(content)).not.toBeInTheDocument();
});

it('keeps an empty previous commit absent and labels an empty manual explicitly', async () => {
  const data = result();
  mock.inspect.mockResolvedValue({ ...data, desired: { ...data.desired,
    manualSource: { ...data.desired.manualSource, content: '', bytes: 0 } } });
  render(<NativeContextRepositoryPanel {...props} previous="" />); await open();
  expect(screen.getByRole('button', { name: 'Inspeccionar manual' })).toBeEnabled();
  await inspect();
  expect(await screen.findByText('Archivo vacío')).toBeInTheDocument();
  expect(mock.inspect).toHaveBeenCalledWith('Steven', 'helper', 'fixture', COMMIT, undefined);
});
