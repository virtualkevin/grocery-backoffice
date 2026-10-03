import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { CATALOG } from '../fixtures.js';
import { ROLE_IDS, type AgentEnvelope, type AgentTranscriptMessage } from '../../shared/types.js';

export interface StoredTranscriptRow { direction:'outgoing'|'incoming'; id:string; payload:string; state:string; band_id:string|null; room_id:string|null }
const id=z.string().min(1).max(200).regex(/^[a-zA-Z0-9:_-]+$/);
const sku=z.enum(CATALOG.map(item=>item.id) as [string,...string[]]);
const n=z.number().int().nonnegative().safe();
const date=z.string().max(40).refine(value=>Number.isFinite(Date.parse(value)));
const lot=z.object({id,quantity:n,availableAt:date,expiresAt:date,source:z.enum(['on_hand','inbound','purchase']),costCents:n}).strict();
const specification=z.object({id:sku,name:z.string().max(100),category:z.enum(['fruit','vegetable']),buyerId:z.enum(ROLE_IDS),unit:z.string().max(40),unitsPerCase:n,gramsPerUnit:n.optional(),grade:z.string().max(100),organic:z.boolean(),baseCaseCostCents:n,retailPriceCents:n,forecastUnits:n,safetyStockUnits:n,lots:z.array(lot).max(100),image:z.string().max(200).optional()}).strict();
const line=z.object({skuId:sku,intentId:id.optional(),cases:n.optional(),quantity:n.optional(),casePriceCents:n.optional(),specification:specification.optional()}).strict();
const quote=z.object({id,revision:n,runId:id,intentId:id,skuId:sku,supplierId:z.enum(ROLE_IDS),casePriceCents:n,cases:n,quantity:n,unitsPerCase:n,freightCents:n,landedCostCents:n,availableUnits:n,minimumCases:n,grade:z.string().max(100),organic:z.boolean(),deliveryDate:date,expiresAt:date,shelfLifeDays:n,status:z.enum(['offered','accepted','rejected','invalid']),round:n,source:z.enum(['simulation','live']),rejectionReason:z.string().max(500).optional()}).strict();
const bodies={
 rfq:z.object({lines:z.array(line).max(24),round:n}).strict(),
 counteroffer:z.object({lines:z.array(line).max(24),round:n}).strict(),
 quote:z.object({quotes:z.array(quote).max(24)}).strict(),
 budget_request:z.object({skuId:sku,incrementCents:n,quoteId:id}).strict(),
 budget_decision:z.object({approve:z.boolean()}).strict(),
 accept_quote:z.object({decisionId:id,intentId:id,skuId:sku,quoteId:id,quoteRevision:n,quantity:n,committedCostCents:n}).strict(),
 decision:z.object({kind:z.literal('purchase_receipt'),accepted:z.boolean(),decisionId:id,intentId:id,quoteId:id,quoteRevision:n}).strict(),
};
const envelope=z.object({id,runId:id,runGeneration:n,from:z.enum(ROLE_IDS),to:z.enum(ROLE_IDS),type:z.enum(['rfq','quote','counteroffer','budget_request','budget_decision','accept_quote','decision']),correlationId:id,payload:z.unknown(),createdAt:date}).strict();
function publicEnvelope(raw:string,runId:string):AgentEnvelope|null {
 if(raw.length>150000)return null;
 try {
  const value=JSON.parse(raw);const result=envelope.safeParse(value);
  if(!result.success||value.runId!==runId||value.from===value.to||!bodies[result.data.type].safeParse(value.payload).success)return null;
  return value as AgentEnvelope;
 }catch{return null}
}
function skuIds(message:AgentEnvelope):string[]{
 const p=message.payload as Record<string,unknown>;
 const ids=[p.skuId,...(['lines','quotes'].flatMap(key=>Array.isArray(p[key])?(p[key] as Array<{skuId?:string}>).map(line=>line.skuId):[]))];
 return [...new Set(ids.filter((value):value is string=>typeof value==='string'&&CATALOG.some(item=>item.id===value)))];
}
/** Public projection of persisted Band envelopes, not model output or reconstructed prose.
 * Unexpected/private fields withhold the entire message instead of silently changing its payload.
 */
export function projectTranscript(rows:StoredTranscriptRow[],runId:string){
 const grouped=new Map<string,{envelope:AgentEnvelope;rows:StoredTranscriptRow[]}>();
 const rejected=new Set<string>();
 for(const row of rows){
  const value=publicEnvelope(row.payload,runId);
  if(!value||value.id!==row.id){rejected.add(row.id);continue}
  const existing=grouped.get(row.id);
  if(existing&&!isDeepStrictEqual(existing.envelope,value)){rejected.add(row.id);continue}
  if(existing)existing.rows.push(row);else grouped.set(row.id,{envelope:value,rows:[row]});
 }
 const messages:AgentTranscriptMessage[]=[];
 for(const [id,{envelope,rows}] of grouped){
  if(rejected.has(id))continue;
  const outgoing=rows.find(row=>row.direction==='outgoing'),incoming=rows.find(row=>row.direction==='incoming');
  const received=!!incoming,processed=incoming?.state==='processed',sent=outgoing?.state==='sent';
  const status=processed?'processed':incoming?.state==='failed'?'failed':incoming?.state==='cancelled'?'cancelled':received?'received':sent?'sent':outgoing?.state==='failed'?'failed':outgoing?.state==='cancelled'?'cancelled':'pending';
  const storedId=incoming?.band_id??outgoing?.band_id;
  const bandMessageId=storedId&&storedId!==id&&idSafe(storedId)?storedId:undefined;
  const room=incoming?.room_id??outgoing?.room_id;const roomId=room&&idSafe(room)?room:undefined;
  messages.push({...structuredClone(envelope),skuIds:skuIds(envelope),transport:{status,sent,received,processed,...(bandMessageId?{bandMessageId}:{}),...(roomId?{roomId}:{})}});
 }
 // Replies without an SKU (budget decisions and acceptance receipts) inherit correlation context.
 const correlations=new Map<string,Set<string>>();
 for(const message of messages){const ids=correlations.get(message.correlationId)??new Set<string>();for(const sku of message.skuIds)ids.add(sku);correlations.set(message.correlationId,ids)}
 for(const message of messages)if(!message.skuIds.length)message.skuIds=[...(correlations.get(message.correlationId)??[])];
 messages.sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)||a.id.localeCompare(b.id));
 return {messages,omittedMessages:rejected.size};
}
function idSafe(value:string){return id.safeParse(value).success}
