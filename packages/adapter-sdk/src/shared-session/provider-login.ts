import { ProcessExecutionError } from '../sdk/errors.js';
import type { SharedSessionHarness } from './types.js';

export const PROVIDER_LOGIN_MESSAGE = 'La sesión del proveedor caducó: vuelve a iniciar sesión';

export function providerLoginError(): ProcessExecutionError {
  return new ProcessExecutionError('PROVIDER_LOGIN_REQUIRED', PROVIDER_LOGIN_MESSAGE, true);
}

const BLOCKING_AUTH: Readonly<Record<SharedSessionHarness, RegExp>> = {
  claude: /^Login expired\s*[·•-]\s*Please run \/login[.!]?$/iu,
  codex: /^Your access token could not be refreshed(?:(?: because your refresh token (?:has expired|was already used|was revoked))?\. Please log out and sign in again\.| because you have since logged out or signed in to another account\. Please sign in again\.)$/u,
  grok: /^(?:Authentication required: your session has expired or your credentials were rejected\. Run \/login to re-authenticate, then resend your message\.|(?:Your session has expired|Authentication could not be refreshed)\. Run `grok login` to sign in again\.|[^"'`>]{0,160}could not renew it in the background\. Run \/login to sign in again\.)$/u,
  muse: /^Your saved Meta credentials are invalid\. Your message was not sent\. Quit Muse Code and run `muse login`\.$/u,
};

const CLAUDE_BULLET = /^[●⏺]\s+/u;

export function providerLoginRequired(harness: SharedSessionHarness, pane: string | undefined): boolean {
  if (pane === undefined) return false;
  let fence: string | undefined;
  let userContinuation = false;
  const lines = pane.split(/\r?\n/u).map(line => {
    // eslint-disable-next-line no-control-regex
    const raw = line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '');
    const text = raw.replace(/^[\s│║]+|[\s│║]+$/gu, '');
    const fenceText = harness === 'claude' ? text.replace(CLAUDE_BULLET, '') : text;
    const marker = /^(`{3,}|~{3,})/u.exec(fenceText)?.[1];
    if (fence !== undefined) {
      if (marker !== undefined && marker.startsWith(fence.slice(0, 1)) && marker.length >= fence.length
        && fenceText.slice(marker.length).trim() === '') fence = undefined;
      return '';
    }
    if (harness === 'claude') {
      const prompt = /^[❯›»](?:\s(.*)|$)/u.exec(text);
      if (prompt !== null) userContinuation = (prompt[1]?.trim().length ?? 0) > 0;
      else if (userContinuation && /^[ \t]{2}/u.test(raw)) return '';
      else if (text !== '') userContinuation = false;
    }
    if (marker !== undefined) { fence = marker; return ''; }
    return text;
  });
  const prompt = lines.findLastIndex(line => /^[❯›»](?:\s|$)/u.test(line));
  const active = lines.slice(prompt + 1);
  const blocking = BLOCKING_AUTH[harness];
  const matches = (value: string): boolean => blocking.test(value.replace(/^(?:Error:|✕|×|■)\s*/u, '').replace(/\s+/gu, ' ').trim());
  for (let start = 0; harness !== 'claude' && start < active.length; start += 1) {
    let candidate = '';
    for (let end = start; end < Math.min(active.length, start + 8); end += 1) {
      candidate += ` ${active[end] ?? ''}`;
      if (matches(candidate.trim())) return true;
    }
  }
  switch (harness) {
    case 'claude':
      return active.some(line => blocking.test(line.replace(CLAUDE_BULLET, '')))
        && active.some(line => /^Paste code here if prompted\s*>\s*$/iu.test(line));
    case 'codex':
      return (active.some(line => /^Sign in with ChatGPT(?:\s|$)/u.test(line))
        && active.some(line => /^or connect an API key for usage-based billing$/u.test(line)))
        || (active.some(line => /^Finish signing in via your browser$/u.test(line))
          && active.some(line => /^Press \S+ to cancel$/iu.test(line)));
    case 'grok':
      return active.some(line => /^Sign in to Grok$/u.test(line))
        && active.some(line => /^(?:Opening your browser to sign in|Waiting for approval|Sign-in failed)$/u.test(line));
    case 'muse':
      return active.some(line => /^(?:Open this page to sign in:|Sign in at this page:)$/u.test(line))
        && active.some(line => /^(?:Waiting for approval(?: Esc cancel)?|The login request expired before it was approved\.)$/u.test(line));
  }
}
