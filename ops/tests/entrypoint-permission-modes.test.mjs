import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const cli = await readFile(new URL('../cli/cauce', import.meta.url), 'utf8');

const claudeFlags = ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions'];

function hasClaudeBypass(command) {
  return claudeFlags.every((flag) => command.includes(flag));
}

function commands(source, binary) {
  return source.split('\n').filter((line) => line.includes(binary));
}

function between(source, start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end));
}

assert.equal(hasClaudeBypass('claude --dangerously-skip-permissions'), false);
assert.equal(hasClaudeBypass('claude --permission-mode bypassPermissions'), false);

const separate = between(cli, '# 2) conversacion aparte', '# 3) el adaptador esta parado');
const separateClaude = commands(separate, 'claude --dangerously-skip-permissions');
assert.equal(separateClaude.length, 1);
assert.equal(hasClaudeBypass(separateClaude[0]), true);

const separateCodex = commands(separate, 'codex --yolo');
assert.equal(separateCodex.length, 1);

process.stdout.write('entrypoint permission modes: OK\n');
