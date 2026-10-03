/** Authorized integration rehearsal: real ZooWork, IN-PROCESS TEST transport, in-memory DB.
 * This does not verify Band and cannot enable product live mode. */
import { readFile,writeFile } from 'node:fs/promises';
import { Engine,type ProviderBridge } from '../engine.js';
import { ZooReasoner } from './zoo.js';
import { assertPublicEnvelope } from './band.js';
import type { AgentEnvelope,RoleId } from '../../shared/types.js';
const zoo=new ZooReasoner();
const roleCalls:Partial<Record<RoleId,number>>={};const roleCompletions:Partial<Record<RoleId,number>>={};
const roleKinds:Record<string,number>={};const messageKinds:Record<string,number>={};
const handlerErrors:Array<{role:RoleId;code:string}>=[];
let abortRehearsal=()=>{};
let handler:((e:AgentEnvelope)=>Promise<void>|void)|undefined;let transportErrors=0;let calls=0;
const bridge:ProviderBridge={
  async start(){await zoo.start();},async stop(){await zoo.stop();},
  status(){return {live:true,blockers:[],source:'IN_PROCESS_TEST_TRANSPORT_NOT_BAND',zoowork:zoo.status()};},
  onMessage(fn){handler=fn;return()=>{handler=undefined;};},
  async send(envelope){assertPublicEnvelope(envelope);messageKinds[envelope.type]=(messageKinds[envelope.type]??0)+1;queueMicrotask(()=>{void Promise.resolve(handler?.(envelope)).catch(error=>{transportErrors++;const code=typeof error?.code==='string'?error.code:'handler_failed';handlerErrors.push({role:envelope.to,code});console.log(JSON.stringify({stage:'handler_failed',role:envelope.to,code,transport:'test-only'}));if(process.argv.includes('--fail-fast'))abortRehearsal();});});return {source:'IN_PROCESS_TEST_TRANSPORT_NOT_BAND'};},
  async reason(role,context){
    if(++calls>65)throw new Error('full_probe_call_cap');
    const ctx=context as {kind?:string;runId?:string};
    if(role==='manager'||role.endsWith('-buyer')){
      const serialized=JSON.stringify(context);for(const key of ['floorCaseCents','targetCaseCents','privateState','stockUnits','urgency'])if(serialized.includes('"'+key+'"'))throw new Error('private_context_boundary_failed');
    }
    roleCalls[role]=(roleCalls[role]??0)+1;const kind=ctx.kind??'unknown';roleKinds[kind]=(roleKinds[kind]??0)+1;
    const result=await zoo.reason(role,context);roleCompletions[role]=(roleCompletions[role]??0)+1;
    console.log(JSON.stringify({stage:'reason_completed',role,kind,completed:zoo.status().completed,transport:'test-only'}));
    return result;
  },
  cancelRun(runId){return zoo.cancelRun(runId);},
};
const engine=new Engine(':memory:',0);engine.attachBridge(bridge);await bridge.start();
const run=engine.create({mode:'live'},false);const started=Date.now();
abortRehearsal=()=>{engine.cancel(run.id);};
process.once('SIGTERM',abortRehearsal);process.once('SIGINT',abortRehearsal);
const timeout=setTimeout(()=>engine.cancel(run.id),5*60_000);let error:string|undefined;
try{await engine.execute(run.id);}catch(e){error=e instanceof Error?e.message:'probe_failed';engine.cancel(run.id);}finally{clearTimeout(timeout);}
const result=engine.snapshot(run.id);
const report={timestamp:new Date().toISOString(),transport:'IN_PROCESS_TEST_TRANSPORT_NOT_BAND',database:'in-memory',actualZooWork:true,bandVerified:false,durationMs:Date.now()-started,status:result.status,resolved:result.decisions.length,supplierResponders:result.progress.suppliersResponded,outcomes:result.decisions.reduce<Record<string,number>>((a,d)=>{a[d.outcome]=(a[d.outcome]??0)+1;return a;},{}),spotlights:result.items.filter(i=>i.spotlight).map(i=>({skuId:i.skuId,spotlight:i.spotlight,outcome:result.decisions.find(d=>d.skuId===i.skuId)?.outcome,escalated:result.decisions.find(d=>d.skuId===i.skuId)?.escalated})),roleCalls,roleCompletions,roleKinds,messageKinds,transportErrors,handlerErrors,provider:zoo.status(),error};
const path='server/integrations/verification.json';const existing=JSON.parse(await readFile(path,'utf8'));existing.fullZooRehearsal=report;await writeFile(path,JSON.stringify(existing,null,2)+'\n');
console.log(JSON.stringify({stage:'full_zoo_rehearsal',...report}));await bridge.stop();engine.close();
if(error||result.decisions.length!==24||result.progress.suppliersResponded!==8||Object.keys(roleCompletions).length!==11)process.exitCode=1;
