import type { AgentPerfil } from '../../api/types';
import { profileIsAdopted } from './profile-save-receipt';

const HARNESS_CONTEXT: Readonly<Record<string, string>> = {
  claude: 'Claude Code combina CLAUDE.md de usuario y manuales del proyecto. Las reglas adicionales del arnés no están cubiertas por esta lectura.',
  codex: 'Codex combina instrucciones de usuario y proyecto; los archivos override y los niveles más cercanos pueden cambiar la precedencia.',
  openclaw: 'OpenClaw reparte el perfil entre SOUL.md, IDENTITY.md, USER.md, AGENTS.md y TOOLS.md. MEMORY.md y HEARTBEAT.md pertenecen al agente.',
  muse: 'Muse recibe los campos canónicos en el AGENTS.md de su workspace medido.',
  hermes: 'Hermes permite el manual AGENTS.md medido. Este gateway no publica aplicación del perfil canónico para este arnés.',
  opencode: 'OpenCode puede ejecutar tareas y conversar. Este gateway no expone sus archivos de contexto ni una proyección canónica editable.',
};

export function ProfileStatus({ profile }: { profile: AgentPerfil | undefined }) {
  if (!profile?.publicado) return null;
  const verified = profile.runtime_verification?.state === 'current';
  const adopted = profileIsAdopted(profile);
  return (
    <div className="context-status">
      <p className="context-harness-name">{profile.harness ?? 'Arnés sin verificar'}</p>
      <p>{HARNESS_CONTEXT[profile.harness ?? ''] ?? 'Las opciones disponibles dependen de los hechos y documentos publicados por este runtime.'}</p>
      <dl className="context-status-stages" aria-label="Guardado, archivos y adopción de sesión">
        <div><dt>Configurado</dt><dd>{profile.exists === true ? `Revisión ${String(profile.revision)}` : profile.exists === false ? 'Sin perfil guardado' : 'Sin dato'}</dd></div>
        <div><dt>En los archivos</dt><dd>{verified ? 'Verificado' : profile.runtime_verification?.state === 'drifted' ? 'Difiere del perfil' : 'Sin verificar'}</dd></div>
        <div><dt>En la sesión</dt><dd>{adopted ? 'Adopción acreditada' : 'Adopción no acreditada'}</dd></div>
      </dl>
    </div>
  );
}
