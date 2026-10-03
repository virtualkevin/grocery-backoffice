import { Agent, GenericAdapter, type PlatformMessage } from '@band-ai/sdk';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { ROLE_IDS, type AgentEnvelope, type RoleId } from '../../shared/types.js';
import { IntegrationError, isEnvelope, safeError } from './safety.js';

export const BAND_ENV_PREFIX:Record<RoleId,string>={
  manager:'BAND','fruit-buyer':'BAND_FRUIT_BUYER','vegetable-buyer':'BAND_VEGETABLE_BUYER',
  'supplier-wholesale':'BAND_SUPPLIER_WHOLESALE','supplier-farm':'BAND_SUPPLIER_FARM',
  'supplier-organic':'BAND_SUPPLIER_ORGANIC','supplier-surplus':'BAND_SUPPLIER_SURPLUS',
  'supplier-fruit':'BAND_SUPPLIER_FRUIT','supplier-coop':'BAND_SUPPLIER_COOP',
  'supplier-import':'BAND_SUPPLIER_IMPORT','supplier-rapid':'BAND_SUPPLIER_RAPID',
};
type Identity={role:RoleId;id:string;key:string;handle:string;name:string;agent?:Agent;error?:string};
type Handler=(envelope:AgentEnvelope)=>Promise<void>|void;
type InboxRow={id:string;payload:string;attempts:number};
const quietLogger={debug(){},info(){},warn(){},error(){}};
const marker='GROCERY_ENVELOPE_V1\n';
const privateKeys=new Set(['floorCaseCents','targetCaseCents','minimumAcceptablePrice','desiredPrice','privateState','privateSuppliers','privateReasoning','supplierFloor']);
export function assertPublicEnvelope(value:unknown):void{
  if(Array.isArray(value)){for(const v of value)assertPublicEnvelope(v);return;}
  if(value&&typeof value==='object')for(const [key,v] of Object.entries(value)){
    if(privateKeys.has(key))throw new IntegrationError('private_payload_rejected','band');
    assertPublicEnvelope(v);
  }
}
export function decodeBandEnvelope(message:Pick<PlatformMessage,'content'>&Partial<Pick<PlatformMessage,'metadata'>>):AgentEnvelope|null{
  let candidate:unknown=message.metadata?.groceryEnvelope;
  if(!candidate){const i=message.content.indexOf(marker);if(i<0)return null;try{candidate=JSON.parse(message.content.slice(i+marker.length));}catch{return null;}}
  return isEnvelope(candidate)?candidate:null;
}
/** Band text-message endpoint accepts content + mentions, not custom metadata. */
export function encodeBandMessage(envelope:AgentEnvelope,recipient:{id:string;name:string;handle:string}){
  return {content:`@${recipient.handle.replace(/^@/,'')} ${marker}${JSON.stringify(envelope)}`,mentions:[{id:recipient.id,name:recipient.name,handle:recipient.handle}]};
}
export class BandTransport {
  private identities=new Map<RoleId,Identity>();
  private errors=new Map<RoleId,string>();
  private handlers=new Set<Handler>();
  private db:DatabaseSync;
  private rooms=new Map<string,string>();
  private allowedRooms=new Set<string>();
  private creatingRooms=new Map<string,Promise<string>>();
  private sending=new Map<string,Promise<{messageId:string;roomId:string;source:'live'}>>();
  private draining=new Set<string>();
  private cancelledRuns=new Set<string>();
  private started=false;
  private stopping=false;
  private sent=0;private received=0;private processed=0;private rejected=0;
  private recentFailures:Array<{stage:string;from:RoleId;to:RoleId;code:string;errorType:string}>=[];
  private recordFailure(stage:string,envelope:AgentEnvelope,error:unknown){
    const name=(error as {name?:unknown})?.name;
    this.recentFailures.push({stage,from:envelope.from,to:envelope.to,code:safeError(error,'band').code,errorType:typeof name==='string'&&/^[A-Za-z0-9_]{1,50}$/.test(name)?name:'unknown'});
    this.recentFailures=this.recentFailures.slice(-20);
  }
  constructor(){
    mkdirSync('data',{recursive:true});this.db=new DatabaseSync('data/integrations-band.sqlite');
    this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS rooms(pair_key TEXT PRIMARY KEY,room_id TEXT NOT NULL);CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,band_id TEXT NOT NULL,room_id TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,error TEXT);CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,room_id TEXT,payload TEXT NOT NULL,state TEXT NOT NULL,band_id TEXT,error TEXT);`);
    for(const row of this.db.prepare('SELECT pair_key,room_id FROM rooms').all() as Array<{pair_key:string;room_id:string}>){this.rooms.set(row.pair_key,row.room_id);this.allowedRooms.add(row.room_id);}
    this.db.prepare("UPDATE inbox SET state='received' WHERE state='processing'").run();
  }
  async start(){
    this.stopping=false;
    await Promise.all(ROLE_IDS.map(async role=>{
      if(this.identities.get(role)?.agent?.isRunning)return;
      const prefix=BAND_ENV_PREFIX[role],id=process.env[`${prefix}_AGENT_ID`],key=process.env[`${prefix}_API_KEY`];
      if(!id||!key){this.errors.set(role,'missing_credentials');return;}
      try{
        const response=await fetch('https://app.band.ai/api/v1/agent/me',{headers:{'X-API-Key':key},signal:AbortSignal.timeout(15_000)});
        if(!response.ok)throw new IntegrationError(`http_${response.status}`,'band');
        const {data}=await response.json() as {data:{id:string;handle:string;name:string}};
        if(data.id!==id)throw new IntegrationError('identity_mismatch','band');
        if([...this.identities.values()].some(x=>x.id===id&&x.role!==role))throw new IntegrationError('duplicate_identity','band');
        const identity:Identity={role,id,key,handle:data.handle,name:data.name};this.identities.set(role,identity);
        identity.agent=Agent.create({config:{agentId:id,apiKey:key},logger:quietLogger,
          sessionConfig:{enableContextHydration:false,maxMessageRetries:1},
          roomFilter:room=>typeof room.id==='string'&&this.allowedRooms.has(room.id),
          adapter:new GenericAdapter(async({message,roomId})=>{await this.receive(role,message,roomId);}),
        });
        await identity.agent.start();this.errors.delete(role);
      }catch(error){this.errors.set(role,safeError(error,'band').code);}
    }));
    this.started=true;this.drain();
  }
  onMessage(handler:Handler){this.handlers.add(handler);this.drain();return()=>this.handlers.delete(handler);}
  private async receive(role:RoleId,message:PlatformMessage,roomId:string){
    const envelope=decodeBandEnvelope(message);
    if(!envelope)return;
    const sender=this.identities.get(envelope.from);
    const pair=[envelope.from,envelope.to].sort().join(':');
    const expected=this.rooms.get(`${envelope.runId}:${pair}`);
    if(envelope.to!==role||sender?.id!==message.senderId||expected!==roomId){this.rejected++;return;}
    try{assertPublicEnvelope(envelope);}catch{this.rejected++;return;}
    const result=this.db.prepare("INSERT OR IGNORE INTO inbox(id,band_id,room_id,payload,state) VALUES(?,?,?,?,'received')").run(envelope.id,message.id,roomId,JSON.stringify(envelope));
    if(result.changes)this.received++;
    // The durable local inbox is the processing boundary; SDK callback never waits for a peer.
    this.drain();
  }
  private drain(){
    if(this.stopping||!this.handlers.size)return;
    const rows=this.db.prepare("SELECT id,payload,attempts FROM inbox WHERE state='received' LIMIT 100").all() as InboxRow[];
    for(const row of rows){
      if(this.draining.has(row.id))continue;this.draining.add(row.id);
      this.db.prepare("UPDATE inbox SET state='processing',attempts=attempts+1 WHERE id=?").run(row.id);
      setImmediate(async()=>{
        try{const envelope=JSON.parse(row.payload) as AgentEnvelope;for(const handler of this.handlers)await handler(envelope);this.db.prepare("UPDATE inbox SET state='processed' WHERE id=?").run(row.id);this.processed++;}
        catch(error){this.db.prepare("UPDATE inbox SET state='failed',error=? WHERE id=?").run(safeError(error,'band').code,row.id);}
        finally{this.draining.delete(row.id);}
      });
    }
  }
  private async room(envelope:AgentEnvelope):Promise<string>{
    const pair=[envelope.from,envelope.to].sort().join(':');const key=`${envelope.runId}:${pair}`;
    const pending=this.creatingRooms.get(key);if(pending)return pending;
    const found=this.rooms.get(key);if(found)return found;
    let stage='create_chat';
    const operation=(async()=>{
      const sender=this.identities.get(envelope.from)!,recipient=this.identities.get(envelope.to)!;
      const provisioner=this.identities.get('manager')!;
      const rest=provisioner.agent!.runtime.link.rest;
      const created=await rest.createChat();
      this.allowedRooms.add(created.id);
      stage='add_participant';
      for(const participant of [sender,recipient]){
        if(participant.id===provisioner.id)continue;
        const added=await rest.addChatParticipant(created.id,{participantId:participant.id,role:'member'});
        if(added.ok===false)throw new IntegrationError('participant_add_failed','band');
      }
      stage='verify_participants';const participants=await rest.listChatParticipants(created.id);
      if(!participants.some(p=>p.id===recipient.id)||!participants.some(p=>p.id===sender.id))throw new IntegrationError('room_membership_unverified','band');
      // Reconcile the real REST-created room into SDK admission. This closes the race where
      // room_added arrives before its allowed-room mapping is durably saved. No messages are fabricated.
      stage='subscribe_room';const now=new Date().toISOString();
      for(const identity of [sender,recipient]){
        identity.agent!.runtime.link.queueEvent({type:'room_added',roomId:created.id,payload:{id:created.id,inserted_at:now,updated_at:now}});
        await identity.agent!.runtime.link.subscribeRoom(created.id);
      }
      this.rooms.set(key,created.id);
      this.db.prepare('INSERT OR REPLACE INTO rooms(pair_key,room_id) VALUES(?,?)').run(key,created.id);
      return created.id;
    })();
    this.creatingRooms.set(key,operation);
    try{return await operation;}catch(error){this.recordFailure(stage,envelope,error);this.rooms.delete(key);this.db.prepare('DELETE FROM rooms WHERE pair_key=?').run(key);throw error;}finally{this.creatingRooms.delete(key);}
  }
  cancelRun(runId:string){
    this.cancelledRuns.add(runId);
    this.db.prepare("UPDATE outbox SET state='cancelled' WHERE state='pending' AND json_extract(payload,'$.runId')=?").run(runId);
  }
  async send(envelope:AgentEnvelope):Promise<{messageId:string;roomId:string;source:'live'}>{
    if(this.cancelledRuns.has(envelope.runId))throw new IntegrationError('run_cancelled','band');
    if(!isEnvelope(envelope))throw new IntegrationError('invalid_envelope','band');assertPublicEnvelope(envelope);
    const saved=this.db.prepare('SELECT payload FROM outbox WHERE id=?').get(envelope.id) as {payload:string}|undefined;
    if(saved&&saved.payload!==JSON.stringify(envelope))throw new IntegrationError('idempotency_conflict','band');
    const inFlight=this.sending.get(envelope.id);if(inFlight)return inFlight;
    const operation=this.sendOnce(envelope);this.sending.set(envelope.id,operation);
    try{return await operation;}finally{this.sending.delete(envelope.id);}
  }
  private async sendOnce(envelope:AgentEnvelope):Promise<{messageId:string;roomId:string;source:'live'}>{
    for(const role of [envelope.from,envelope.to])if(!this.identities.get(role)?.agent?.isRunning)throw new IntegrationError(`role_not_connected:${role}`,'band');
    const existing=this.db.prepare('SELECT state,room_id,band_id FROM outbox WHERE id=?').get(envelope.id) as {state:string;room_id:string;band_id:string}|undefined;
    if(existing?.state==='sent')return {messageId:existing.band_id,roomId:existing.room_id,source:'live'};
    this.db.prepare("INSERT OR IGNORE INTO outbox(id,payload,state) VALUES(?,?,'pending')").run(envelope.id,JSON.stringify(envelope));
    try{
      const roomId=await this.room(envelope);const sender=this.identities.get(envelope.from)!,recipient=this.identities.get(envelope.to)!;
      if(this.cancelledRuns.has(envelope.runId))throw new IntegrationError('run_cancelled','band');
      const result=await sender.agent!.runtime.link.rest.createChatMessage(roomId,encodeBandMessage(envelope,recipient));
      if(result.ok===false)throw new IntegrationError('message_send_failed','band');
      const data=result.data as {id?:string}|undefined;const messageId=String(data?.id??result.id??envelope.id);
      this.db.prepare("UPDATE outbox SET state='sent',room_id=?,band_id=? WHERE id=?").run(roomId,messageId,envelope.id);this.sent++;
      return {messageId,roomId,source:'live'};
    }catch(error){this.recordFailure('send',envelope,error);const safe=safeError(error,'band');this.db.prepare("UPDATE outbox SET state='failed',error=? WHERE id=?").run(safe.code,envelope.id);throw safe;}
  }
  async stop(){this.stopping=true;await Promise.allSettled([...this.identities.values()].map(i=>i.agent?.stop(3000)));}
  status(){
    const roles=ROLE_IDS.map(role=>{let connected=false;try{connected=!!this.identities.get(role)?.agent?.runtime.link.isConnected();}catch{}return {role,configured:!!process.env[`${BAND_ENV_PREFIX[role]}_AGENT_ID`]&&!!process.env[`${BAND_ENV_PREFIX[role]}_API_KEY`],authenticated:this.identities.has(role),connected,error:this.errors.get(role)};});
    const failedInbox=(this.db.prepare("SELECT COUNT(*) n FROM inbox WHERE state='failed'").get() as {n:number}).n;
    return {started:this.started,ready:roles.every(r=>r.connected),connected:roles.filter(r=>r.connected).length,required:ROLE_IDS.length,roles,sent:this.sent,received:this.received,processed:this.processed,rejected:this.rejected,failedInbox,recentFailures:this.recentFailures,missingRoles:roles.filter(r=>!r.connected).map(r=>r.role)};
  }
}
