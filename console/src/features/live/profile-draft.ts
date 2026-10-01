import type { AgentPerfil, AgentPerfilCampos } from '../../api/types';
import { camposVigentes, perfilParaGuardar } from './perfil';

/** A draft keeps the snapshot it was authored against, including untouched fields. */
export type ProfileDraft = Partial<AgentPerfilCampos> & {
  base?: { revision: number | null; fields: AgentPerfilCampos };
};

export interface ProfileOutcome { text: string; tone: 'error' | 'parcial' | 'success' }
export interface ProfileSettlement {
  expectedDraft: ProfileDraft | undefined;
  draft: ProfileDraft | undefined;
  outcome: ProfileOutcome;
}

export function editProfileDraft(
  profile: AgentPerfil | undefined, draft: ProfileDraft | undefined,
  change: Partial<AgentPerfilCampos>,
): ProfileDraft {
  const fields = draft?.base?.fields ?? camposVigentes(profile, undefined);
  return {
    ...draft,
    ...change,
    base: draft?.base ?? { revision: profile?.revision ?? null, fields },
  };
}

export function draftFields(profile: AgentPerfil | undefined, draft: ProfileDraft | undefined): AgentPerfilCampos {
  return { ...(draft?.base?.fields ?? camposVigentes(profile, undefined)), ...draft };
}

export function profileMatchesDraft(profile: AgentPerfil, fields: AgentPerfilCampos): boolean {
  const saved = perfilParaGuardar(camposVigentes(profile, undefined));
  const submitted = perfilParaGuardar({
    ...fields, purpose: fields.purpose.trim(), role_summary: fields.role_summary.trim(),
    human_brief: fields.human_brief.trim(),
  });
  return JSON.stringify(saved) === JSON.stringify(submitted);
}

export function draftRevisionConflict(profile: AgentPerfil | undefined, draft: ProfileDraft | undefined): boolean {
  return draft?.base !== undefined && profile?.publicado === true
    && draft.base.revision !== profile.revision;
}
