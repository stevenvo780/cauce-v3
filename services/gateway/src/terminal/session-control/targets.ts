import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabasePool } from '@cauce/store';
import { requireOperatorPermission, type Principal } from '../../auth.js';
import {
  attributionAllows, containerCohort, fleetIdentity, loadFleetPlacements, resolveOperator,
  routingAuthority, type GrantStore, type RoutingAuthority,
} from '../authority.js';
import type { TerminalConfig } from '../config.js';
import type { AgentTargetRepository } from '../helpers.js';
import type { AgentRegistry, AgentResolution } from '../registry.js';
import {
  isTerminalMode, isWritableMode, type TerminalDenial, type TerminalMode, type TerminalTarget,
} from '../types.js';

interface TerminalTargetRouteOptions {
  readonly pool: DatabasePool;
  readonly config: TerminalConfig;
  readonly registry: AgentRegistry;
  readonly grants: GrantStore;
  readonly repository: AgentTargetRepository;
  readonly principal: (request: FastifyRequest) => Promise<Principal>;
  readonly replyError: (reply: FastifyReply, error: unknown) => void;
}

/** Authority and reachability are independent: an authorized target may be offline, not installed or unknown. */
function terminalTargetStateReason(resolution: AgentResolution, container: string): string {
  switch (resolution.status) {
    case 'online':
      return 'El agente PTY está conectado al terminal-relay.';
    case 'offline':
      return 'El agente PTY figura fuera de línea: no está conectado al terminal-relay.';
    case 'ambiguous':
      return 'El agente PTY figura fuera de línea porque más de un terminal-relay lo anuncia y no hay una ruta única segura.';
    case 'not_installed':
      return `El agente PTY figura como no instalado: el terminal-relay nunca registró este destino en ${container}.`;
    case 'unknown':
      return 'El estado del agente PTY es desconocido: el terminal-relay todavía no publicó un snapshot verificable.';
  }
}

/** The causes of a refused target, told apart: only the missing grant row is the operator's own. */
function terminalTargetDenialReason(denial: TerminalDenial | undefined, target: string): string {
  switch (denial) {
    case 'no_grant_for_operator':
      return `no_grant_for_operator: no hay concesión en grants.json para tu operador sobre ${target}`;
    case 'no_recognized_mode':
      return `no_recognized_mode: el agente PTY de ${target} no publica ningún modo que este gateway conozca`;
    case 'attribution_required':
      return `attribution_required: sin identidad por persona para alcanzar ${target}`;
    default:
      return `no_routing_authority: sin autoridad de ruteo sobre ${target}`;
  }
}

export function registerTerminalTargetRoute(
  app: FastifyInstance,
  options: TerminalTargetRouteOptions,
): void {
  const { pool, config, registry, grants, repository, principal, replyError } = options;

  app.get('/v3/console/terminal/targets', async (request, reply) => {
    try {
      const actor = await principal(request);
      requireOperatorPermission(actor, 'control');
      const operator = resolveOperator(request, actor, config);
      const now = Date.now();
      const placements = await loadFleetPlacements(pool);
      // One routing decision per (tenant, alias) even though cohorts overlap heavily.
      const decisions = new Map<string, Promise<RoutingAuthority>>();
      const authorityFor = (tenantId: string, alias: string): Promise<RoutingAuthority> => {
        const cacheKey = `${tenantId}\0${alias}`;
        let pending = decisions.get(cacheKey);
        if (!pending) {
          pending = routingAuthority(pool, actor.tenant_id, actor.alias, tenantId, alias);
          decisions.set(cacheKey, pending);
        }
        return pending;
      };
      const visibilityDecisions = new Map<string, Promise<boolean>>();
      const visibleFor = (tenantId: string, alias: string): Promise<boolean> => {
        const cacheKey = `${tenantId}\0${alias}`;
        let pending = visibilityDecisions.get(cacheKey);
        if (!pending) {
          pending = repository.authorizeAgentTarget(
            actor.tenant_id, actor.alias, tenantId, alias, 'control',
          ).then((target) => target !== undefined);
          visibilityDecisions.set(cacheKey, pending);
        }
        return pending;
      };
      const items: TerminalTarget[] = [];
      for (const placement of placements) {
// The `agents` table holds the entire physical fleet, not only what is visible to this actor.
        // Enumerating it before authorization used to leak names, tenants, and cohorts of clients without
        // an allow_control edge. The same canonical identity governing the rest of the console first decides
        // whether the row may exist in this response.
        if (!(await visibleFor(placement.tenant_id, placement.alias))) continue;
        const cohort = containerCohort(placements, placement.tenant_id, placement.alias);
        // A shared container is one authority surface. Never reveal the names of hidden colocated
        // tenants merely because the requested placement itself is visible.
        const cohortVisible = (await Promise.all(
          cohort.map((member) => visibleFor(member.tenant_id, member.alias))
        )).every(Boolean);
        const resolution = registry.resolve(placement.tenant_id, placement.alias, now);
        const observation = resolution.status === 'online' || resolution.status === 'offline'
          ? resolution.observation
          : undefined;
        const state = registry.state(placement.tenant_id, placement.alias, now);
        let denial: TerminalDenial | undefined = cohortVisible ? undefined : 'no_routing_authority';
        if (denial === undefined
            && !attributionAllows(operator.attributed, actor.tenant_id, placement.tenant_id)) {
          denial = 'attribution_required';
        }
        for (const member of cohort) {
          if (denial !== undefined) break;
          if (!attributionAllows(operator.attributed, actor.tenant_id, member.tenant_id)) {
            denial = 'attribution_required';
            break;
          }
          if (!(await authorityFor(member.tenant_id, member.alias)).allowed) {
            denial = 'no_routing_authority';
          }
        }
        const reported = (observation?.presence.modes ?? ['shell']).filter(isTerminalMode);
        const modes: TerminalMode[] = [];
        if (denial === undefined) {
          for (const mode of reported) {
            if (await grants.allowsCohort(operator.operator_id, cohort, mode, now)) modes.push(mode);
          }
          // A missing grant row is only possible for a mode this gateway knows; no known mode is a refusal.
          if (modes.length === 0) denial = reported.length > 0 ? 'no_grant_for_operator' : 'no_recognized_mode';
        }
        const usable = denial === undefined;
        items.push({
          tenant_id: placement.tenant_id,
          alias: placement.alias,
          // Denial must not confirm what the target looks like, only that authority is missing.
          container: usable ? placement.container : null,
          runtime_user: usable ? (observation?.presence.runtime_user ?? placement.runtime_user) : null,
          harness: usable ? (observation?.presence.harness ?? null) : null,
          image: usable ? (observation?.presence.image_id ?? null) : null,
          shares_container_with: cohortVisible
            ? cohort
              .filter((member) => member.tenant_id !== placement.tenant_id || member.alias !== placement.alias)
              .map(fleetIdentity)
            : [],
          modes: usable ? modes : [],
          writable_modes: usable ? modes.filter((mode) => isWritableMode(mode)) : [],
          pty_state: state,
          last_seen: observation?.observed_at ?? null,
          authorized: usable,
          reason: usable
            ? terminalTargetStateReason(resolution, placement.container)
            : terminalTargetDenialReason(denial, `${placement.tenant_id}:${placement.alias}`)
        });
      }
      return {
        observed_at: new Date(now).toISOString(),
        websocket_path: config.wsPath,
        items
      };
    } catch (error) { replyError(reply, error); }
  });
}
