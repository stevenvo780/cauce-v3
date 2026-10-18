import { KeyRound } from 'lucide-react';
import { useId, useState } from 'react';
import { AgentSignInDialog } from '../accounts/ProviderSignIn';
import { Button } from '../../components/kit';
import { cn } from '../../cn';
import { onNavClick } from '../../router';
import { HUD_BUTTON, HUD_TEXT } from '../office/hud-style';
import {
  argvFor,
  harnessLoginRecipe,
  loginHref,
  shellCommand,
  type LoginAction,
} from './login-recipe';

/** One login for one agent. The dialog picks the profile terminal or the live PTY. */
export function AgentAuthenticate({ tenantId, alias, harnessId, tone = 'page', layout = 'row', className }: {
  tenantId: string;
  alias: string;
  harnessId: string | null | undefined;
  tone?: 'page' | 'hud';
  layout?: 'row' | 'stack';
  className?: string;
}) {
  const noteId = useId();
  const [open, setOpen] = useState(false);
  const recipe = harnessLoginRecipe(harnessId);
  const hud = tone === 'hud';
  const fill = layout === 'stack';
  const name = `Iniciar sesión de ${alias}`;
  const title = recipe.authenticate
    ? `Abre la terminal de ${tenantId}/${alias} y ejecuta ${shellCommand(recipe.authenticate)}`
    : recipe.authenticateDisabledReason ?? 'Iniciar sesión';
  const note = recipe.authenticate
    ? `Iniciar sesión abre la terminal lista y ejecuta ${shellCommand(recipe.authenticate)}.`
    : recipe.authenticateDisabledReason;
  const buttonClass = hud ? cn(HUD_BUTTON, HUD_TEXT, 'h-8 px-2.5') : fill ? 'w-full' : undefined;
  return (
    <section aria-label={`Autenticación de ${alias}`} aria-describedby={note ? noteId : undefined} className={cn('grid gap-1.5', className)}>
      {hud ? (
        <button type="button" aria-label={name} title={title} className={buttonClass} onClick={() => { setOpen(true); }}>
          <KeyRound size={13} aria-hidden="true" /> Iniciar sesión
        </button>
      ) : (
        <Button size="sm" variant="primary" aria-label={name} title={title} className={buttonClass} onClick={() => { setOpen(true); }}>
          <KeyRound size={13} aria-hidden="true" />Iniciar sesión
        </Button>
      )}
      {note ? <p id={noteId} className={cn('m-0', hud ? 'text-[10px] leading-snug font-normal tracking-normal text-[#94b0c2] normal-case' : 'text-xs leading-snug text-muted')}>{note}</p> : null}
      <AgentSignInDialog open={open} tenantId={tenantId} alias={alias} harnessId={harnessId} onClose={() => { setOpen(false); }} />
    </section>
  );
}

/** What the shell will run, or why this harness cannot. Shown on the terminal that the button opened. */
export function LoginCommandBanner({ action, harnessId, tenantId, alias, sent }: {
  action: LoginAction;
  harnessId: string | null;
  tenantId: string;
  alias: string;
  sent: boolean;
}) {
  const recipe = harnessLoginRecipe(harnessId);
  const argv = argvFor(recipe, action);
  const reason = action === 'autenticar' ? recipe.authenticateDisabledReason : recipe.verifyDisabledReason;
  const comprobar = loginHref(tenantId, alias, 'comprobar');
  if (!argv) return <p className="m-0" role="status">{reason}</p>;
  const command = shellCommand(argv);
  return (
    <p className="m-0" role="status">
      {sent
        ? <>Se ejecutó <code className="font-mono">{command}</code> en esta shell. {action === 'autenticar'
          ? 'Completá el enlace o el código aquí.'
          : 'La salida dice si la cuenta quedó con sesión.'}</>
        : <>Cuando la shell quede lista se ejecuta <code className="font-mono">{command}</code>.</>}
      {action === 'autenticar' && recipe.verify ? <>
        {' '}<a href={comprobar} onClick={(event) => { onNavClick(event, comprobar); }} className="text-brand-ink underline underline-offset-2">Comprobar</a>
        {' '}ejecuta <code className="font-mono">{shellCommand(recipe.verify)}</code> en esta misma shell.
      </> : null}
      {action === 'autenticar' && !recipe.verify ? <> {recipe.verifyDisabledReason}</> : null}
    </p>
  );
}
