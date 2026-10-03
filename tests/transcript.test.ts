import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTranscript, type StoredTranscriptRow } from '../server/integrations/transcript.js';
import { Engine } from '../server/engine.js';
import { createApp } from '../server/app.js';
import { CATALOG } from '../server/fixtures.js';
import type { AgentEnvelope } from '../shared/types.js';
const rfq=(id='rfq-1',runId='run-1'):AgentEnvelope=>({id,runId,runGeneration:1,from:'fruit-buyer',to:'supplier-wholesale',type:'rfq',correlationId:'batch-1',createdAt:'2026-10-03T23:00:00.000Z',payload:{lines:[{skuId:'apples',intentId:'apples',cases:1,quantity:40,specification:CATALOG.find(item=>item.id==='apples')},{skuId:'bananas',cases:2}],round:0}});
const row=(e:AgentEnvelope,direction:'outgoing'|'incoming'='outgoing',state='sent'):StoredTranscriptRow=>({direction,id:e.id,payload:JSON.stringify(e),state,band_id:'provider-'+e.id,room_id:'room-1'});

test('transcript deduplicates actual sender/receiver records, preserves exact payload and orders messages',()=>{
 const request=rfq();const next={...rfq('rfq-2'),createdAt:'2026-10-03T23:00:01.000Z'};
 const report=projectTranscript([row(next),row(request,'incoming','processed'),row(request)],'run-1');
 assert.deepEqual(report.messages.map(m=>m.id),['rfq-1','rfq-2']);assert.equal(report.omittedMessages,0);
 const first=report.messages[0]!;assert.deepEqual(first.payload,JSON.parse(row(request).payload).payload);assert.deepEqual(first.skuIds,['apples','bananas']);
 assert.deepEqual(first.transport,{status:'processed',sent:true,received:true,processed:true,bandMessageId:'provider-rfq-1',roomId:'room-1'});
 assert.equal(first.type,'rfq');assert.equal('accepted' in first.transport,false,'transport processing is not purchase acceptance');
});

test('pending/failed local attempts are never labeled provider-confirmed sends or deliveries',()=>{
 const pending={...row(rfq()),state:'pending',band_id:null,room_id:null};
 const failed={...row(rfq('failed')),state:'failed',band_id:null,room_id:null};
 const report=projectTranscript([pending,failed],'run-1');
 for(const m of report.messages){assert.equal(m.transport.sent,false);assert.equal(m.transport.received,false);assert.equal(m.transport.processed,false);assert.equal(m.transport.bandMessageId,undefined)}
 assert.deepEqual(new Set(report.messages.map(m=>m.transport.status)),new Set(['pending','failed']));
});

test('private or unexpected nested fields and conflicting duplicates withhold entire records',()=>{
 const safe=rfq();const privateMessage={...rfq('private'),payload:{...safe.payload as object,privateState:{floorCaseCents:123}}};
 const promptMessage={...rfq('prompt'),payload:{lines:[{skuId:'apples',specification:{...CATALOG[0],systemPrompt:'private secret'}}],round:0}};
 const credentialMessage={...rfq('credential'),apiKey:'not-for-operator'};
 const conflict={...safe,payload:{lines:[{skuId:'apples',cases:999}],round:0}};
 const report=projectTranscript([row(safe),row(conflict,'incoming','processed'),row(privateMessage),row(promptMessage),row(credentialMessage)],'run-1');
 assert.equal(report.messages.length,0);assert.equal(report.omittedMessages,4);assert.ok(!JSON.stringify(report).includes('private secret'));
});

test('SKU correlation preserves batched quote lines, budget replies and supplier acceptance receipts',()=>{
 const e=new Engine(':memory:',0);const r=e.create({},false);e.plan(r.id);
 const q=e.makeQuote(r.id,'supplier-wholesale','apples');
 const request={...rfq('budget',r.id),type:'budget_request' as const,to:'manager' as const,payload:{skuId:'apples',incrementCents:100,quoteId:q.id},correlationId:'budget-thread'};
 const reply={...request,id:'approved',from:'manager' as const,to:'fruit-buyer' as const,type:'budget_decision' as const,payload:{approve:true}};
 const quote={...rfq('quote',r.id),from:'supplier-wholesale' as const,to:'fruit-buyer' as const,type:'quote' as const,payload:{quotes:[q]}};
 const acceptance={...rfq('accept',r.id),type:'accept_quote' as const,correlationId:'accept-thread',payload:{decisionId:'decision-1',intentId:'apples',skuId:'apples',quoteId:q.id,quoteRevision:q.revision,quantity:q.quantity,committedCostCents:q.landedCostCents}};
 const receipt={...acceptance,id:'receipt',from:'supplier-wholesale' as const,to:'fruit-buyer' as const,type:'decision' as const,payload:{kind:'purchase_receipt',accepted:true,decisionId:'decision-1',intentId:'apples',quoteId:q.id,quoteRevision:q.revision}};
 const report=projectTranscript([request,reply,quote,acceptance,receipt].map(m=>row(m)),r.id);
 assert.equal(report.omittedMessages,0);for(const m of report.messages)assert.deepEqual(m.skuIds,['apples']);
 assert.deepEqual(report.messages.find(m=>m.type==='quote')!.payload,{quotes:[q]});e.close();
});

test('read-only operator endpoint exposes public transcript without god access and reset clears it',async()=>{
 const e=new Engine(':memory:',0);let rows:StoredTranscriptRow[]=[];
 e.attachBridge({async start(){},async stop(){},async reason(){throw Error('No inference in transcript test')},async send(){throw Error('No messaging in transcript test')},onMessage(){return()=>{}},status(){return {live:true}},transcript(id){return {...projectTranscript(rows,id),truncated:false}},resetRuns(){rows=[]}});
 const live=e.create({mode:'live'},false);rows=[row(rfq('rfq',live.id))];const simulated=e.create({},false);
 const server=createApp(e).listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 try {
  const response=await fetch(`${base}/api/runs/${live.id}/messages`);assert.equal(response.status,200);const report=await response.json();assert.equal(report.source,'band');assert.equal(report.messages.length,1);
  assert.equal((await fetch(`${base}/api/runs/${live.id}/god`)).status,403);
  const sim=await(await fetch(`${base}/api/runs/${simulated.id}/messages`)).json();assert.equal(sim.source,'simulation');assert.deepEqual(sim.messages,[]);
  const reset=await fetch(`${base}/api/demo/reset`,{method:'POST',headers:{'content-type':'application/json'},body:'{"confirm":true}'});assert.equal(reset.status,200);assert.deepEqual(rows,[]);
  assert.equal((await fetch(`${base}/api/runs/${live.id}/messages`)).status,404);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));e.close()}
});
