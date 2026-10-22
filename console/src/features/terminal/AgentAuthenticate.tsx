import { KeyRound } from 'lucide-react';
import { useId, useState } from 'react';
import { AgentSignInDialog } from '../accounts/ProviderSignIn';
import { Button } from '../../components/kit';
import { cn } from '../../cn';
import { HUD_BUTTON, HUD_TEXT } from '../office/hud-style';
import { PrepareAgentLink } from '../config/prepare-agent-link';
import { useLiveAgent } from '../config/use-live-agent';
import { harnessLoginRecipe } from './login-recipe';

/** One login for one agent. The dialog picks the profile terminal or the live PTY. */
export function AgentAuthenticate({ tenantId, alias, harnessId, prepared, onPrepare, tone = 'page', layout = 'row', size = 'sm', className }: {
  tenantId: string;
  alias: string;
  harnessId: string | null | undefined;
  prepared?: boolean;
  onPrepare?: () => void;
  tone?: 'page' | 'hud';
  layout?: 'row' | 'stack';
  size?: 'sm' | 'md';
  className?: string;
}) {
  const noteId = useId();
  const [open, setOpen] = useState(false);
  const live = useLiveAgent(tenantId, alias);
  const recipe = harnessLoginRecipe(harnessId);
  const needsPreparation = prepared === false || live?.state === 'unprepared' || live?.agent.host_id === null;
  const hud = tone === 'hud';
  const fill = layout === 'stack';
  const name = `Iniciar sesión de ${alias}`;
  const title = needsPreparation ? 'Prepara el agente en una computadora antes de iniciar sesión' : recipe.authenticate
    ? `Abre el inicio de sesión de ${alias}`
    : recipe.authenticateDisabledReason ?? 'Iniciar sesión';
  const note = needsPreparation ? title : recipe.authenticate
    ? 'Abre la terminal del agente para conectar su cuenta del proveedor.'
    : recipe.authenticateDisabledReason;
  const buttonClass = hud ? cn(HUD_BUTTON, HUD_TEXT, 'h-8 px-2.5') : fill ? 'w-full' : undefined;
  return (
    <section aria-label={`Autenticación de ${alias}`} aria-describedby={note ? noteId : undefined} className={cn('grid min-w-0 gap-1.5 wrap-anywhere', className)}>
      {hud ? (
        <button type="button" disabled={needsPreparation} aria-describedby={note ? noteId : undefined} aria-label={name} title={title} className={buttonClass} onClick={() => { setOpen(true); }}>
          <KeyRound size={13} aria-hidden="true" /> Iniciar sesión
        </button>
      ) : (
        <Button size={size} variant="primary" disabled={needsPreparation} aria-describedby={note ? noteId : undefined} aria-label={name} title={title} className={buttonClass} onClick={() => { setOpen(true); }}>
          <KeyRound size={13} aria-hidden="true" />Iniciar sesión
        </Button>
      )}
      {note ? <p id={noteId} className={cn('m-0', hud ? 'text-[10px] leading-snug font-normal tracking-normal text-[#94b0c2] normal-case' : 'text-xs leading-snug text-muted')}>{note}</p> : null}
      {needsPreparation ? <PrepareAgentLink tenantId={tenantId} alias={alias} onPrepare={onPrepare}
        className={cn('text-xs underline underline-offset-2', hud ? 'text-[#94b0c2]' : 'text-brand-ink')} /> : null}
      <AgentSignInDialog open={open && !needsPreparation} tenantId={tenantId} alias={alias} harnessId={harnessId} onClose={() => { setOpen(false); }} />
    </section>
  );
}
