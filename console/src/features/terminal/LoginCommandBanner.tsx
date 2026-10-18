import { onNavClick } from '../../router';
import {
  argvFor,
  harnessLoginRecipe,
  loginHref,
  shellCommand,
  type LoginAction,
} from './login-recipe';

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
