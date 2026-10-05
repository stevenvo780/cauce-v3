import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRunRequest } from '../src/sdk/types.js';

export const FRAME = '@cauce/openclaw-phase/v1 ';
export function phaseChild(mode: 'markers' | 'semantic' | 'final' | 'mixed' | 'invalid' | 'fragment' | 'oversize' | 'eof' | 'error'): string {
  const frame = FRAME + JSON.stringify({ phase: 'agent_cli_started', elapsedMs: 1, utc: '2026-10-04T00:00:00.000Z' }) + '\n';
  if (mode === 'final') return `process.stdout.write('{"result":{"reply":"fixture","status":"done"}}');setTimeout(()=>process.exit(0),450);`;
  if (mode === 'error') return `process.stderr.write(${JSON.stringify(frame)});process.exit(7);`;
  if (mode === 'eof') return `process.stderr.write(${JSON.stringify(FRAME + '{"secret":"dummy-secret"')});`;
  if (mode === 'mixed') return `process.stderr.write(${JSON.stringify('ordinary\n' + frame + 'tail\n')});`;
  if (mode === 'invalid') return `process.stderr.write(${JSON.stringify(FRAME + '{"phase":"bad","secret":"dummy-secret"}\n')});`;
  if (mode === 'oversize') return `process.stderr.write(${JSON.stringify(FRAME + 'x'.repeat(900) + '\n')});`;
  const emitted = mode === 'semantic' ? 'process.stdout.write("semantic\\n")' : mode === 'fragment'
    ? `const f=${JSON.stringify(frame)};process.stderr.write(f.slice(0,10));setTimeout(()=>process.stderr.write(f.slice(10)),5)`
    : `process.stderr.write(${JSON.stringify(frame)})`;
  return `const timer=setInterval(()=>{${emitted};},50);setTimeout(()=>{clearInterval(timer);process.exit(0)},650);`;
}
export function phaseRequest(mode: Parameters<typeof phaseChild>[0], overrides: Partial<CommandRunRequest> = {}): CommandRunRequest {
  return { command: process.execPath, args: ['--eval', phaseChild(mode)], harness: 'openclaw', stdin: '',
    timeoutMs: 220, timeoutKind: 'no-progress', signal: new AbortController().signal,
    openClawPhaseFrames: true, startWitness: { kind: 'stderr-marker', marker: '<<cauce:harness-started>>' }, ...overrides };
}

export const NATIVE_OUTPUT = { result: { payloads: [{ text: JSON.stringify({ reply: 'native fixture', messages: [], status: 'done', retryable: false, artifacts: [] }) }] }, status: 'ok' };
export async function nativeModules(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(directory, 'runtime-fixture.js'), 'export const defaultRuntime = {};');
  await writeFile(join(directory, 'agent-via-gateway-fixture.js'), `export async function agentCliCommand() {
    process.stdout.write(${JSON.stringify(JSON.stringify(NATIVE_OUTPUT))});
    await new Promise(resolve => setTimeout(resolve, 400));
  }`);
}
