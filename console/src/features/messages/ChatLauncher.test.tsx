import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import type { MessagePage, MessageView } from '../../api/types';
import { AgentPreferencesContext, type AgentPreferencesValue } from '../../components/agent-actions/preferences-context';
import { FleetContext, type FleetData } from '../../shell/fleet-context';
import type { LiveAgentView, LiveState } from '../live/agent-state';
import { ChatLauncher } from './ChatLauncher';
import { lastMessages, launcherSections, nextCardIndex } from './chat-launcher-model';
import type { SaludDeCola } from './queue-health';
import type { AgenteDeMensajeria } from './roster';

const NOW = Date.parse('2026-10-06T12:00:00Z');

function agent(tenantId: string, alias: string): AgenteDeMensajeria {
  return {
    id: `${tenantId}:${alias}`, tenantId, alias, roomIds: ['room'], roomMembership: {},
    leaseState: 'online', origenes: ['topologia'], mensajesVisibles: 0,
  };
}

function message(tenant: string, from: string | null, to: [string, string], preview: string, secondsAgo: number): MessageView {
  return {
    message_id: `${from ?? 'human'}-${preview}`, tenant_id: tenant, actor_alias: from, body_preview: preview,
    created_at: new Date(NOW - secondsAgo * 1000).toISOString(),
    deliveries: [{ recipient_tenant: to[0], recipient_alias: to[1], status: 'done' }],
  };
}

const AGENTS = [
  agent('Steven', 'argos'), agent('Steven', 'kant'), agent('Miguel', 'kratos'),
  agent('Pablo', 'midas'), agent('Isa', 'salva'), agent('Jhon', 'hegel'),
];
const PAGE: MessagePage = {
  items: [
    message('Steven', 'kant', ['Steven', 'argos'], 'Verificar adapter', 300),
    message('Steven', 'socrates', ['Isa', 'salva'], 'Revisar cuotas', 30),
  ],
};
const STATES: Record<string, LiveState> = { 'Pablo:midas': 'down', 'Jhon:hegel': 'thinking' };
const SALUD: Record<string, SaludDeCola> = { 'Miguel:kratos': { muertas: 2, muertasTruncadas: false } };

function resource(data?: unknown) {
  return { data, loading: false, reload: () => Promise.resolve({ ok: true as const, data }) } as unknown as FleetData['messages'];
}

function fleet(overrides: Partial<FleetData> = {}): FleetData {
  const live = new Map(Object.entries(STATES).map(([id, state]) => [id, { state, reason: `motivo ${state}` } as LiveAgentView]));
  return {
    agents: AGENTS, salud: SALUD, live,
    status: resource(), topology: resource(), messages: resource(PAGE), activity: resource(), queues: resource(),
    activityIntervalMs: 0, setActivityIntervalMs: () => undefined, loading: false, reload: () => undefined,
    ...overrides,
  } as FleetData;
}

function preferences(favorites: string[]): AgentPreferencesValue {
  const noop = () => undefined;
  return {
    status: 'ready', favorites: new Set(favorites), appearances: new Map(), pending: new Set(), toggleFavorite: noop,
    saveAppearance: () => Promise.reject(new Error('no')), resetAppearance: () => Promise.resolve(),
    reload: () => Promise.resolve(), customize: noop, notify: noop,
  };
}

function renderLauncher({ phone = false, data = fleet(), favorites }: { phone?: boolean; data?: FleetData; favorites?: string[] } = {}) {
  const wrap = (node: ReactNode) => favorites
    ? <AgentPreferencesContext.Provider value={preferences(favorites)}>{node}</AgentPreferencesContext.Provider>
    : node;
  return render(<FleetContext.Provider value={data}>{wrap(<ChatLauncher phone={phone} />)}</FleetContext.Provider>);
}

function section(name: string): HTMLElement {
  return screen.getByRole('list', { name });
}

function aliases(list: HTMLElement): string[] {
  return within(list).getAllByRole('link').map((link) => (link.getAttribute('aria-label') ?? '').split(',')[0]);
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  window.history.pushState({}, '', '/messages');
});

afterEach(() => {
  window.history.pushState({}, '', '/');
});

it('groups every agent once: recent conversations, then attention, then the rest', () => {
  renderLauncher();
  expect(aliases(section('Recientes'))).toEqual(['salva', 'argos', 'kant']);
  expect(aliases(section('Necesitan atención'))).toEqual(['kratos', 'midas']);
  expect(aliases(section('Todos'))).toEqual(['hegel']);
  expect(screen.queryByRole('list', { name: 'Favoritos' })).toBeNull();
  const argos = within(section('Recientes')).getByRole('link', { name: /^argos\b/ });
  expect(argos).toHaveAttribute('href', '/messages/Steven/argos');
  expect(argos).toHaveTextContent('kant: Verificar adapter');
  expect(argos).toHaveTextContent('hace 5 min');
  expect(within(section('Necesitan atención')).getByRole('link', { name: /^kratos\b/ })).toHaveTextContent('2 muertas');
  expect(within(section('Necesitan atención')).getByRole('link', { name: /^midas\b/ })).toHaveTextContent('motivo down');
});

it('puts the favorites of the human first', () => {
  renderLauncher({ favorites: ['Jhon/hegel', 'Steven/kant'] });
  expect(aliases(section('Favoritos'))).toEqual(['kant', 'hegel']);
  expect(aliases(section('Recientes'))).toEqual(['salva', 'argos']);
});

it('filters by alias or tenant, ranks prefixes first and says when nothing matches', async () => {
  const user = userEvent.setup();
  renderLauncher();
  const search = screen.getByRole('searchbox', { name: 'Buscar un agente para chatear' });
  expect(search).toHaveFocus();

  await user.type(search, 'k');
  expect(aliases(section('Resultados'))).toEqual(['kant', 'kratos']);
  expect(within(section('Resultados')).getAllByRole('link')[0]).toHaveAttribute('data-highlighted', 'true');

  await user.clear(search);
  await user.type(search, 'miguel');
  expect(aliases(section('Resultados'))).toEqual(['kratos']);

  await user.type(search, 'zzz');
  expect(screen.getByText(/Ningún agente coincide con/)).toHaveTextContent('miguelzzz');

  await user.keyboard('{Escape}');
  expect(search).toHaveValue('');
  expect(section('Recientes')).toBeInTheDocument();
});

it('moves the highlight with the arrows and opens the chat with Enter', async () => {
  const user = userEvent.setup();
  renderLauncher();
  await user.keyboard('{ArrowDown}');
  expect(within(section('Recientes')).getByRole('link', { name: /^salva\b/ })).toHaveAttribute('data-highlighted', 'true');
  await user.keyboard('{ArrowRight}{ArrowDown}');
  expect(within(section('Recientes')).getByRole('link', { name: /^kant\b/ })).toHaveAttribute('data-highlighted', 'true');
  await user.keyboard('{Enter}');
  expect(window.location.pathname).toBe('/messages/Steven/kant');
});

it('Enter on a search opens the best match', async () => {
  const user = userEvent.setup();
  renderLauncher();
  await user.type(screen.getByRole('searchbox'), 'kra{Enter}');
  expect(window.location.pathname).toBe('/messages/Miguel/kratos');
});

it('"/" focuses the search from anywhere but a text field', async () => {
  const user = userEvent.setup();
  renderLauncher({ phone: true });
  const search = screen.getByRole('searchbox');
  expect(search).not.toHaveFocus();
  await user.keyboard('/');
  expect(search).toHaveFocus();
  expect(search).toHaveValue('');
});

it('on the phone it is the roster of chats, without stealing the keyboard', () => {
  renderLauncher({ phone: true });
  expect(screen.getByRole('heading', { level: 1, name: 'Chats' })).toBeInTheDocument();
  expect(within(screen.getByRole('list', { name: 'Agentes' })).getByRole('link', { name: /^argos\b/ })).toBeInTheDocument();
  expect(screen.getByRole('searchbox')).not.toHaveFocus();
});

it('a plain click opens the chat; a modified click is left to the browser', async () => {
  const user = userEvent.setup();
  const stopNavigation = (event: Event) => { event.preventDefault(); };
  document.addEventListener('click', stopNavigation);
  onTestFinished(() => { document.removeEventListener('click', stopNavigation); });
  renderLauncher();
  const kant = within(section('Recientes')).getByRole('link', { name: /^kant\b/ });
  await user.keyboard('{Control>}');
  await user.click(kant);
  await user.keyboard('{/Control}');
  expect(window.location.pathname).toBe('/messages');
  await user.click(kant);
  expect(window.location.pathname).toBe('/messages/Steven/kant');
});

it('shows skeletons while loading and the error with a retry when the fleet cannot be read', async () => {
  const reload = vi.fn();
  const { rerender } = renderLauncher({ data: fleet({ agents: [], loading: true }) });
  expect(screen.getByText('Cargando agentes…')).toHaveAttribute('role', 'status');

  rerender(<FleetContext.Provider value={fleet({ agents: [], error: new Error('sin red'), reload })}><ChatLauncher phone={false} /></FleetContext.Provider>);
  expect(screen.getByRole('alert')).toHaveTextContent('sin red');
  await userEvent.setup().click(screen.getByRole('button', { name: /Reintentar/ }));
  expect(reload).toHaveBeenCalled();

  rerender(<FleetContext.Provider value={fleet({ agents: [] })}><ChatLauncher phone={false} /></FleetContext.Provider>);
  expect(screen.getByText('Todavía no hay agentes en la flota.')).toBeInTheDocument();
});

it('names the clicked orb so the view transition can morph it into the chat header', async () => {
  const transition = vi.fn((update: () => void) => { update(); });
  Object.defineProperty(document, 'startViewTransition', { configurable: true, value: transition });
  try {
    renderLauncher();
    const kant = within(section('Recientes')).getByRole('link', { name: /^kant\b/ });
    await userEvent.setup().click(kant);
    expect(kant.querySelector<HTMLElement>('.agent-orb')?.style.getPropertyValue('view-transition-name')).toBe('chat-orb');
    expect(document.documentElement).toHaveAttribute('data-chat-launch');
    expect(transition).toHaveBeenCalledTimes(1);
  } finally {
    act(() => { Reflect.deleteProperty(document, 'startViewTransition'); });
    delete document.documentElement.dataset.chatLaunch;
  }
});

it('model: last message per agent, from either side of the delivery', () => {
  const last = lastMessages(PAGE, AGENTS);
  expect(last.get('Steven:kant')).toMatchObject({ text: 'Verificar adapter', from: undefined });
  expect(last.get('Steven:argos')).toMatchObject({ text: 'Verificar adapter', from: 'kant' });
  expect(last.has('Miguel:kratos')).toBe(false);
  const sections = launcherSections({ agents: AGENTS, stateOf: () => 'idle', salud: {}, last, query: 'steven' });
  expect(sections.map((entry) => entry.id)).toEqual(['resultados']);
  expect(sections[0].agents.map((entry) => entry.alias)).toEqual(['argos', 'kant']);
});

it('model: arrows follow the layout and fall back to reading order without geometry', () => {
  const box = (left: number, top: number) => ({ left, top, width: 100, height: 80 });
  const grid = [box(0, 0), box(110, 0), box(220, 0), box(0, 200), box(110, 200)];
  expect(nextCardIndex(grid, 2, 'ArrowDown')).toBe(4);
  expect(nextCardIndex(grid, 3, 'ArrowUp')).toBe(0);
  expect(nextCardIndex(grid, 4, 'ArrowDown')).toBe(4);
  expect(nextCardIndex(grid, -1, 'ArrowDown')).toBe(0);
  const flat = [box(0, 0), box(0, 0), box(0, 0)].map((entry) => ({ ...entry, width: 0, height: 0 }));
  expect(nextCardIndex(flat, 0, 'ArrowDown')).toBe(1);
  expect(nextCardIndex(flat, 0, 'ArrowUp')).toBe(0);
});
