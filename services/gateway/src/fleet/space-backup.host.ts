import { z } from 'zod';
import { SPACE_BACKUP_MAX_BYTES,SPACE_BACKUP_CHUNK_BYTES,SPACE_BACKUP_CHUNK_BASE64_BYTES,SpaceBackupClaimSchema,SpaceBackupHash,type SpaceBackupClaim } from '@cauce/store';
import type { SignedHostChannel } from './signed-source.js';
import { invokeSpaceBackupHelper,streamSpaceBackupHelper,type SpaceBackupHostConfig } from './space-backup.process.js';
import { backupFailure,SpaceBackupHelperError } from './space-backup.failure.js';
const Receipt=z.object({bytes:z.number().int().positive().max(SPACE_BACKUP_MAX_BYTES),sha256:SpaceBackupHash,manifest_sha256:SpaceBackupHash,
  metrics:z.object({peak_rss_kib:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict().optional()}).strict();
const Chunk=z.object({offset:z.number().int().nonnegative().max(SPACE_BACKUP_MAX_BYTES),data:z.string().min(4).max(SPACE_BACKUP_CHUNK_BASE64_BYTES)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/u).refine(value=>value.length%4===0&&Buffer.byteLength(value,'base64')<=SPACE_BACKUP_CHUNK_BYTES)}).strict();
const Offset=z.object({offset:z.number().int().nonnegative().max(SPACE_BACKUP_MAX_BYTES)}).strict();
const Limit=z.object({error:z.literal('LIMIT_EXCEEDED')}).strict();
const InsufficientSpace=z.object({error:z.literal('INSUFFICIENT_SPACE')}).strict();
export class SpaceBackupLimitError extends Error {}
interface SpaceBackupHostChannel {identity:Pick<SignedHostChannel['identity'],'host_id'|'company_id'>;request:SignedHostChannel['request']}
export class SpaceBackupHost {
  private active:Promise<boolean>|undefined;
  constructor(private readonly channel:SpaceBackupHostChannel,private readonly config:SpaceBackupHostConfig,
    private readonly helper=invokeSpaceBackupHelper,private readonly stream=streamSpaceBackupHelper) {}
  runOnce(signal:AbortSignal):Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    this.active??=this.turn(signal).finally(()=>{this.active=undefined;});return this.active;
  }
  private command(action:string,payload:Record<string,unknown>={},signal?:AbortSignal) {
    return this.channel.request('POST',`/v3/fleet/hosts/${this.channel.identity.host_id}/space-backups`,{action,...payload},signal);
  }
  private async turn(parent:AbortSignal):Promise<boolean> {
    const claim=z.object({claim:SpaceBackupClaimSchema.nullable()}).strict().parse(await this.command('claim')).claim;
    if (!claim) return false;
    if (claim.host_id!==this.channel.identity.host_id||claim.company_id!==this.channel.identity.company_id) throw new Error('Space backup host claim differs');
    const fence={id:claim.id,claim_token:claim.claim_token,claim_epoch:claim.claim_epoch};
    const abort=new AbortController();const stop=()=>{abort.abort();};parent.addEventListener('abort',stop,{once:true});if(parent.aborted) stop();
    let renewal:Promise<void>|undefined;let stopped=false;
    const timer=setInterval(()=>{renewal??=(async()=>{
      z.object({renewed:z.literal(true)}).strict().parse(await this.command('renew',{claim:fence},abort.signal));
    })().catch(()=>{abort.abort();}).finally(()=>{renewal=undefined;});},15_000);
    timer.unref();
    const drain=async()=>{if(stopped) return;stopped=true;clearInterval(timer);await renewal;parent.removeEventListener('abort',stop);};
    let completed=false;
    try {
      await this.upload(claim,fence,abort.signal);
      if (abort.signal.aborted) throw new Error('Space backup lease stopped');
      z.object({ready:z.literal(true)}).strict().parse(await this.command('finish',{claim:fence},abort.signal));completed=true;
    } catch(error) {
      await drain();abort.abort();
      if (!parent.aborted) {
        const failure=backupFailure(error);const code=error instanceof SpaceBackupLimitError?'LIMIT_EXCEEDED':'EXPORT_FAILED';
        console.error(JSON.stringify({event:'space_backup_failure',component:'backup',id:claim.id,
          host_id:claim.host_id,error:code,failure}));
        await this.command('fail',{claim:fence,error:code,failure}).catch(()=>undefined);
      }
    } finally {
      await drain();
      if (completed||!parent.aborted) await this.helper(this.config,{action:'remove',claim},new AbortController().signal).catch(()=>undefined);
    }
    return true;
  }
  private async upload(claim:SpaceBackupClaim,fence:Record<string,unknown>,signal:AbortSignal):Promise<void> {
    const raw=await this.helper(this.config,{action:'export',claim},signal);
    if (Limit.safeParse(raw).success) throw new SpaceBackupLimitError('Space backup exceeds its limit');
    const {metrics,...receipt}=Receipt.parse(raw);
    console.info(JSON.stringify({event:'space_backup_metrics',component:'backup',backup_id:claim.id,
      ...(metrics===undefined?{}:{python_peak_rss_kib:metrics.peak_rss_kib}),node_max_rss_kib:process.resourceUsage().maxRSS}));
    const begun=await this.command('begin',{claim:fence,...receipt},signal);
    if (InsufficientSpace.safeParse(begun).success) throw new SpaceBackupHelperError({type:'OSError',
      message:'INSUFFICIENT_SPACE: insufficient free space in gateway backup storage for this copy and concurrent uploads',stage:'worker'});
    let offset=Offset.parse(begun).offset;
    if (offset>receipt.bytes) throw new Error('Space backup upload offset differs');
    await this.stream(this.config,{action:'read',claim,offset},receipt.bytes,signal,async rawChunk=>{
      if (signal.aborted) throw new Error('Space backup lease stopped');
      const chunk=Chunk.parse(rawChunk);const bytes=Buffer.byteLength(chunk.data,'base64');
      if(chunk.offset!==offset||bytes!==Math.min(SPACE_BACKUP_CHUNK_BYTES,receipt.bytes-offset)) throw new Error('Space backup helper chunk differs');
      const next=Offset.parse(await this.command('append',{claim:fence,...chunk},signal)).offset;
      if (next!==offset+bytes) throw new Error('Space backup durable upload offset differs');offset=next;return offset;
    });
  }
}
