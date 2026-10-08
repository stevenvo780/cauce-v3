import { AgentProfileMutationError, StoreError, type AgentProfileRepository, type CauceRepository, type PersistedAgentProfile } from '@cauce/store';
import { canonicallyEqual, type AgentProfile } from '@cauce/protocol';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthError, AuthorizationError, requireOperatorPermission, type AuthProvider } from '../auth.js';
import { PasswordAuthProvider } from '../password-auth.js';
import { consoleHumanAccess } from '../console-human-authority.js';
import { admitProfileWrite, isRejectedProfileWrite } from './agent-profile/write-gates.js';
import type { AgentProfileDeps } from './agent-profile.routes.js';

export interface AgentProfileDraftInput { profile: AgentProfile; expected_revision: number | null; reason: string }
export interface AgentProfileDraftBinding {
  prepareDraft(request: FastifyRequest, reply: FastifyReply, input: AgentProfileDraftInput): Promise<PersistedAgentProfile>;
  canPrepareDraft(request: FastifyRequest, reply: FastifyReply, tenantId: string, alias: string): Promise<boolean>;
}
export function createAgentProfileDraftBinding(provider: AuthProvider, profiles: Pick<AgentProfileRepository, 'prepareDraft' | 'canPrepareDraft'>,
  authority: Pick<CauceRepository, 'authorizeAgentTarget'>): AgentProfileDraftBinding {
  const fresh = async (request: FastifyRequest) => {
    if (!(provider instanceof PasswordAuthProvider) || !request.headers.cookie || request.headers.authorization !== undefined) throw new AuthorizationError();
    const who = await provider.authenticateConsoleFresh(request); requireOperatorPermission(who, 'control');
    if (who.channel !== 'console' || !who.operator_profile?.id) throw new AuthorizationError(); return who;
  };
  return {
    canPrepareDraft: async (request, reply, tenantId, alias) => {
      try {
        const who = await fresh(request);
        if (!(provider instanceof PasswordAuthProvider) || !(await provider.verifiedConsoleSession(request))?.credentialStamp) return false;
        const target = await authority.authorizeAgentTarget(who.tenant_id, who.alias, tenantId, alias, 'configure');
        if (target?.tenant_id !== tenantId || target.alias !== alias || target.enabled) return false;
        const access = await consoleHumanAccess(provider, request, reply, 'read'); if (!access) return false;
        try { return await profiles.canPrepareDraft({ tenant_id: who.tenant_id, alias: who.alias, subject: who.operator_profile?.id ?? '', reason: '',
          humanAuthority: access.options.humanAuthority, signal: access.options.signal,
        }, tenantId, alias); } finally { access.close(); }
      } catch (error) { if (error instanceof AuthError || error instanceof AuthorizationError) return false; throw error; }
    },
    prepareDraft: async (request, reply, input) => {
      const who = await fresh(request); if (!(provider instanceof PasswordAuthProvider)) throw new AuthorizationError();
      await provider.requireCsrf(request);
      const access = await consoleHumanAccess(provider, request, reply, 'read'); if (!access) throw new AuthorizationError();
      try { return await profiles.prepareDraft(input.profile, input.expected_revision, {
        tenant_id: who.tenant_id, alias: who.alias, subject: who.operator_profile?.id ?? '', reason: input.reason,
        humanAuthority: access.options.humanAuthority, signal: access.options.signal,
      }); } finally { access.close(); }
    },
  };
}
type DraftDenial = (status: number, body: Readonly<Record<string, unknown>>) => Promise<FastifyReply>;
export async function respondDisabledProfileDraft(deps: AgentProfileDeps, request: FastifyRequest, reply: FastifyReply,
  tenantId: string, alias: string, deny: DraftDenial): Promise<FastifyReply> {
  const admitted = admitProfileWrite(request.body, tenantId, alias);
  if (isRejectedProfileWrite(admitted)) return await deny(admitted.status, admitted.body);
  if (admitted.context_source !== undefined) return await deny(409, { error: 'disabled_source_application', message: 'El origen nativo requiere un runtime verificado.' });
  try {
    const current = await deps.readContext(tenantId, alias);
    if (current.contexto.perfil.tenant_id !== tenantId || current.contexto.perfil.alias !== alias) throw new Error('draft_scope_mismatch');
    if (current.revision !== admitted.expected_revision || (admitted.expected_revision === null && current.exists)) {
      return await deny(409, { error: 'profile_revision_conflict', revision: current.revision, applied_revision: current.applied_revision });
    }
    const result = await deps.prepareDraft?.(request, reply, admitted);
    const expected = admitted.expected_revision === null ? 1 : canonicallyEqual(current.contexto.perfil, admitted.profile)
      ? admitted.expected_revision : admitted.expected_revision + 1;
    if (!result?.exists || result.revision !== expected || result.applied_revision !== current.applied_revision
      || Object.keys(result).some(key => !['perfil', 'exists', 'revision', 'applied_revision'].includes(key))
      || !canonicallyEqual(result.perfil, admitted.profile)) throw new Error('draft_receipt_mismatch');
    return await reply.code(202).send({ ok: true, state: 'prepared_disabled', tenant_id: tenantId, alias, agent_enabled: false,
      revision: result.revision, desired_revision: result.revision, applied_revision: result.applied_revision, perfil: admitted.profile,
      message: 'Perfil deseado preparado. La escritura en disco y el ACK del runtime se verificarán al iniciar el agente.' });
  } catch (error) {
    const forbidden = error instanceof AuthorizationError || error instanceof AuthError || (error instanceof StoreError && error.code === 'forbidden');
    const conflict = error instanceof AgentProfileMutationError || (error instanceof StoreError && error.code === 'conflict');
    return deny(forbidden ? 403 : conflict ? 409 : 503, { error: forbidden ? 'forbidden' : conflict ? 'profile_revision_conflict' : 'profile_draft_unverified',
      message: 'No se pudo verificar la preparación del perfil deseado.' });
  }
}
