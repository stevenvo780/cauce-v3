import { KeyRound, ShieldCheck } from 'lucide-react';
import { useId } from 'react';
import { Button, LinkButton } from '../../components/kit';
import { cn } from '../../cn';
import { onNavClick } from '../../router';
import { HUD_BUTTON, HUD_TEXT } from '../office/hud-style';
import {
  argvFor,
  harnessLoginRecipe,
  loginHref,
  shellCommand,
  type HarnessLoginRecipe,
  type LoginAction,
} from './login-recipe';

function notes(recipe: HarnessLoginRecipe): string[] {
  const lines: string[] = [];
  if (recipe.authenticate) lines.push(`Autenticar abre la terminal y ejecuta ${shellCommand(recipe.authenticate)}.`);
  else if (recipe.authenticateDisabledReason) lines.push(recipe.authenticateDisabledReason);
  if (recipe.verify) lines.push(`Comprobar ejecuta ${shellCommand(recipe.verify)} en esa terminal.`);
  else if (recipe.verifyDisabledReason && recipe.verifyDisabledReason !== recipe.authenticateDisabledReason) {
    lines.push(recipe.verifyDisabledReason);
  }
  return lines;
}

function AuthControl({ action, tenantId, alias, argv, reason, hud, fill }: {
  action: LoginAction;
  tenantId: string;
  alias: string;
  argv: readonly string[] | null;
  reason: string | null;
  hud: boolean;
  fill: boolean;
}) {
  const label = action === 'autenticar' ? 'Autenticar' : 'Comprobar';
  const name = action === 'autenticar' ? `Autenticar ${alias}` : `Comprobar sesión de ${alias}`;
  const Icon = action === 'autenticar' ? KeyRound : ShieldCheck;
  const title = argv ? `Ejecuta ${shellCommand(argv)} en la terminal de ${tenantId}/${alias}` : reason ?? label;
  const href = argv ? loginHref(tenantId, alias, action) : undefined;
  const className = hud
    ? cn(HUD_BUTTON, HUD_TEXT, 'h-8 px-2.5', href ? 'no-underline' : null)
    : fill ? 'w-full' : undefined;
  if (href) {
    return hud ? (
      <a href={href} aria-label={name} title={title} onClick={(event) => { onNavClick(event, href); }} className={className}>
        <Icon size={13} aria-hidden="true" /> {label}
      </a>
    ) : (
      <LinkButton href={href} size="sm" variant={action === 'autenticar' ? 'primary' : 'secondary'} aria-label={name} title={title}
        className={className} onClick={(event) => { onNavClick(event, href); }}>
        <Icon size={13} aria-hidden="true" />{label}
      </LinkButton>
    );
  }
  return hud ? (
    <button type="button" disabled aria-label={name} title={title} className={className}>
      <Icon size={13} aria-hidden="true" /> {label}
    </button>
  ) : (
    <Button size="sm" disabled aria-label={name} title={title} className={className}>
      <Icon size={13} aria-hidden="true" />{label}
    </Button>
  );
}

/** Login and session check for one agent, both driven by the published harness descriptor. */
export function AgentAuthenticate({ tenantId, alias, harnessId, tone = 'page', layout = 'row', className }: {
  tenantId: string;
  alias: string;
  harnessId: string | null | undefined;
  tone?: 'page' | 'hud';
  layout?: 'row' | 'stack';
  className?: string;
}) {
  const noteId = useId();
  const recipe = harnessLoginRecipe(harnessId);
  const hud = tone === 'hud';
  const fill = layout === 'stack';
  const lines = notes(recipe);
  return (
    <section aria-label={`Autenticación de ${alias}`} aria-describedby={noteId} className={cn('grid gap-1.5', className)}>
      <div className={cn('flex gap-1', fill ? 'flex-col' : 'flex-wrap')}>
        <AuthControl action="autenticar" tenantId={tenantId} alias={alias} argv={recipe.authenticate}
          reason={recipe.authenticateDisabledReason} hud={hud} fill={fill} />
        <AuthControl action="comprobar" tenantId={tenantId} alias={alias} argv={recipe.verify}
          reason={recipe.verifyDisabledReason} hud={hud} fill={fill} />
      </div>
      <div id={noteId} className={cn('grid gap-0.5', hud ? 'text-[10px] leading-snug font-normal tracking-normal text-[#94b0c2] normal-case' : 'text-xs leading-snug text-muted')}>
        {lines.map((line) => <p key={line} className="m-0">{line}</p>)}
      </div>
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
