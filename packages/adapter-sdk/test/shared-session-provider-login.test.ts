import assert from 'node:assert/strict';
import test from 'node:test';
import { providerLoginRequired } from '../src/shared-session/provider-login.js';

const expiredPane = (bullet = '●'): string => [
  `${bullet} Login expired · Please run /login`,
  '✻ Crunched for 0s · done Saturday 6:52 PM',
  '▔'.repeat(60),
  '   Login',
  "   Browser didn't open? Use the url below to sign in (c to copy)",
  '   Hold Shift (Option in iTerm2, Fn in Terminal.app) while selecting to use your terminal\'s native copy',
  '   Paste code here if prompted >',
  '   Esc to cancel',
].join('\n');

for (const bullet of ['●', '⏺']) {
  test(`Claude: the incident pane with ${bullet} requires provider login`, () => {
    assert.equal(providerLoginRequired('claude', expiredPane(bullet)), true);
    assert.equal(providerLoginRequired('claude', `\u001b[31m${expiredPane(bullet)}\u001b[0m`), true);
  });

  test(`Claude: ${bullet} still requires both the expiry and the active login dialogue`, () => {
    assert.equal(providerLoginRequired('claude', `${bullet} Login expired · Please run /login`), false);
    assert.equal(providerLoginRequired('claude', expiredPane(bullet).split('\n').slice(1).join('\n')), false);
    assert.equal(providerLoginRequired('claude', expiredPane(bullet).replace('Please run /login', 'Please run /help')), false);
    assert.equal(providerLoginRequired('claude', `${expiredPane(bullet)}\n❯ `), false);
  });

  test(`Claude: quoted incident text with ${bullet} is not an active login dialogue`, () => {
    const pane = expiredPane(bullet);
    for (const quoted of [
      `\`\`\`text\n${pane}\n\`\`\``,
      `~~~text\n${pane}\n~~~`,
      `${bullet} \`\`\`text\n${pane}\n\`\`\``,
      pane.split('\n').map(line => `> ${line}`).join('\n'),
      `❯ ${pane}`,
      `❯ Explain this capture:\n${pane.split('\n').map(line => `  ${line}`).join('\n')}`,
    ]) assert.equal(providerLoginRequired('claude', quoted), false, quoted);
  });
}

test('Claude: unsupported bullets and arbitrary prefixes cannot supply the expiry signature', () => {
  for (const prefix of ['✕', '×', '■', '○', '•', '-', 'Error:', 'assistant:']) {
    assert.equal(providerLoginRequired('claude', expiredPane(prefix)), false, prefix);
  }
});

test('Claude: an actual response after a multiline user message can require login', () => {
  assert.equal(providerLoginRequired('claude', `❯ Explain this capture:\n  harmless continuation\n${expiredPane()}`), true);
});

test('Claude: code fences in user input do not hide a subsequent real login widget', () => {
  for (const user of [
    '❯ ```text\n  harmless user text\n  ```',
    '❯ explain\n  ```text\n  harmless',
  ]) assert.equal(providerLoginRequired('claude', `${user}\n${expiredPane()}`), true);
});

test('Claude: quoted unprefixed compatibility text cannot supply an active login signature', () => {
  const pane = 'Login expired · Please run /login\nPaste code here if prompted >';
  for (const quoted of [`~~~text\n${pane}\n~~~`, `❯ Explain this capture:\n  ${pane.replace('\n', '\n  ')}`]) {
    assert.equal(providerLoginRequired('claude', quoted), false);
  }
  assert.equal(providerLoginRequired('claude', pane), true);
});
