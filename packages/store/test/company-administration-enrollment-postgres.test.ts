import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deleteFleetHost, HostEnrollmentRepository, hostEnrollmentMessage, hostRequestMessage, lockCompanyAuthority,
  readCompanyPreferences, registerCompany, setCompanyAdmin, withTransaction, writeCompanyPreferences,
  type CompanyAuthoritySource, type DatabasePool, type HostInvitation, type RegisteredCompany } from '../src/index.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { hashPassword } from '../../../services/gateway/src/password.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
let north: RegisteredCompany;
let south: RegisteredCompany;
let hash: string;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); },120_000);
beforeAll(async () => { hash = await hashPassword('Admin and enrollment fixture'); });
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool=current.pool; admin=current.adminPool;
  north=await registerCompany(pool,{email:'north@example.test',name:'North',passwordHash:hash,company:{slug:'north',name:'North'}});
  south=await registerCompany(pool,{email:'south@example.test',name:'South',passwordHash:hash,company:{slug:'south',name:'South'}});
});
afterEach(async () => { await current?.close(); current=undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
const source=(company:RegisteredCompany,humanId=company.user.id):CompanyAuthoritySource=>client=>lockCompanyAuthority(client,
  {tenant:company.hub.id,alias:'owner',humanId});
async function person(company:RegisteredCompany,alias='owner'):Promise<string> {
  const id=randomUUID(); const email=`${id}@example.test`;
  await admin.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES($1,$2,$2,$3,'New operator','operator',$4,$5)`,[id,email,hash,company.hub.id,alias]);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
    VALUES($1,$2,$3,'operator',ARRAY['read','control'])`,[id,company.hub.id,alias]); return id;
}
function keys() { const pair=generateKeyPairSync('ed25519'); return {...pair,encoded:pair.publicKey.export({format:'der',type:'spki'}).toString('base64')}; }
function claim(invitation:HostInvitation,pair:ReturnType<typeof keys>) {
  return {invitation_token:invitation.invitation_token,public_key:pair.encoded,
    proof:sign(null,Buffer.from(hostEnrollmentMessage(invitation)),pair.privateKey).toString('base64')};
}
function heartbeat(invitation:HostInvitation,pair:ReturnType<typeof keys>) {
  const packet={host_id:invitation.host_id,company_id:invitation.company_id,issued_at:Date.now(),nonce:randomBytes(32).toString('hex'),
    payload:{platform:'linux',cli_version:'test-real-signature',docker_version:null,status:'reachable' as const},proof:''};
  packet.proof=sign(null,Buffer.from(hostRequestMessage('POST',`/v3/fleet/hosts/${invitation.host_id}/heartbeat`,packet)),pair.privateKey).toString('base64');
  return packet;
}

describe('company administrators, personal quota preferences and outbound host identity',()=>{
  it('grants and revokes a company administrator with version control and denies cross-company escalation',async()=>{
    const id=await person(north);
    const grant=()=>withTransaction(pool,async client=>setCompanyAdmin(client,await source(north)(client),'north',
      {user_id:id,role:'admin',expected_version:0}));
    const raced=await Promise.allSettled([grant(),grant()]);
    expect(raced.filter(item=>item.status==='fulfilled')).toHaveLength(1);
    expect(raced.find(item=>item.status==='rejected')).toMatchObject({reason:{code:'conflict'}});
    expect(await withTransaction(pool,source(north,id))).toMatchObject({role:'company_admin'});
    await expect(grant()).rejects.toMatchObject({code:'conflict'});
    await expect(withTransaction(pool,async client=>setCompanyAdmin(client,await source(north)(client),'south',
      {user_id:south.user.id,role:'admin',expected_version:1}))).rejects.toMatchObject({code:'forbidden'});
    await expect(withTransaction(pool,async client=>setCompanyAdmin(client,await source(north)(client),'north',
      {user_id:id,role:'owner',expected_version:1}))).rejects.toMatchObject({code:'forbidden'});
    expect(await withTransaction(pool,async client=>setCompanyAdmin(client,await source(north)(client),'north',
      {user_id:id,role:null,expected_version:1}))).toMatchObject({role:null,version:2});
    expect(await withTransaction(pool,source(north,id))).toMatchObject({role:'tenant_operator'});
    expect(await grant()).toMatchObject({version:3});
    await expect(withTransaction(pool,async client=>setCompanyAdmin(client,await source(north)(client),'north',
      {user_id:id,role:null,expected_version:1}))).rejects.toMatchObject({code:'conflict'});
  });

  it('keeps personal pins within visible company accounts and preserves preferences across reloads',async()=>{
    for (const company of [north,south]) await admin.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,
      credential_ref_kind,credential_ref) VALUES($1,'codex',$1,$2,'env_path','CAUCE_TEST_ACCOUNT_PATH')`,[`${company.company.id}-account`,company.hub.id]);
    expect(await readCompanyPreferences(pool,source(north))).toEqual({version:0,pinned_quota_accounts:[]});
    const saved=await writeCompanyPreferences(pool,source(north),{expected_version:0,pinned_quota_accounts:['north-account']});
    expect(await readCompanyPreferences(pool,source(north))).toEqual(saved);
    expect(await readCompanyPreferences(pool,source(south))).toEqual({version:0,pinned_quota_accounts:[]});
    await expect(writeCompanyPreferences(pool,source(north),{expected_version:1,pinned_quota_accounts:['south-account']}))
      .rejects.toMatchObject({code:'forbidden'});
    await expect(writeCompanyPreferences(pool,source(north),{expected_version:0,pinned_quota_accounts:[]}))
      .rejects.toMatchObject({code:'conflict'});
  });

  it('enrols an uncatalogued computer using a new legitimate key and accepts a signed outbound heartbeat',async()=>{
    const repository=new HostEnrollmentRepository(pool); const pair=keys();
    const invitation=await repository.invite(source(north),{host_id:'north-new_laptop',display_name:'New laptop'});
    expect(invitation).toMatchObject({company_id:'north',host_id:'north-new_laptop',state:'pending'});
    const receipt=await repository.claim(invitation.enrollment_id,claim(invitation,pair));
    expect(receipt).toMatchObject({host_id:'north-new_laptop',company_id:'north',state:'enrolled',executor_ready:false});
    expect((await pool.query('SELECT public_key FROM fleet_host_identities WHERE host_id=$1',['north-new_laptop'])).rows)
      .toEqual([{public_key:pair.encoded}]);
    const packet=heartbeat(invitation,pair);
    expect(await repository.heartbeat('north-new_laptop',packet)).toEqual({host_id:'north-new_laptop',company_id:'north',accepted:true});
    expect((await pool.query("SELECT controller_status FROM fleet_hosts WHERE host_id='north-new_laptop'")).rows)
      .toEqual([{controller_status:'reachable'}]);
    await expect(repository.heartbeat('north-new_laptop',packet)).rejects.toMatchObject({code:'conflict'});
    expect(await repository.claim(invitation.enrollment_id,claim(invitation,pair))).toEqual(receipt);
    await admin.query("UPDATE fleet_host_enrollments SET expires_at=now()-interval '1 second' WHERE id=$1",[invitation.enrollment_id]);
    expect(await repository.claim(invitation.enrollment_id,claim(invitation,pair))).toEqual(receipt);
    await expect(repository.claim(invitation.enrollment_id,claim(invitation,keys()))).rejects.toMatchObject({code:'forbidden'});
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='fleet_host.enrollment.claim' AND metadata->>'host_id'='north-new_laptop'")).rows)
      .toEqual([{n:1}]);
  });

  it('answers a computer of another company exactly like an absent one: each company names only its own partition',async()=>{
    const repository=new HostEnrollmentRepository(pool);
    const registered=await repository.invite(source(north),{host_id:'north-shared',display_name:'Shared'});
    await repository.claim(registered.enrollment_id,claim(registered,keys()));
    await repository.invite(source(north),{host_id:'north-pending',display_name:'Pending'});
    const outside={code:'forbidden',message:'host id must be south-<name>, with lowercase letters, digits or underscores in the name'};
    for (const host_id of ['north-shared','north-pending','north-absent','shared','south-two-parts']) {
      await expect(repository.invite(source(south),{host_id,display_name:'Probe'})).rejects.toMatchObject(outside);
    }
    expect(await repository.invite(source(south),{host_id:'south-shared',display_name:'Own'})).toMatchObject({company_id:'south',state:'pending'});
    expect((await admin.query("SELECT host_id,state FROM fleet_host_enrollments WHERE company_id='north' ORDER BY host_id")).rows)
      .toEqual([{host_id:'north-pending',state:'pending'},{host_id:'north-shared',state:'enrolled'}]);
    await admin.query('INSERT INTO platform_admins(human_id) VALUES($1)',[south.user.id]);
    expect(await repository.invite(source(south),{host_id:'legacy-host',display_name:'Platform'})).toMatchObject({host_id:'legacy-host',state:'pending'});
  });

  it('rejects a forged key, modified scope, expired challenge and reused signed request without consuming valid proof',async()=>{
    const repository=new HostEnrollmentRepository(pool); const legitimate=keys(); const attacker=keys();
    const invitation=await repository.invite(source(north),{host_id:'north-private_laptop',display_name:'Private laptop'});
    await expect(repository.claim(invitation.enrollment_id,{...claim(invitation,attacker),public_key:legitimate.encoded}))
      .rejects.toMatchObject({code:'forbidden'});
    await repository.claim(invitation.enrollment_id,claim(invitation,legitimate));
    const packet=heartbeat(invitation,legitimate);
    await expect(repository.heartbeat(invitation.host_id,{...packet,company_id:'south'})).rejects.toMatchObject({code:'forbidden'});
    await expect(repository.heartbeat(invitation.host_id,{...packet,issued_at:Date.now()-180_000})).rejects.toMatchObject({code:'forbidden'});
    expect(await repository.heartbeat(invitation.host_id,packet)).toMatchObject({accepted:true});
    const expired=await repository.invite(source(south),{host_id:'south-expired_laptop',display_name:'Expired'});
    await admin.query('UPDATE fleet_host_enrollments SET expires_at=now()-interval \'1 second\' WHERE id=$1',[expired.enrollment_id]);
    await expect(repository.claim(expired.enrollment_id,claim(expired,keys()))).rejects.toMatchObject({code:'conflict'});
  });

  it('fences simultaneous claims and revokes the identity when its empty computer is removed',async()=>{
    const repository=new HostEnrollmentRepository(pool); const pair=keys();
    const invitation=await repository.invite(source(north),{host_id:'north-race_laptop',display_name:'Race'});
    const result=await Promise.allSettled([1,2].map(()=>repository.claim(invitation.enrollment_id,claim(invitation,pair))));
    expect(result.filter(item=>item.status==='fulfilled')).toHaveLength(2);
    expect((await pool.query("SELECT count(*)::int AS n FROM fleet_host_identities WHERE host_id='north-race_laptop'")).rows).toEqual([{n:1}]);
    await expect(deleteFleetHost(pool,'north-race_laptop',1,{authority:source(north),approvedHostIds:[]})).rejects.toMatchObject({code:'forbidden'});
    await admin.query('INSERT INTO platform_admins(human_id) VALUES($1)',[south.user.id]);
    await expect(deleteFleetHost(pool,'north-race_laptop',1,{authority:source(south),approvedHostIds:[]})).rejects.toMatchObject({code:'not_found'});
    await deleteFleetHost(pool,'north-race_laptop',1,{authority:client=>lockCompanyAuthority(client,
      {tenant:south.hub.id,alias:'owner',humanId:south.user.id,requestedCompany:'north'}),approvedHostIds:[]});
    expect((await pool.query("SELECT host_id FROM fleet_host_identities WHERE host_id='north-race_laptop'")).rows).toEqual([]);
    await expect(repository.heartbeat(invitation.host_id,heartbeat(invitation,pair))).rejects.toMatchObject({code:'forbidden'});
  });

  it('revokes pending invitations within the company and refuses reusing a host key without partial enrollment',async()=>{
    const repository=new HostEnrollmentRepository(pool); const pair=keys();
    const first=await repository.invite(source(north),{host_id:'north-first_laptop',display_name:'First'});
    await repository.claim(first.enrollment_id,claim(first,pair));
    const second=await repository.invite(source(north),{host_id:'north-second_laptop',display_name:'Second'});
    const alternateEncoding=Buffer.concat([Buffer.from(pair.encoded,'base64'),Buffer.from([0])]).toString('base64');
    await expect(repository.claim(second.enrollment_id,{...claim(second,pair),public_key:alternateEncoding}))
      .rejects.toMatchObject({code:'invalid_input'});
    await expect(repository.claim(second.enrollment_id,claim(second,pair))).rejects.toMatchObject({code:'conflict'});
    expect((await pool.query("SELECT host_id FROM fleet_hosts WHERE host_id='north-second_laptop'")).rows).toEqual([]);
    await expect(repository.revoke(source(south),second.enrollment_id)).rejects.toMatchObject({code:'not_found'});
    expect(await repository.revoke(source(north),second.enrollment_id)).toEqual({enrollment_id:second.enrollment_id,state:'revoked'});
    await expect(repository.claim(second.enrollment_id,claim(second,keys()))).rejects.toMatchObject({code:'conflict'});
    expect((await repository.invite(source(north),{host_id:'north-second_laptop',display_name:'Retry'})).state).toBe('pending');
  });

  it('refuses removing the last qualified owner while another owner lacks durable room control',async()=>{
    await admin.query('INSERT INTO platform_admins(human_id) VALUES($1)',[south.user.id]);
    await admin.query(`INSERT INTO agents(tenant_id,alias,company_id) VALUES($1,'other_owner','north')`,[north.hub.id]);
    await admin.query(`INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office','other_owner','operator')`,[north.hub.id]);
    const id=await person(north,'other_owner');
    await withTransaction(pool,async client=>setCompanyAdmin(client,await source(south)(client),'north',
      {user_id:id,role:'owner',expected_version:0}));
    await admin.query("UPDATE memberships SET role='agent' WHERE tenant_id=$1 AND alias='other_owner'",[north.hub.id]);
    await expect(withTransaction(pool,async client=>setCompanyAdmin(client,await source(south)(client),'north',
      {user_id:north.user.id,role:null,expected_version:1}))).rejects.toMatchObject({code:'conflict'});
    expect(await withTransaction(pool,source(north))).toMatchObject({role:'company_owner'});
  });

  it('revalidates invitation authority before accepting a legitimate host proof',async()=>{
    const id=await person(north);
    await withTransaction(pool,async client=>setCompanyAdmin(client,await source(north)(client),'north',
      {user_id:id,role:'admin',expected_version:0}));
    const repository=new HostEnrollmentRepository(pool); const pair=keys();
    const invitation=await repository.invite(source(north,id),{host_id:'north-revoked_laptop',display_name:'Revoked'});
    await withTransaction(pool,async client=>setCompanyAdmin(client,await source(north)(client),'north',
      {user_id:id,role:null,expected_version:1}));
    await expect(repository.claim(invitation.enrollment_id,claim(invitation,pair))).rejects.toMatchObject({code:'forbidden'});
    expect((await pool.query("SELECT host_id FROM fleet_hosts WHERE host_id='north-revoked_laptop'")).rows).toEqual([]);
  });
});
