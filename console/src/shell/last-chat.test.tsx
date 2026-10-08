import { act, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TerminalRelayProvider } from '../features/terminal/relay-status';
import { navigate } from '../router';
import { renderWithApi } from '../test/render';
import { AppShell } from './AppShell';
import { FleetProvider } from './fleet';
import {
  CHAT_LAUNCHER_PATH, chatNavTarget, lastChatPath, rememberChat, subscribeLastChat, useChatNavTarget, useLastChat,
} from './last-chat';

function mockPhone(phone: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: phone && (query.includes('760px') || query.includes('1100px')),
    media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  }));
}

function renderShell() {
  return renderWithApi(
    <TerminalRelayProvider>
      <FleetProvider>
        <AppShell routeId="messages" account={<button type="button">Cuenta</button>}><main>contenido</main></AppShell>
      </FleetProvider>
    </TerminalRelayProvider>,
  );
}

function chatLink(): HTMLElement {
  return within(screen.getByRole('navigation', { name: 'Navegación principal' })).getByRole('link', { name: 'Chat' });
}

beforeEach(() => {
  window.history.pushState({}, '', '/messages');
});

afterEach(() => {
  rememberChat(undefined);
  window.history.pushState({}, '', '/');
});

it('keeps the last chat in memory and tells its subscribers once per change', () => {
  const listener = vi.fn();
  const unsubscribe = subscribeLastChat(listener);
  expect(lastChatPath()).toBeUndefined();
  rememberChat('/messages/Steven/kant');
  rememberChat('/messages/Steven/kant');
  expect(lastChatPath()).toBe('/messages/Steven/kant');
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
  rememberChat('/messages/Miguel/kratos');
  expect(listener).toHaveBeenCalledTimes(1);
  expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
});

it('the Chat entry resumes the last chat, and from inside it goes to the launcher', () => {
  expect(chatNavTarget(undefined, '/live')).toBe(CHAT_LAUNCHER_PATH);
  expect(chatNavTarget('/messages/Steven/kant', '/live')).toBe('/messages/Steven/kant');
  expect(chatNavTarget('/messages/Steven/kant', '/messages')).toBe('/messages/Steven/kant');
  expect(chatNavTarget('/messages/Steven/kant', '/messages/Steven/kant')).toBe(CHAT_LAUNCHER_PATH);
});

it('the hooks follow both the store and the address bar', () => {
  const { result } = renderHook(() => ({ last: useLastChat(), target: useChatNavTarget() }));
  expect(result.current).toEqual({ last: undefined, target: '/messages' });
  act(() => { rememberChat('/messages/Isa/s%C3%A1lva'); });
  expect(result.current.target).toBe('/messages/Isa/s%C3%A1lva');
  act(() => { navigate('/messages/Isa/s%C3%A1lva'); });
  expect(result.current.target).toBe('/messages');
});

it.each([false, true])('the sidebar and the phone bar point Chat at the remembered conversation (phone: %s)', async (phone) => {
  mockPhone(phone);
  renderShell();
  expect(chatLink()).toHaveAttribute('href', '/messages');
  act(() => { rememberChat('/messages/Steven/argos'); });
  expect(chatLink()).toHaveAttribute('href', '/messages/Steven/argos');

  await userEvent.setup().click(chatLink());
  expect(window.location.pathname).toBe('/messages/Steven/argos');
  expect(chatLink()).toHaveAttribute('href', '/messages');
  await userEvent.setup().click(chatLink());
  expect(window.location.pathname).toBe('/messages');
});
