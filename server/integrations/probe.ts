/** Explicit CLI probes. No automatic paid calls on server startup. */
import { writeFile,readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ZooReasoner } from './zoo.js';
import { createIntegrationService } from './index.js';
import { CATALOG,createPrivateStock } from '../fixtures.js';
import type { AgentEnvelope,RoleId } from '../../shared/types.js';

const mode=process.argv[2]??'auth';
const reportPath='server/integrations/verification.json';
async function record(section:string,values:Record<string,unknown>){const report=JSON.parse(await readFile(reportPath,'utf8'));report[section]={...report[section],...values};await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');}
if(mode==='batch'){
  const zoo=new ZooReasoner();await zoo.start();const begin=Date.now();
  try{
    const lines=CATALOG.filter(x=>x.category==='fruit').map(x=>({skuId:x.id,cases:1,unitsPerCase:x.unitsPerCase,grade:x.grade,organic:x.organic}));
    const privateState=createPrivateStock().filter(x=>x.supplierId==='supplier-fruit');
    const result=await zoo.reason('supplier-fruit',{kind:'supplier_quotes',runId:'batch-probe',instruction:'Quote all12 requested fruit lines. Return only {"quotes":[{"skuId":"...","casePriceCents":1234,"shelfLifeDays":7,"deliveryDate":"2026-10-04"}]}. Set opening prices at your target or above your minimum. Never return private constraints, explanations, or other keys.',publicRfQ:{lines},privateState,responseSchema:{quotes:'one public quote per requested SKU'}}) as {quotes?:Array<Record<string,unknown>>};
    const quotes=result.quotes??[];
    const expected=new Set(lines.map(x=>x.skuId));
    const valid=quotes.length===12&&new Set(quotes.map(q=>q.skuId)).size===12&&quotes.every(q=>expected.has(String(q.skuId))&&Number.isInteger(q.casePriceCents)&&Number(q.casePriceCents)>=privateState.find(x=>x.skuId===q.skuId)!.floorCaseCents&&Object.keys(q).every(k=>['skuId','casePriceCents','shelfLifeDays','deliveryDate'].includes(k)));
    const evidence={representativeBatchLines:quotes.length,representativeBatchValid:valid,representativeBatchMs:Date.now()-begin,batchInferenceCalls:zoo.status().calls};
    console.log(JSON.stringify(evidence));await record('zoowork',evidence);if(!valid)process.exitCode=1;
  }catch(error){console.log(JSON.stringify({provider:'zoowork',error:(error as Error).message}));process.exitCode=1;}finally{await zoo.stop();}
}else{
  const integrations=createIntegrationService();await integrations.start();
  try{
    if(mode==='roundtrip'){
      const status=integrations.status();const peer=status.band.roles.find(x=>x.role!=='manager'&&x.connected)?.role as RoleId|undefined;
      if(!peer)throw new Error('No second connected Band identity; roundtrip not attempted');
      const runId=`probe-${randomUUID()}`;const action=await integrations.reason('manager',{kind:'manager_budget',runId,instruction:'Return exactly {"approved":true,"amountCents":500} for an increment500 within reserve1000.'});
      let resolveReply:(value:unknown)=>void=()=>{};
      const reply=new Promise(resolve=>{resolveReply=resolve;});
      const off=integrations.onMessage(async envelope=>{
        if(envelope.runId!==runId)return;
        if(envelope.to===peer){await integrations.send({id:randomUUID(),runId,runGeneration:1,from:peer,to:'manager',type:'decision',correlationId:envelope.id,payload:{probe:true,acknowledged:true},createdAt:new Date().toISOString()});}
        else if(envelope.to==='manager')resolveReply(envelope);
      });
      const message:AgentEnvelope={id:randomUUID(),runId,runGeneration:1,from:'manager',to:peer,type:'budget_decision',correlationId:runId,payload:{probe:true,action},createdAt:new Date().toISOString()};
      const begin=Date.now();await integrations.send(message);
      let timeout:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([reply,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('roundtrip_timeout')),30_000);})]);}finally{if(timeout)clearTimeout(timeout);off();}
      const evidence={actualAgentRoundTripVerified:true,roundTripMs:Date.now()-begin,roundTripPeerRole:peer,connectedRoles:status.band.connected};
      console.log(JSON.stringify(evidence));await record('band',evidence);
    }else console.log(JSON.stringify(integrations.status()));
  }catch(error){console.log(JSON.stringify({probe:mode,error:(error as Error).message}));process.exitCode=1;}finally{await integrations.stop();}
}
