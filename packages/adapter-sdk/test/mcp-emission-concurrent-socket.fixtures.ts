import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EmissionRuntime } from "../src/sdk/mcp-emission/runtime.js";
import { SpawnCommandRunner } from "../src/sdk/process-runner.js";
import type { EmissionGateway } from "../src/sdk/mcp-emission/tools.js";
import { renewableDelivery, waitUntil } from "./client-fixtures.js";

export const CHILD = `
import {readFileSync} from 'node:fs';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {Client} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"))};
import {StdioClientTransport} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/stdio.js"))};
const stdin=readFileSync(0,'utf8');let input;
try{input=JSON.parse(stdin);}catch{
 const label=stdin.includes('socket-case-A')?'A':'B';
 input={label,reply:'own-'+label,socket:process.argv[1],ready:join(process.argv[2],label+'.ready'),go:join(process.argv[2],label+'.go'),engine:true};
}
const client=new Client({name:'own-dummy-'+input.label,version:'1.0.0'});
const endpoint=process.env.CAUCE_EMISSION_SOCKET_PATH;
const transport=new StdioClientTransport({command:process.execPath,args:[${JSON.stringify(fileURLToPath(new URL("../src/bin/cauce-mcp.js", import.meta.url)))},input.socket],stderr:'pipe',
 ...(endpoint===undefined?{}:{env:{CAUCE_EMISSION_SOCKET_PATH:endpoint}})});
process.once('SIGTERM',()=>{void client.close().then(()=>{process.exit(0);});});
try{
 await client.connect(transport);
 await writeFile(input.ready+'.tmp',JSON.stringify({pid:process.pid,mcpPid:transport.pid,endpoint:endpoint??null}));
 await rename(input.ready+'.tmp',input.ready);
 const deadline=Date.now()+10000;
 while(true){try{await readFile(input.go);break;}catch{if(Date.now()>deadline)throw Error('Own barrier timed out');await new Promise(r=>setTimeout(r,5));}}
 const result=await client.callTool({name:'cauce_reply',arguments:{reply:input.reply,status:'done',retryable:false}});
 if(input.engine)process.stdout.write('damaged-final-text');
 else process.stdout.write(JSON.stringify({isError:result.isError===true}));
}finally{await client.close();}
`;

export async function socketFixture(gateway: EmissionGateway = async () => ({ ok: true }), identity?: { tenant: string; room: string; alias: string }) {
  const directory = await mkdtemp(join(tmpdir(), "cauce-scope-"));
  const runtime = new EmissionRuntime(directory, "own-scope-instance", gateway, undefined, identity);
  await runtime.listen();
  const runs: Promise<unknown>[] = [];
  const controllers: AbortController[] = [];
  const runner = new SpawnCommandRunner();
  const identities: { pid: number; mcpPid: number }[] = [];
  return { directory, runtime, runner,
    begin: (label: string, suffix: string, isCurrent = () => true) => {
      const controller = new AbortController(); controllers.push(controller);
      const delivery = renewableDelivery(label, suffix, Date.now() + 60_000);
      const turn = runtime.begin({ delivery, signal: controller.signal, isCurrent,
        context: { self_alias: "argos", sender_alias: "operator", tenant_id: "Steven", room_id: "grp.steven",
          channel: "console", agent_message: false, message_type: "request", routing_targets: [] } });
      turn.activate();
      return { turn, controller, delivery };
    },
    child: (label: string, endpoint?: string, signal?: AbortSignal) => {
      const stop = new AbortController(); controllers.push(stop);
      signal?.addEventListener("abort", () => { stop.abort(); }, { once: true });
      if (signal?.aborted === true) stop.abort();
      const input = { label, reply: `own-${label}`, socket: runtime.socketPath,
        ready: join(directory, `${label}.ready`), go: join(directory, `${label}.go`) };
      const running = runner.run({ command: process.execPath, args: ["--input-type=module", "-e", CHILD],
        harness: "fake", stdin: JSON.stringify(input), timeoutMs: 15_000, signal: stop.signal,
        ...(endpoint === undefined ? {} : { emissionSocketPath: endpoint }) });
      runs.push(running);
      return running;
    },
    ready: async (label: string) => {
      const path = join(directory, `${label}.ready`);
      await waitUntil(() => existsSync(path));
      const identity = JSON.parse(await readFile(path, "utf8")) as { pid: number; mcpPid: number; endpoint: string | null };
      identities.push(identity);
      return identity;
    },
    go: async (label: string) => { await writeFile(join(directory, `${label}.go`), "own-barrier"); },
    close: async () => {
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(runs);
      await runtime.close();
      for (const identity of identities) {
        for (const pid of [identity.pid, identity.mcpPid]) {
          assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
        }
      }
      await rm(directory, { recursive: true, force: true });
      await assert.rejects(stat(directory), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
      console.log(JSON.stringify({ ownedDirectoryAbsent: directory, ownedChildrenAbsent: identities.map(({ pid, mcpPid }) => ({ pid, mcpPid })) }));
    },
  };
}
