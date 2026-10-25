import { randomUUID } from 'node:crypto';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { SPACE_BACKUP_CHUNK_BYTES,type SpaceBackupClaim } from '@cauce/store';
import { SpaceBackupHost } from './space-backup.host.js';
const claim=():SpaceBackupClaim=>({id:randomUUID(),claim_token:randomUUID(),claim_epoch:1,company_id:'north',tenant_id:'North',alias:'worker',host_id:'north-host',policy_sha256:'a'.repeat(64),
  agent_snapshot:{company_id:'north',tenant_id:'North',alias:'worker',runtime_key:'worker',host_id:'north-host',harness_id:'codex',runtime_mode:'native',
    container_name:'host:north-host',runtime_user:'dev',home_directory:'/home/dev',state_directory:'/home/dev/state/worker',systemd_user:'dev'}});
const config={python:'/usr/bin/python3',policyFile:'/private/policy.json',projectRoot:'/approved/release'};
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
function fixture(bytes=2*SPACE_BACKUP_CHUNK_BYTES+1) {
  const current=claim();const data=Buffer.alloc(bytes,90);const calls:Record<string,unknown>[]=[];
  const request=vi.fn(async(_method:'POST',_path:string,payload:Record<string,unknown>):Promise<unknown>=>{
    calls.push(payload);if(payload.action==='claim') return {claim:current};
    if(payload.action==='begin') return {offset:0};
    if(payload.action==='append') return {offset:Number(payload.offset)+Buffer.byteLength(String(payload.data),'base64')};
    if(payload.action==='renew') return {renewed:true};if(payload.action==='finish') return {ready:true};return {failed:true};
  });
  const helper=vi.fn(async(_config:typeof config,payload:Record<string,unknown>,_signal:AbortSignal):Promise<unknown>=>{
    if(payload.action==='export') return {bytes:data.length,sha256:'b'.repeat(64),manifest_sha256:'c'.repeat(64)};
    if(payload.action==='remove') return {removed:true};
    const offset=Number(payload.offset);return {offset,data:data.subarray(offset,offset+SPACE_BACKUP_CHUNK_BYTES).toString('base64')};
  });
  const stream=vi.fn(async(_config:typeof config,body:Record<string,unknown>,length:number,signal:AbortSignal,consume:(chunk:unknown)=>Promise<number>)=>{
    let offset=Number(body.offset);
    while(offset<length) offset=await consume(await helper(_config,{action:'read',claim:body.claim,offset},signal));
  });
  return {current,calls,request,helper,stream,worker:new SpaceBackupHost({identity:{host_id:'north-host',company_id:'north'},request},config,helper,stream)};
}
describe('signed space backup host worker',()=>{
  it('uploads bounded chunks and settles only after every durable offset',async()=>{
    const test=fixture();const pending=test.worker.runOnce(new AbortController().signal);
    expect(test.worker.runOnce(new AbortController().signal)).toBe(pending);expect(await pending).toBe(true);
    expect(test.calls.map(call=>call.action)).toEqual(['claim','begin','append','append','append','finish']);
    expect(test.calls.filter(call=>call.action==='append').map(call=>Buffer.byteLength(String(call.data),'base64'))).toEqual([SPACE_BACKUP_CHUNK_BYTES,SPACE_BACKUP_CHUNK_BYTES,1]);
    expect(test.stream).toHaveBeenCalledTimes(1);
    expect(test.helper.mock.calls.at(-1)?.[1].action).toBe('remove');
  });
  it('records explicit limit failure without uploading or settling an incomplete archive',async()=>{
    const test=fixture();test.helper.mockResolvedValueOnce({error:'LIMIT_EXCEEDED'});await test.worker.runOnce(new AbortController().signal);
    expect(test.calls).toMatchObject([{action:'claim'},{action:'fail',error:'LIMIT_EXCEEDED'}]);
  });
  it('logs optional export metrics without including them in the strict begin payload',async()=>{
    const logged=vi.spyOn(console,'info').mockImplementation(()=>undefined);const test=fixture(1);
    test.helper.mockResolvedValueOnce({bytes:1,sha256:'b'.repeat(64),manifest_sha256:'c'.repeat(64),metrics:{peak_rss_kib:12_345}});
    await test.worker.runOnce(new AbortController().signal);
    expect(test.calls.find(call=>call.action==='begin')).not.toHaveProperty('metrics');
    const event=logged.mock.calls.map(call=>JSON.parse(String(call[0])) as Record<string,unknown>).find(value=>value.event==='space_backup_metrics');
    expect(event).toMatchObject({event:'space_backup_metrics',backup_id:test.current.id,python_peak_rss_kib:12_345});
    expect(event?.node_max_rss_kib).toBeTypeOf('number');
  });
  it('exposes insufficient gateway space before reading or appending the first byte',async()=>{
    const test=fixture(1);test.request.mockImplementation(async(_method,_path,payload)=>{
      test.calls.push(payload);if(payload.action==='claim') return {claim:test.current};
      if(payload.action==='begin') return {error:'INSUFFICIENT_SPACE'};return {failed:true};
    });
    await test.worker.runOnce(new AbortController().signal);
    expect(test.calls.map(call=>call.action)).toEqual(['claim','begin','fail']);
    expect(test.calls.at(-1)).toMatchObject({error:'EXPORT_FAILED',failure:{type:'OSError'}});
    expect((test.calls.at(-1)?.failure as Record<string,unknown>).message).toContain('INSUFFICIENT_SPACE');
    expect(test.helper.mock.calls.map(call=>call[1].action)).toEqual(['export','remove']);
  });
  it('keeps renewing during slow finish and propagates shutdown to its HTTP request',async()=>{
    vi.useFakeTimers();const test=fixture(1);const abort=new AbortController();let finishing:AbortSignal|undefined;
    const original=test.request.getMockImplementation();if(!original) throw new Error('fixture absent');
    test.request.mockImplementation(async(method,path,payload,signal?:AbortSignal)=>{
      if(payload.action!=='finish') return original(method,path,payload);
      test.calls.push(payload);finishing=signal;
      return new Promise((_resolve,reject)=>{signal?.addEventListener('abort',()=>{reject(new Error('shutdown'));},{once:true});});
    });
    const pending=test.worker.runOnce(abort.signal);await vi.advanceTimersByTimeAsync(45_000);
    expect(finishing?.aborted).toBe(false);expect(test.calls.filter(call=>call.action==='renew')).toHaveLength(3);
    abort.abort();expect(await pending).toBe(true);expect(finishing?.aborted).toBe(true);
    expect(test.calls.some(call=>call.action==='fail')).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);expect(test.calls.filter(call=>call.action==='renew')).toHaveLength(3);
  });
  it('rejects wrong offsets and foreign signed claim scope before ready',async()=>{
    const test=fixture();test.helper.mockImplementationOnce(async()=>({bytes:1,sha256:'b'.repeat(64),manifest_sha256:'c'.repeat(64)}))
      .mockImplementationOnce(async()=>({offset:1,data:'Wg=='}));
    await test.worker.runOnce(new AbortController().signal);expect(test.calls.at(-1)).toMatchObject({action:'fail',error:'EXPORT_FAILED'});
    const foreign=fixture();foreign.current.company_id='other';await expect(foreign.worker.runOnce(new AbortController().signal)).rejects.toThrow('differs');
    expect(foreign.helper).not.toHaveBeenCalled();
  });
  it('drains renewal and aborts an active helper when its durable fence is rejected',async()=>{
    vi.useFakeTimers();const test=fixture();let rejectHelper:((reason?:unknown)=>void)|undefined;
    test.helper.mockImplementationOnce((_config,_payload,signal)=>new Promise((_resolve,reject)=>{rejectHelper=reject;signal.addEventListener('abort',()=>{reject(new Error('aborted'));},{once:true});}));
    test.request.mockImplementation(async(_method,_path,payload)=>{test.calls.push(payload);if(payload.action==='claim') return {claim:test.current};if(payload.action==='renew') throw new Error('lease replaced');return {failed:true};});
    const pending=test.worker.runOnce(new AbortController().signal);await vi.advanceTimersByTimeAsync(15_000);
    expect(rejectHelper).toBeDefined();expect(await pending).toBe(true);expect(test.calls.map(call=>call.action)).toEqual(['claim','renew','fail']);
    await vi.advanceTimersByTimeAsync(60_000);expect(test.calls.filter(call=>call.action==='renew')).toHaveLength(1);
  });
  it('never publishes ready when the final stream binding or policy check fails after the last append',async()=>{
    const test=fixture(1);test.stream.mockImplementationOnce(async(_config,_body,_bytes,_signal,consume)=>{
      await consume({offset:0,data:'Wg=='});throw new Error('space backup policy changed before final receipt');
    });
    await test.worker.runOnce(new AbortController().signal);
    expect(test.calls.map(call=>call.action)).toEqual(['claim','begin','append','fail']);
    expect(test.calls.at(-1)).toMatchObject({error:'EXPORT_FAILED'});
  });
  it('aborts the persistent reader when a renewal loses its fence',async()=>{
    vi.useFakeTimers();const test=fixture(1);let reading:AbortSignal|undefined;
    test.stream.mockImplementationOnce(async(_config,_body,_bytes,signal)=>new Promise((_resolve,reject)=>{
      reading=signal;signal.addEventListener('abort',()=>{reject(new Error('lease lost'));},{once:true});
    }));
    const original=test.request.getMockImplementation();if(!original) throw new Error('fixture absent');
    test.request.mockImplementation(async(method,path,payload)=>{if(payload.action==='renew') throw new Error('fence replaced');return original(method,path,payload);});
    const pending=test.worker.runOnce(new AbortController().signal);await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toBe(true);expect(reading?.aborted).toBe(true);
    expect(test.calls.map(call=>call.action)).toEqual(['claim','begin','fail']);
  });
  it('does not claim after shutdown and never marks a cancelled export failed',async()=>{
    const test=fixture();const stopped=new AbortController();stopped.abort();expect(await test.worker.runOnce(stopped.signal)).toBe(false);
    expect(test.request).not.toHaveBeenCalled();
    const abort=new AbortController();test.helper.mockImplementationOnce(async()=>{abort.abort();throw new Error('stopped');});
    await test.worker.runOnce(abort.signal);expect(test.calls.map(call=>call.action)).toEqual(['claim']);
  });
});
