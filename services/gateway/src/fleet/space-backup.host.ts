import { z } from 'zod';
import { SPACE_BACKUP_MAX_BYTES,SPACE_BACKUP_CHUNK_BYTES,SpaceBackupClaimSchema,SpaceBackupHash,type SpaceBackupClaim } from '@cauce/store';
import type { SignedHostChannel } from './signed-source.js';
import { invokeSpaceBackupHelper,type SpaceBackupHostConfig } from './space-backup.process.js';
const Receipt=z.object({bytes:z.number().int().positive().max(SPACE_BACKUP_MAX_BYTES),sha256:SpaceBackupHash,manifest_sha256:SpaceBackupHash}).strict();
const Chunk=z.object({offset:z.number().int().nonnegative(),data:z.string().min(4).max(87_384)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)}).strict();
const Offset=z.object({offset:z.number().int().nonnegative().max(SPACE_BACKUP_MAX_BYTES)}).strict();
const Limit=z.object({error:z.literal('LIMIT_EXCEEDED')}).strict();
export class SpaceBackupLimitError extends Error {}
interface SpaceBackupHostChannel {identity:Pick<SignedHostChannel['identity'],'host_id'|'company_id'>;request:SignedHostChannel['request']}
export class SpaceBackupHost {
  private active:Promise<boolean>|undefined;
  constructor(private readonly channel:SpaceBackupHostChannel,private readonly config:SpaceBackupHostConfig,
    private readonly helper=invokeSpaceBackupHelper) {}
  runOnce(signal:AbortSignal):Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    this.active??=this.turn(signal).finally(()=>{this.active=undefined;});return this.active;
  }
  private command(action:string,payload:Record<string,unknown>={}) {
    return this.channel.request('POST',`/v3/fleet/hosts/${this.channel.identity.host_id}/space-backups`,{action,...payload});
  }
  private async turn(parent:AbortSignal):Promise<boolean> {
    const claim=z.object({claim:SpaceBackupClaimSchema.nullable()}).strict().parse(await this.command('claim')).claim;
    if (!claim) return false;
    if (claim.host_id!==this.channel.identity.host_id||claim.company_id!==this.channel.identity.company_id) throw new Error('Space backup host claim differs');
    const fence={id:claim.id,claim_token:claim.claim_token,claim_epoch:claim.claim_epoch};
    const abort=new AbortController();const stop=()=>{abort.abort();};parent.addEventListener('abort',stop,{once:true});if(parent.aborted) stop();
    let renewal:Promise<void>|undefined;let stopped=false;
    const timer=setInterval(()=>{renewal??=(async()=>{
      z.object({renewed:z.literal(true)}).strict().parse(await this.command('renew',{claim:fence}));
    })().catch(()=>{abort.abort();}).finally(()=>{renewal=undefined;});},15_000);
    timer.unref();
    const drain=async()=>{if(stopped) return;stopped=true;clearInterval(timer);await renewal;parent.removeEventListener('abort',stop);};
    let completed=false;
    try {
      await this.upload(claim,fence,abort.signal);
      await drain();if (abort.signal.aborted) throw new Error('Space backup lease stopped');
      z.object({ready:z.literal(true)}).strict().parse(await this.command('finish',{claim:fence}));completed=true;
    } catch(error) {
      await drain();abort.abort();
      if (!parent.aborted) await this.command('fail',{claim:fence,error:error instanceof SpaceBackupLimitError?'LIMIT_EXCEEDED':'EXPORT_FAILED'}).catch(()=>undefined);
    } finally {
      await drain();
      if (completed||!parent.aborted) await this.helper(this.config,{action:'remove',claim},new AbortController().signal).catch(()=>undefined);
    }
    return true;
  }
  private async upload(claim:SpaceBackupClaim,fence:Record<string,unknown>,signal:AbortSignal):Promise<void> {
    const raw=await this.helper(this.config,{action:'export',claim},signal);
    if (Limit.safeParse(raw).success) throw new SpaceBackupLimitError('Space backup exceeds its limit');
    const receipt=Receipt.parse(raw);let offset=Offset.parse(await this.command('begin',{claim:fence,...receipt})).offset;
    if (offset>receipt.bytes) throw new Error('Space backup upload offset differs');
    while(offset<receipt.bytes) {
      if (signal.aborted) throw new Error('Space backup lease stopped');
      const chunk=Chunk.parse(await this.helper(this.config,{action:'read',claim,offset},signal));const bytes=Buffer.byteLength(chunk.data,'base64');
      if(chunk.offset!==offset||bytes!==Math.min(SPACE_BACKUP_CHUNK_BYTES,receipt.bytes-offset)) throw new Error('Space backup helper chunk differs');
      const next=Offset.parse(await this.command('append',{claim:fence,...chunk})).offset;
      if (next!==offset+bytes) throw new Error('Space backup durable upload offset differs');offset=next;
    }
  }
}
