import type { AgentPerfil } from '../../api/types';
import { cn } from '../../cn';
import { TONE_CLASS, type Tone } from '../../status-tone';
import { profileIsAdopted } from './profile-save-receipt';

const HARNESS_CONTEXT: Readonly<Record<string, string>> = {
  claude: 'Claude Code combina CLAUDE.md de usuario y manuales del proyecto. Las reglas adicionales del arnés no están cubiertas por esta lectura.',
  codex: 'Codex combina instrucciones de usuario y proyecto; los archivos override y los niveles más cercanos pueden cambiar la precedencia.',
  openclaw: 'OpenClaw reparte el perfil entre SOUL.md, IDENTITY.md, USER.md, AGENTS.md y TOOLS.md. MEMORY.md y HEARTBEAT.md pertenecen al agente.',
  muse: 'Muse recibe los campos canónicos en el AGENTS.md de su workspace medido.',
  hermes: 'Hermes permite el manual AGENTS.md medido. Este gateway no publica aplicación del perfil canónico para este arnés.',
  opencode: 'OpenCode puede ejecutar tareas y conversar. Este gateway no expone sus archivos de contexto ni una proyección canónica editable.',
};

/** Three separate facts: saved, written to the files, and read by the live session. */
export function ProfileStatus({ profile }: { profile: AgentPerfil | undefined }) {
  if (!profile?.publicado) return null;
  const verification = profile.runtime_verification?.state;
  const stages: { label: string; value: string; tone: Tone }[] = [
    {
      label: 'Configurado',
      value: profile.exists === true ? `Revisión ${String(profile.revision)}` : profile.exists === false ? 'Sin perfil guardado' : 'Sin dato',
      tone: profile.exists === true ? 'ok' : 'neutral',
    },
    {
      label: 'En los archivos',
      value: verification === 'current' ? 'Verificado' : verification === 'drifted' ? 'Difiere del perfil' : 'Sin verificar',
      tone: verification === 'current' ? 'ok' : verification === 'drifted' ? 'warn' : 'neutral',
    },
    {
      label: 'En la sesión',
      value: profileIsAdopted(profile) ? 'Adopción acreditada' : 'Adopción no acreditada',
      tone: profileIsAdopted(profile) ? 'ok' : 'neutral',
    },
  ];
  return (
    <div className="grid gap-2">
      <dl aria-label="Guardado, archivos y adopción de sesión"
        className="m-0 grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3">
        {stages.map((stage) => (
          <div key={stage.label} className="grid content-start gap-0.5 bg-surface px-3 py-2.5">
            <dt className="text-xs text-muted">{stage.label}</dt>
            <dd className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
              <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', TONE_CLASS[stage.tone].dot)} />
              {stage.value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="m-0 text-xs text-muted">
        <span className="font-mono font-medium text-fg-2">{profile.harness ?? 'Arnés sin verificar'}</span>
        {' · '}
        {HARNESS_CONTEXT[profile.harness ?? ''] ?? 'Las opciones disponibles dependen de los hechos y documentos publicados por este runtime.'}
      </p>
    </div>
  );
}
