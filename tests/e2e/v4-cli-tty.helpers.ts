import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect } from 'vitest';
import type { startPlatformAdminFixture } from './v4-cli-platform-admin.helpers.js';

type PlatformFixture = Awaited<ReturnType<typeof startPlatformAdminFixture>>;
export interface TtyResult { code: number; output: string; prompt_seen: boolean; answer_sent: boolean; tty_verified: boolean }
const root = resolve(import.meta.dirname, '../..');
const terminalDriver = String.raw`
import errno,json,os,pty,select,signal,sys,time
command=json.loads(sys.argv[1])
answer=sys.argv[2].encode()+b'\n'
marker=b'CAUCE_E2E_REAL_TTY\r\n'
pid,master=pty.fork()
if pid==0:
    if not all(os.isatty(fd) for fd in (0,1,2)):
        os._exit(97)
    os.write(1,b'CAUCE_E2E_REAL_TTY\n')
    os.execvpe(command[0],command,os.environ)
output=bytearray()
sent=False
status=None
expires=time.monotonic()+50
try:
    while True:
        if time.monotonic()>expires:
            raise TimeoutError('real TTY command exceeded its deadline')
        ready,_,_=select.select([master],[],[],0.05)
        if ready:
            try:
                data=os.read(master,65536)
            except OSError as error:
                if error.errno==errno.EIO:
                    break
                raise
            if not data:
                break
            output.extend(data)
            if not sent and 'Escribí su id para confirmar: '.encode() in output:
                os.write(master,answer)
                sent=True
        if status is None:
            finished,current=os.waitpid(pid,os.WNOHANG)
            if finished:
                status=current
    if status is None:
        _,status=os.waitpid(pid,0)
    text=output.decode('utf-8','replace')
    print(json.dumps({'code':os.waitstatus_to_exitcode(status),'output':text,
        'prompt_seen':'Escribí su id para confirmar: ' in text,'answer_sent':sent,
        'tty_verified':marker in output}))
finally:
    if status is None:
        try:
            os.killpg(pid,signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid,0)
    os.close(master)
`;

export async function runPlatformTty(fixture: PlatformFixture, args: string[], answer: string): Promise<TtyResult> {
  if (args.includes('--si')) throw new Error('interactive confirmation must not use --si');
  const command = ['bash', join(root, 'ops/cli/cauce'), 'platform', ...args];
  const response = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn('python3', ['-I', '-B', '-c', terminalDriver, JSON.stringify(command), answer], {
      cwd: root, env: { PATH: process.env.PATH, HOME: fixture.directory, CAUCE_PROJECT_ROOT: root, NODE_ENV: 'test',
        DATABASE_URL_FILE: fixture.databaseFile, CAUCE_PLATFORM_ADMIN_ID: fixture.actor }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = ''; let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 65_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', () => { clearTimeout(timer); reject(new Error('real TTY driver did not start')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (expired) reject(new Error('real TTY driver exceeded its deadline'));
      else resolveResult({ code, stdout, stderr });
    });
  });
  const session = JSON.parse(await readFile(join(fixture.directory, 'operator.session'), 'utf8')) as { cookie: string; csrf_token: string };
  const secrets = [fixture.password, (await readFile(fixture.databaseFile, 'utf8')).trim(), session.cookie, session.csrf_token];
  expect(secrets.some(secret => (response.stdout + response.stderr).includes(secret)), 'TTY exposed private fixture material').toBe(false);
  expect(response.code, response.stderr).toBe(0);
  const result = JSON.parse(response.stdout) as TtyResult;
  expect(result.tty_verified).toBe(true); expect(result.prompt_seen).toBe(true); expect(result.answer_sent).toBe(true);
  return result;
}
