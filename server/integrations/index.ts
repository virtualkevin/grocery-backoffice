import { CATALOG, SUPPLIERS } from '../fixtures.js';
import { randomUUID } from 'node:crypto';
import { IntegrationError, safeError } from './safety.js';
import type { AgentEnvelope, RoleId } from '../../shared/types.js';
import { ZooReasoner } from './zoo.js';
import { BandTransport } from './band.js';

export function createIntegrationService(){
  const zoo=new ZooReasoner();const band=new BandTransport();
  let startFlight:Promise<void>|undefined;
  let probeFlight:Promise<unknown>|undefined;
  const probeRuns=new Set<string>();
  async function probePair(from:RoleId,to:RoleId,deadline:number){
    const runId='transport-probe-'+randomUUID(),correlationId=randomUUID();
    probeRuns.add(runId);
    const started=Date.now();let timer:ReturnType<typeof setTimeout>|undefined;
    let resolveProbe:(value:unknown)=>void=()=>{};let rejectProbe:(error:unknown)=>void=()=>{};
    const completion=new Promise((resolve,reject)=>{resolveProbe=resolve;rejectProbe=reject;timer=setTimeout(()=>reject(new IntegrationError('probe_timeout','band')),Math.max(1,Math.min(15000,deadline-Date.now())));});
    void completion.catch(()=>{});
    const off=band.onMessage(async message=>{
      if(message.runId!==runId||message.correlationId!==correlationId)return;
      try{
        if(message.from===from&&message.to===to)await band.send({id:randomUUID(),runId,runGeneration:1,from:to,to:from,type:'decision',correlationId,payload:{diagnostic:true,acknowledged:true},createdAt:new Date().toISOString()});
        else if(message.from===to&&message.to===from&&(message.payload as {acknowledged?:boolean})?.acknowledged===true)resolveProbe({ok:true,transport:'actual-band',roundTrip:true,from,to,durationMs:Date.now()-started});
      }catch(error){rejectProbe(error);throw error;}
    });
    try{
      const send=band.send({id:randomUUID(),runId,runGeneration:1,from,to,type:'decision',correlationId,payload:{diagnostic:true},createdAt:new Date().toISOString()});
      await Promise.race([send,completion]);
      return await completion;
    }catch(error){return {ok:false,transport:'actual-band',roundTrip:false,from,to,error:safeError(error,'band').code,band:band.status()};}
    finally{if(timer)clearTimeout(timer);off();band.cancelRun(runId);}
  }
  async function probeTransport(){
    const started=Date.now(),deadline=started+60000;
    const pairs:Array<[RoleId,RoleId]>=[['manager','fruit-buyer'],['manager','vegetable-buyer']];
    for(const buyer of ['fruit-buyer','vegetable-buyer'] as const)for(const supplier of SUPPLIERS){
      if(CATALOG.some(sku=>sku.buyerId===buyer&&supplier.eligibleSkuIds.includes(sku.id)))pairs.push([buyer,supplier.id]);
    }
    const results:unknown[]=[];
    for(const [from,to] of pairs){
      if(Date.now()>=deadline)return {ok:false,transport:'actual-band',roundTrip:false,error:'probe_deadline',results};
      const result=await probePair(from,to,deadline) as {ok:boolean};results.push(result);
      if(!result.ok)return {ok:false,transport:'actual-band',roundTrip:false,results,durationMs:Date.now()-started};
    }
    return {ok:true,transport:'actual-band',roundTrip:true,pairsVerified:results.length,results,durationMs:Date.now()-started};
  }
  return {
    start(){return startFlight??=(async()=>{await Promise.all([zoo.start(),band.start()]);})().finally(()=>{startFlight=undefined;});},
    async stop(){await Promise.allSettled([zoo.stop(),band.stop()]);},
    reason(role:RoleId,context:unknown){return zoo.reason(role,context);},
    send(envelope:AgentEnvelope){return band.send(envelope);},
    onMessage(callback:(envelope:AgentEnvelope)=>Promise<void>|void){return band.onMessage(envelope=>{if(!probeRuns.has(envelope.runId))return callback(envelope);});},
    probeTransport(){return probeFlight??=(async()=>probeTransport())().finally(()=>{probeFlight=undefined;});},
    transcript(runId:string){return band.transcript(runId);},
    resetRuns(runIds:string[]){band.resetRuns(runIds);for(const id of runIds)void zoo.cancelRun(id).catch(()=>{});},
    cancelRun(runId:string){band.cancelRun(runId);return zoo.cancelRun(runId);},
    status(){
      const z=zoo.status(),b=band.status();
      const blockers=[...(!z.ready?[`ZooWork: ${z.error??'not connected'}`]:[]),...b.missingRoles.map(r=>`Band ${r}: ${b.roles.find(x=>x.role===r)?.error??'not connected'}`)];
      return {live:z.ready&&b.ready,blockers,zoowork:z,band:b};
    },
  };
}
export type IntegrationService=ReturnType<typeof createIntegrationService>;
