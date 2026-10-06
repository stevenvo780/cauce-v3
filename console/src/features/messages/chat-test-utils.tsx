import { act, screen } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import { ApiProvider } from '../../api/context';
import { navigate } from '../../router';
import { FleetProvider } from '../../shell/fleet';
import { renderRouted, testApi } from '../../test/render';
import { MessagesPage } from './MessagesPage';

type User = ReturnType<typeof userEvent.setup>;

const TENANT: Record<string, string> = { argos: 'Steven', socrates: 'Steven', gaia: 'Steven', kratos: 'Miguel', salva: 'Isa', hegel: 'Jhon' };

/** The chat as the shell mounts it: fed by the shared fleet poller and the router. */
export function renderChat(path?: string) {
  if (path) window.history.pushState({}, '', path);
  return renderRouted(MessagesPage, {
    wrapper: ({ children }) => <ApiProvider api={testApi}><FleetProvider>{children}</FleetProvider></ApiProvider>,
  });
}

export async function openConversation(alias: string) {
  act(() => { navigate(`/messages/${TENANT[alias] ?? 'Steven'}/${alias}`); });
  return screen.findByRole('region', { name: new RegExp(`conversación con ${alias}`, 'i') });
}

export async function openConversationMenu(user: User) {
  await user.click(screen.getByRole('button', { name: 'Opciones de la conversación' }));
  return screen.findByRole('menu');
}

export async function openConversationInfo(user: User) {
  await openConversationMenu(user);
  await user.click(await screen.findByRole('menuitem', { name: /Detalles de la conversación/ }));
  return screen.findByRole('dialog', { name: 'Detalles de la conversación' });
}

export function thread(region: HTMLElement): HTMLElement {
  const log = region.querySelector<HTMLElement>('[role="log"]');
  if (!log) throw new Error('el hilo no tiene historial');
  return log;
}

export function messageRows(region: HTMLElement): HTMLElement[] {
  return [...region.querySelectorAll<HTMLElement>('article[data-message-id]')];
}

export async function openMessageDetail(user: User, region: HTMLElement, content: string) {
  const row = messageRows(region).find((element) => element.textContent.includes(content));
  if (!row) throw new Error(`No se encontró el mensaje: ${content}`);
  await user.click(row.querySelector<HTMLElement>('button[aria-label="Opciones del mensaje"]') ?? row);
  await user.click(await screen.findByRole('menuitem', { name: 'Ver detalle' }));
  return screen.findByRole('group', { name: /detalle del mensaje seleccionado/i });
}
