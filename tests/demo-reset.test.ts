import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, type ProviderBridge } from '../server/engine.js';
import { createApp } from '../server/app.js';
import { BandTransport } from '../server/integrations/band.js';
import type { AgentEnvelope, Evidence } from '../shared/types.js';
const tables=['runs','intents','stock','purchases','events','inbox','outbox'];
const count=(e:Engine,table:string)=>Number(e.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n);
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const message=(runId:string):AgentEnvelope=>({id:'late-message',runId,runGeneration:1,from:'supplier-wholesale',to:'fruit-buyer',type:'quote',correlationId:'late-correlation',payload:{quotes:[]},createdAt:new Date().toISOString()});

test('demo reset clears saved operational state and restores fresh stock/budgets while preserving research',async()=>{
 const e=new Engine(':memory:',0);
 const evidence:Evidence={id:'preserved-source',title:'Preserved research',source:'cached source',mode:'cached-live',observedAt:'2026-10-03',fetchedAt:'2026-10-03',scenarioDate:'2026-10-03',summary:'Retained'};
 e.setEvidence([evidence]);const trends=e.trendsSnapshot();
 const r=e.create({},false);const initialStock=e.db.prepare('SELECT supplier_id,sku_id,quantity FROM stock WHERE run_id=? ORDER BY supplier_id,sku_id').all(r.id);
 await e.execute(r.id);e.approve(r.id,e.snapshot(r.id).promotionRevision);e.flyer(r.id);
 assert.ok(count(e,'purchases')>0);
 const result=e.resetDemo();assert.equal(result.clearedRuns,1);assert.equal(result.bootstrap.currentRun,null);
 for(const table of tables)assert.equal(count(e,table),0,table);
 assert.deepEqual(e.trendsSnapshot(),trends);assert.throws(()=>e.snapshot(r.id),/Run not found/);
 const fresh=e.create({},false);assert.equal(fresh.budget.committedCents,0);assert.equal(fresh.budget.reservedCents,0);assert.equal(fresh.budget.unallocatedCents,fresh.budget.totalCents);
 assert.ok(fresh.evidence.some(x=>x.id===evidence.id));assert.deepEqual(e.db.prepare('SELECT supplier_id,sku_id,quantity FROM stock WHERE run_id=? ORDER BY supplier_id,sku_id').all(fresh.id),initialStock);
 e.close();
});

test('reset fences delayed manager completion without resurrecting an automatically executing run',async()=>{
 const e=new Engine(':memory:',0);let release:(value:unknown)=>void=()=>{};let entered:()=>void=()=>{};
 const started=new Promise<void>(resolve=>{entered=resolve});const pending=new Promise(resolve=>{release=resolve});let handler:(message:AgentEnvelope)=>Promise<void>|void=()=>{};const cancelled:string[]=[];
 const bridge:ProviderBridge={async start(){},async stop(){},status:()=>({live:true}),onMessage(fn){handler=fn;return()=>{}},async send(){throw Error('Stale send')},async reason(){entered();return pending},resetRuns(ids){cancelled.push(...ids)}};
 e.attachBridge(bridge);const r=e.create({mode:'live'});await started;e.resetDemo();assert.deepEqual(cancelled,[r.id]);release({allocations:[]});await tick();await tick();
 await handler(message(r.id));for(const table of tables)assert.equal(count(e,table),0,table);assert.equal(e.bootstrap().currentRun,null);assert.equal(e.capabilities().live,true);e.close();
});

test('reset releases outstanding transport waits and late messages cannot affect the next run',async()=>{
 const e=new Engine(':memory:',0);let sent:()=>void=()=>{};const sending=new Promise<void>(resolve=>{sent=resolve});let handler:(message:AgentEnvelope)=>Promise<void>|void=()=>{};let cancellations=0;
 e.attachBridge({async start(){},async stop(){},status:()=>({live:true}),onMessage(fn){handler=fn;return()=>{}},async send(){sent();return{}},async reason(_role,ctx:any){return {allocations:ctx.data.items.map((i:any)=>({skuId:i.skuId,allocationCents:i.allocationCents}))}},async cancelRun(){cancellations++}});
 const old=e.create({mode:'live'},false);const execution=e.execute(old.id);const rejected=assert.rejects(execution,/Run not found|no longer active/);await sending;e.resetDemo();await rejected;assert.equal(cancellations,1);
 const fresh=e.create({},false);await handler(message(old.id));assert.equal(e.snapshot(fresh.id).decisions.length,0);assert.equal(count(e,'inbox'),0);assert.equal(count(e,'outbox'),0);e.close();
});

test('reset endpoint requires confirmation, revokes sessions, closes streams and clears request idempotency',async()=>{
 const e=new Engine(':memory:',0);const originalCreate=e.create.bind(e);e.create=(config={},_start=true)=>originalCreate(config,false);const r=e.create({},false);const server=createApp(e).listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 try {
  const post=(path:string,data:unknown)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',origin:'http://another-tailnet-host:3001'},body:JSON.stringify(data)});
  assert.equal((await post('/api/demo/reset',{})).status,400);assert.equal(e.bootstrap().currentRun?.id,r.id);
  const login=await post('/api/session/god',{enabled:true});const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
  const stream=await fetch(`${base}/api/runs/${r.id}/events`);const reader=stream.body!.getReader();await reader.read();
  const response=await post('/api/demo/reset',{confirm:true});assert.equal(response.status,200);assert.equal((await response.json()).bootstrap.currentRun,null);
  const resetEvent=new TextDecoder().decode((await reader.read()).value);assert.match(resetEvent,/event: reset/);assert.equal((await reader.read()).done,true);
  const start=()=>fetch(base+'/api/runs',{method:'POST',headers:{'content-type':'application/json','idempotency-key':'same-demo-click'},body:'{}'});
  const fresh=await(await start()).json();assert.equal((await(await start()).json()).id,fresh.id);
  await post('/api/demo/reset',{confirm:true});const next=await(await start()).json();assert.notEqual(next.id,fresh.id);
  assert.equal((await fetch(`${base}/api/runs/${next.id}/god`,{headers:{cookie}})).status,403);assert.equal((await fetch(`${base}/api/runs/${r.id}`)).status,404);
 } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));e.close()}
});

test('Band reset removes local message payloads and persists tombstones without deleting rooms or identities',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'grove-reset-'));const path=join(dir,'band.sqlite');const first:any=new BandTransport(path);let second:any;
 try {
  const payload=JSON.stringify(message('old-run'));
  first.db.prepare("INSERT INTO inbox(id,band_id,room_id,payload,state) VALUES('i','b','room',?,'received')").run(payload);
  first.db.prepare("INSERT INTO outbox(id,payload,state) VALUES('o',?,'pending')").run(payload);
  first.db.prepare("INSERT INTO rooms VALUES('old-run:fruit-buyer:supplier-wholesale','room')").run();
  first.onMessage(()=>assert.fail('Reset message must never reach the engine'));
  const identities=first.identities;first.resetRuns(['old-run']);await tick();assert.equal(first.identities,identities);
  for(const table of ['inbox','outbox'])assert.equal(first.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
  assert.equal(first.db.prepare('SELECT COUNT(*) n FROM rooms').get().n,1);first.db.close();second=new BandTransport(path);
  await assert.rejects(second.send(message('old-run')),/run_cancelled/);
  await second.receive('fruit-buyer',{content:'GROCERY_ENVELOPE_V1\n'+payload},'room');assert.equal(second.db.prepare('SELECT COUNT(*) n FROM inbox').get().n,0);
 } finally {if(second)second.db.close();else if(first.db.isOpen)first.db.close();rmSync(dir,{recursive:true,force:true})}
});
