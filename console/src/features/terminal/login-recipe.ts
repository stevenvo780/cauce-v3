import type { TopologySnapshot } from '../../api/types';
import claude from '../../../../packages/adapter-sdk/descriptors/claude.json';
import codex from '../../../../packages/adapter-sdk/descriptors/codex.json';
import fake from '../../../../packages/adapter-sdk/descriptors/fake.json';
import fake2 from '../../../../packages/adapter-sdk/descriptors/fake2.json';
import grok from '../../../../packages/adapter-sdk/descriptors/grok.json';
import hermes from '../../../../packages/adapter-sdk/descriptors/hermes.json';
import muse from '../../../../packages/adapter-sdk/descriptors/muse.json';
import openclaw from '../../../../packages/adapter-sdk/descriptors/openclaw.json';
import opencode from '../../../../packages/adapter-sdk/descriptors/opencode.json';

/** The line is typed into a shell, so only the descriptor's own argv grammar is accepted. */
const ARGV0 = /^\/usr\/local\/bin\/[A-Za-z0-9][A-Za-z0-9._+@-]{0,127}$/u;
const ARGUMENT = /^(?:[A-Za-z0-9][A-Za-z0-9_@%+=:,./-]{0,255}|--[A-Za-z0-9][A-Za-z0-9_-]{0,253}|-[A-Za-z0-9_-]{1,254}|\/[A-Za-z0-9_@%+=:,./-]{0,255})$/u;

const SIN_ARNES = 'Este agente no declara arnés, así que no hay receta de login.';
const SIN_LOGIN = 'Este arnés no declara receta de login.';
const POR_FLOTA = 'Este arnés autentica con su módulo de flota y no declara un comando de login para la terminal.';
const SIN_COMPROBAR = 'Este arnés no declara comprobación de sesión (verify_argv).';

export type LoginAction = 'autenticar' | 'comprobar';

export interface HarnessLoginRecipe {
  readonly authenticate: readonly string[] | null;
  readonly verify: readonly string[] | null;
  readonly authenticateDisabledReason: string | null;
  readonly verifyDisabledReason: string | null;
}

interface DescriptorShape {
  readonly harness: string;
  readonly provider?: {
    readonly authenticate_argv?: readonly string[];
    readonly verify_argv?: readonly string[];
    readonly fleet_module?: string | null;
  };
}

const PUBLISHED: readonly DescriptorShape[] = [claude, codex, fake, fake2, grok, hermes, muse, openclaw, opencode];

function safeArgv(value: readonly string[] | undefined): readonly string[] | null {
  if (!value || value.length < 1 || value.length > 8) return null;
  for (const [index, item] of value.entries()) {
    if (index === 0 ? !ARGV0.test(item) : !ARGUMENT.test(item)) return null;
    if (item.split('/').includes('..')) return null;
  }
  return value;
}

function recipeFor(descriptor: DescriptorShape | undefined, harnessId: string): HarnessLoginRecipe {
  if (!descriptor) {
    const reason = `No hay un descriptor aprobado para el arnés ${harnessId}.`;
    return { authenticate: null, verify: null, authenticateDisabledReason: reason, verifyDisabledReason: reason };
  }
  const authenticate = safeArgv(descriptor.provider?.authenticate_argv);
  const verify = safeArgv(descriptor.provider?.verify_argv);
  const fleet = typeof descriptor.provider?.fleet_module === 'string' && descriptor.provider.fleet_module.length > 0;
  return {
    authenticate,
    verify,
    authenticateDisabledReason: authenticate ? null : fleet ? POR_FLOTA : SIN_LOGIN,
    verifyDisabledReason: verify ? null : SIN_COMPROBAR,
  };
}

const BY_HARNESS = new Map(PUBLISHED.map((descriptor) => [descriptor.harness, descriptor]));

export function harnessLoginRecipe(harnessId: string | null | undefined): HarnessLoginRecipe {
  if (!harnessId) {
    return { authenticate: null, verify: null, authenticateDisabledReason: SIN_ARNES, verifyDisabledReason: SIN_ARNES };
  }
  return recipeFor(BY_HARNESS.get(harnessId), harnessId);
}

export function shellCommand(argv: readonly string[]): string {
  return argv.join(' ');
}

export function argvFor(recipe: HarnessLoginRecipe, action: LoginAction): readonly string[] | null {
  return action === 'autenticar' ? recipe.authenticate : recipe.verify;
}

export function loginHref(tenantId: string, alias: string, action: LoginAction): string {
  return `/terminal/${encodeURIComponent(tenantId)}/${encodeURIComponent(alias)}?modo=terminal&accion=${action}`;
}

export function loginActionOf(search: string): LoginAction | undefined {
  const action = new URLSearchParams(search).get('accion');
  return action === 'autenticar' || action === 'comprobar' ? action : undefined;
}

export function loginMark(sessionId: string, action: LoginAction, argv: readonly string[]): string {
  return `${sessionId}\n${action}\n${argv.join('\n')}`;
}

/** Registry harness, not the PTY agent's self-reported name: only that id selects a descriptor. */
export function harnessIdForTerminal(
  live: ReadonlyMap<string, { harnessId?: string | null }> | undefined,
  agentId: string | undefined,
  topology: TopologySnapshot | undefined,
  tenantId: string | undefined,
  alias: string | undefined,
): string | null {
  const fromLive = agentId ? live?.get(agentId)?.harnessId : undefined;
  if (typeof fromLive === 'string' && fromLive.length > 0) return fromLive;
  if (!topology || !tenantId || !alias) return null;
  for (const node of topology.tenants ?? []) {
    if (node.id !== tenantId) continue;
    for (const room of node.rooms ?? []) {
      for (const member of room.members ?? []) {
        if (member.alias === alias && typeof member.harness_id === 'string' && member.harness_id.length > 0) {
          return member.harness_id;
        }
      }
    }
  }
  return null;
}
