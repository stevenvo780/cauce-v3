import { randomUUID } from 'node:crypto';
import { appendFile, chmod, link, mkdir, readFile, rename, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const argv = process.argv.slice(2);
let [harness, sid, mode = 'valid'] = argv;
if (harness.startsWith('adapter-')) {
  harness = harness.slice('adapter-'.length);
  const index = harness === 'claude' ? argv.findIndex((value) => value === '--session-id' || value === '--resume') : argv.indexOf('resume') + 1;
  sid = harness === 'claude' ? argv[index + 1] : index > 0 ? argv[index + 1] : randomUUID();
  mode = 'valid';
}
let input = '';
for await (const chunk of process.stdin) input += chunk;
const session = mode === 'wrong-sid' ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : sid;
const answer = mode === 'plain' ? 'native final' : JSON.stringify({ reply: 'native final', summary: 'native final', status: 'done', retryable: false, artifacts: [] });
const final = mode === 'wrong-final' ? JSON.stringify({ reply: 'foreign final', summary: 'foreign final', status: 'done', retryable: false, artifacts: [] }) : answer;
const config = harness === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
const directory = harness === 'claude' ? join(config, 'projects', process.cwd().replace(/\//gu, '-'))
  : join(config, 'sessions', '2026', '10', '06');
await mkdir(directory, { recursive: true, mode: 0o700 });
let file = join(directory, harness === 'claude' ? `${session}.jsonl` : `rollout-native-${session}.jsonl`);
if (mode === 'move-session') {
  await rename(file, `${file}.old`);
  file = join(directory, `rollout-relocated-${session}.jsonl`);
}
let before = '';
try { before = await readFile(file, 'utf8'); } catch { /* First native turn. */ }
const previous = before.split('\n').filter(Boolean).map((line) => JSON.parse(line));
const oldTurn = harness === 'claude' ? previous.find((entry) => entry.type === 'user')?.uuid
  : previous.find((entry) => entry.type === 'response_item')?.payload?.internal_chat_message_metadata_passthrough?.turn_id;
const turn = mode === 'replay-turn' ? oldTurn : randomUUID();
const prompt = mode === 'wrong-input' ? `${input}!` : mode === 'whitespace-input' ? `${input}\n` : input;
let entries;
if (harness === 'claude') {
  entries = [{ type: 'user', uuid: turn, sessionId: session, cwd: process.cwd(), message: { content: prompt } },
    { type: 'assistant', uuid: randomUUID(), parentUuid: mode === 'wrong-parent' ? randomUUID() : turn,
      sessionId: session, message: { stop_reason: mode === 'incomplete' ? 'tool_use' : 'end_turn', content: final } }];
} else {
  entries = [...(before ? [] : [{ type: 'session_meta', payload: { id: session,
    cwd: mode === 'wrong-workspace' ? '/foreign' : process.cwd(), source: mode === 'wrong-source' ? 'cli' : 'exec' } }]),
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }],
      internal_chat_message_metadata_passthrough: { turn_id: turn } } },
    { type: 'event_msg', payload: { type: mode === 'incomplete' ? 'task_started' : 'task_complete',
      turn_id: mode === 'wrong-parent' ? randomUUID() : turn, last_agent_message: final } }];
}
const body = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
if (mode === 'replace-config') { await rename(config, `${config}.old`); await mkdir(directory, { recursive: true, mode: 0o700 }); await writeFile(file, before + body, { mode: 0o600 }); }
else if (mode === 'replace-directory') { await rename(directory, `${directory}.old`); await mkdir(directory, { mode: 0o700 }); await writeFile(file, before + body, { mode: 0o600 }); }
else if (mode === 'replace-prefix') await writeFile(file, body, { mode: 0o600 });
else if (mode === 'replace-inode') { await rename(file, `${file}.old`); await writeFile(file, before + body, { mode: 0o600 }); }
else if (mode === 'symlink') { await writeFile(`${file}.target`, body, { mode: 0o600 }); await symlink(`${file}.target`, file); }
else if (mode !== 'no-file' && mode !== 'replay-only') await appendFile(file, body, { mode: 0o600 });
if (mode === 'hardlink') await link(file, `${file}.alias`);
if (mode === 'partial') await appendFile(file, '{"type":');
if (mode === 'unsafe-mode') await chmod(file, 0o666);
if (mode === 'oversize') await truncate(file, 33 * 1024 * 1024);
const stdoutSid = mode === 'wrong-sid' ? sid : session;
const stdout = harness === 'claude' ? JSON.stringify({ session_id: stdoutSid, result: answer })
  : JSON.stringify({ type: 'thread.started', thread_id: stdoutSid }) + '\n'
    + JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: answer } });
process.stdout.write(stdout + '\n');
if (mode === 'nonzero') process.exitCode = 1;
if (mode === 'hang') setTimeout(() => {}, 30_000);
