import type { AgentEnvelope } from '../shared/types.js';
import { BandTransport, encodeBandMessage } from '../server/integrations/band.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore, parseDecisionJSON, safeError, isEnvelope } from '../server/integrations/safety.js';
import { assertPublicEnvelope, decodeBandEnvelope } from '../server/integrations/band.js';

const envelope={id:'msg-1',runId:'run-1',runGeneration:1,from:'fruit-buyer',to:'supplier-fruit',type:'rfq',correlationId:'batch-1',payload:{lines:[{skuId:'apples',cases:2}]},createdAt:'2026-10-03T21:00:00Z'};

test('provider concurrency stays bounded and failed calls release permits',async()=>{
  const pool=new Semaphore(4);let active=0,peak=0;
  const results=await Promise.allSettled(Array.from({length:20},(_,i)=>pool.run(async()=>{
    active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;if(i===3)throw new Error('expected');return i;
  })));
  assert.equal(peak,4);assert.equal(results.filter(r=>r.status==='fulfilled').length,19);assert.deepEqual(pool.status(),{active:0,queued:0,limit:4});
});
test('private fields are rejected without censoring legitimate public prices',()=>{
  assert.throws(()=>assertPublicEnvelope({quotes:[{floorCaseCents:500}]}),/private_payload_rejected/);
  assert.throws(()=>assertPublicEnvelope({details:{privateState:{floor:500}}}),/private_payload_rejected/);
  assert.doesNotThrow(()=>assertPublicEnvelope({casePriceCents:500,availableUnits:20}));
});
test('transport envelopes must identify distinct valid participants',()=>{
  assert.equal(isEnvelope(envelope),true);assert.equal(isEnvelope({...envelope,to:envelope.from}),false);
  assert.equal(isEnvelope({...envelope,from:'unknown-supplier'}),false);
  assert.equal(isEnvelope({...envelope,runGeneration:1.5}),false);
});
test('Band JSON survives mention prefix; unrelated messages are ignored',()=>{
  const decoded=decodeBandEnvelope({content:'@buyer GROCERY_ENVELOPE_V1\n'+JSON.stringify(envelope),metadata:{}});
  assert.deepEqual(decoded,envelope);
  assert.equal(decodeBandEnvelope({content:'Unrelated conversation',metadata:{}}),null);
  assert.equal(decodeBandEnvelope({content:'GROCERY_ENVELOPE_V1\nnot JSON',metadata:{}}),null);
});
test('reasoning parser rejects prose and primitives while allowing fenced JSON',()=>{
  assert.deepEqual(parseDecisionJSON('```json\n{"approved":true}\n```'),{approved:true});
  assert.throws(()=>parseDecisionJSON('The decision is {"approved":true}'),/invalid_json/);
  assert.throws(()=>parseDecisionJSON('null'),/expected_json_object/);
});
test('diagnostics never leak provider errors containing credentials or private values',()=>{
  const error=safeError({status:401,message:'secret-token floorCaseCents=123',bodySnippet:'sensitive'},'zoowork');
  assert.equal(error.message,'zoowork: http_401');assert.equal(error.retryable,false);
  assert.equal(safeError({status:429},'band').retryable,true);
  assert.equal(safeError({statusCode:403,body:{secret:'private'}},'band').code,'http_403');
  assert.equal(safeError({response:{status:503}},'band').retryable,true);
});

import {ZooReasoner} from '../server/integrations/zoo.js';
import type {ZooworkClient} from '@zoowork-ai/sdk';
function fakeZoo(stream:(call:number,signal?:AbortSignal)=>AsyncGenerator<unknown>){
  let streamCalls=0;const posted:Array<Array<{type:string}>>=[];
  const client={listModels:async()=>[{model:'litellm/gpt-5.6-luna',selectable:true}],getAgent:async()=>({agent_id:'test-agent'}),createAgent:async()=>({agent_id:'test-agent'}),startAgent:async()=>{},waitUntilRunning:async()=>{},stopAgent:async()=>{},createSession:async()=>({session_id:'test-session'}),postEvents:async(_a:string,_s:string,events:Array<{type:string}>)=>{posted.push(events);return {events:[]};},streamEvents:(_a:string,_s:string,opts:{signal?:AbortSignal})=>stream(++streamCalls,opts.signal)} as unknown as ZooworkClient;
  return {client,posted};
}
const assistant=(text:string)=>({eventType:'agent.assistant',payload:{message:{content:text}},cursor:'cursor-1'});
const finished={eventType:'run.finished',payload:{status:'succeeded'},cursor:'cursor-2'};
test('Zoo turn stops at run.finished and ignores private thinking events',async()=>{
  const f=fakeZoo(async function*(){yield {eventType:'agent.thinking',payload:{text:'private supplier floor'}};yield assistant('{"approve":true}');yield finished;throw new Error('stream was incorrectly consumed beyond turn completion');});
  const z=new ZooReasoner({client:f.client,statePath:null});await z.start();assert.deepEqual(await z.reason('manager',{runId:'test'}),{approve:true});assert.equal(z.status().completed,1);await z.stop();
});
test('Zoo repairs invalid JSON once and then accepts only the repaired turn',async()=>{
  const f=fakeZoo(async function*(call){yield assistant(call===1?'invalid response':'{"quotes":[]}');yield finished;});
  const z=new ZooReasoner({client:f.client,statePath:null});await z.start();assert.deepEqual(await z.reason('supplier-fruit',{runId:'test'}),{quotes:[]});assert.equal(f.posted.filter(x=>x[0]?.type==='user.message').length,1);assert.equal(z.status().calls,2);await z.stop();
});
test('Zoo cancellation interrupts provider execution and rejects stale continuation',async()=>{
  let reachedStream:()=>void=()=>{};const streaming=new Promise<void>(resolve=>{reachedStream=resolve;});
  const f=fakeZoo(async function*(_call,signal){reachedStream();await new Promise<void>((_,reject)=>{if(signal?.aborted)reject(new DOMException('Aborted','AbortError'));else signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});yield finished;});
  const z=new ZooReasoner({client:f.client,statePath:null});await z.start();const result=z.reason('manager',{runId:'cancel-me'});const rejection=assert.rejects(result,/timeout/);await streaming;await z.cancelRun('cancel-me');await rejection;assert.ok(f.posted.some(x=>x[0]?.type==='user.interrupt'));await assert.rejects(z.reason('manager',{runId:'cancel-me'}),/run_cancelled/);assert.equal(z.status().concurrency.active,0);await z.stop();
});
test('Zoo failed terminal status never accepts plausible assistant output',async()=>{
  const f=fakeZoo(async function*(){yield assistant('{"approve":true}');yield {...finished,payload:{status:'failed'}};});
  const z=new ZooReasoner({client:f.client,statePath:null});await z.start();await assert.rejects(z.reason('manager',{runId:'test'}),/run_failed/);assert.equal(z.status().completed,0);await z.stop();
});


test('Band text requests use only supported fields and preserve structured envelope decoding',()=>{
  const envelope:AgentEnvelope={id:'contract-message',runId:'contract-run',runGeneration:1,from:'manager',to:'fruit-buyer',type:'decision',correlationId:'contract-correlation',payload:{diagnostic:true},createdAt:new Date().toISOString()};
  const message=encodeBandMessage(envelope,{id:'recipient-id',name:'Fruit buyer',handle:'owner/fruit-buyer'});
  assert.deepEqual(Object.keys(message).sort(),['content','mentions']);
  assert.equal('metadata' in message,false);
  assert.deepEqual(message.mentions,[{id:'recipient-id',name:'Fruit buyer',handle:'owner/fruit-buyer'}]);
  assert.deepEqual(decodeBandEnvelope(message),envelope);
});


test('manager provisions private rooms while actual buyer identity sends the message',async()=>{
  const trace:string[]=[];
  const transport:any=Object.create(BandTransport.prototype);
  const identities=new Map();
  for(const role of ['manager','fruit-buyer','supplier-wholesale']){
    const rest={
      async createChat(){trace.push(role+':create');return {id:'private-room'};},
      async addChatParticipant(_room:string,p:{participantId:string}){trace.push(role+':add:'+p.participantId);return {ok:true};},
      async listChatParticipants(){return ['manager','fruit-buyer','supplier-wholesale'].map(id=>({id}));},
      async createChatMessage(_room:string,message:any){trace.push(role+':send');assert.equal('metadata' in message,false);return {ok:true,id:'actual-message'};}
    };
    identities.set(role,{role,id:role,handle:role,name:role,agent:{isRunning:true,runtime:{link:{rest,queueEvent(){},async subscribeRoom(){}}}}});
  }
  Object.assign(transport,{identities,cancelledRuns:new Set(),rooms:new Map(),allowedRooms:new Set(),creatingRooms:new Map(),sending:new Map(),recentFailures:[],sent:0,db:{prepare(){return {get(){return undefined;},run(){return {changes:1};}};}}});
  const message:AgentEnvelope={id:'send-test',runId:'run-test',runGeneration:1,from:'fruit-buyer',to:'supplier-wholesale',type:'rfq',correlationId:'correlation-test',payload:{lines:[]},createdAt:new Date().toISOString()};
  await transport.send(message);
  assert.deepEqual(trace,['manager:create','manager:add:fruit-buyer','manager:add:supplier-wholesale','fruit-buyer:send']);
});


test('cancelled run cannot publish an RFQ after slow room provisioning finishes',async()=>{
  let release:()=>void=()=>{};let sends=0;
  const provisioned=new Promise<void>(resolve=>{release=resolve;});
  const transport:any=Object.create(BandTransport.prototype);
  const identity={agent:{isRunning:true,runtime:{link:{rest:{async createChatMessage(){sends++;return {ok:true,id:'too-late'};}}}}}};
  Object.assign(transport,{identities:new Map([['fruit-buyer',identity],['supplier-wholesale',identity]]),cancelledRuns:new Set(),sending:new Map(),recentFailures:[],sent:0,db:{prepare(){return {get(){return undefined;},run(){return {changes:1};}};}}});
  transport.room=async()=>{await provisioned;return 'room';};
  const message:AgentEnvelope={id:'cancel-send',runId:'cancel-run',runGeneration:1,from:'fruit-buyer',to:'supplier-wholesale',type:'rfq',correlationId:'cancel-correlation',payload:{lines:[]},createdAt:new Date().toISOString()};
  const result=transport.send(message);transport.cancelRun('cancel-run');release();
  await assert.rejects(result,/run_cancelled/);assert.equal(sends,0);
  await assert.rejects(transport.send({...message,id:'late-retry'}),/run_cancelled/);assert.equal(sends,0);
});


test('concurrent sends cannot use a room before membership provisioning completes',async()=>{
 let release:()=>void=()=>{};const membership=new Promise<void>(resolve=>{release=resolve;});let sends=0,creates=0;
 const transport:any=Object.create(BandTransport.prototype);const identities=new Map();
 for(const role of ['manager','fruit-buyer','supplier-wholesale'])identities.set(role,{role,id:role,handle:role,name:role,agent:{isRunning:true,runtime:{link:{queueEvent(){},async subscribeRoom(){},rest:{async createChat(){creates++;return {id:'room'};},async addChatParticipant(){await membership;return {ok:true};},async listChatParticipants(){return ['manager','fruit-buyer','supplier-wholesale'].map(id=>({id}));},async createChatMessage(){sends++;return {ok:true,id:'m'+sends};}}}}}});
 Object.assign(transport,{identities,cancelledRuns:new Set(),rooms:new Map(),allowedRooms:new Set(),creatingRooms:new Map(),sending:new Map(),recentFailures:[],sent:0,db:{prepare(){return {get(){return undefined;},run(){return {changes:1};}};}}});
 const base:AgentEnvelope={id:'one',runId:'concurrent-run',runGeneration:1,from:'fruit-buyer',to:'supplier-wholesale',type:'rfq',correlationId:'correlation',payload:{lines:[]},createdAt:new Date().toISOString()};
 const first=transport.send(base);await new Promise(resolve=>setImmediate(resolve));const second=transport.send({...base,id:'two'});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(sends,0);assert.equal(creates,1);assert.equal(transport.rooms.size,0);
 release();await Promise.all([first,second]);assert.equal(sends,2);assert.equal(creates,1);assert.equal(transport.rooms.size,1);
});
