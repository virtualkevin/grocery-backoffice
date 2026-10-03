import {useEffect,useState} from 'react';
import type {AgentTranscriptMessage,CatalogItem} from '../shared/types';
import {day,money} from './api';
const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const numeric=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const cases=(value:number)=>`${value} ${value===1?'case':'cases'}`;
function quantity(value:number,item?:CatalogItem){
 const unit=item?.unit||'unit';
 if(unit==='each')return `${value} ${item?.name.toLowerCase()||'items'}`;
 const plural=unit==='bunch'?'bunches':`${unit}s`;
 return `${value} ${value===1?unit:plural}`;
}
const reason=(data:Record<string,unknown>)=>[data.reason,data.rationale,data.rejectionReason].find(value=>typeof value==='string'&&value.trim()) as string|undefined;
export default function ReadableMessage({message,catalog,skuId,messages}:{message:AgentTranscriptMessage;catalog:CatalogItem[];skuId:string;messages:AgentTranscriptMessage[]}){
 const [expanded,setExpanded]=useState(false);
 useEffect(()=>setExpanded(false),[message.id,skuId]);
 const data=record(message.payload),raw=(Array.isArray(data.lines)?data.lines:Array.isArray(data.quotes)?data.quotes:[]).map(record);
 const selected=raw.filter(line=>skuId==='all'||line.skuId===skuId),shown=expanded?raw:selected.slice(0,3);
 const itemFor=(id:unknown)=>catalog.find(item=>item.id===id);
 const names=message.skuIds.map(id=>itemFor(id)?.name||id).join(', ');
 const item=itemFor(data.skuId??message.skuIds[0]);
 const requested=messages.find(other=>other.type==='budget_request'&&other.correlationId===message.correlationId&&other.from===message.to&&other.to===message.from);
 const increment=numeric(data.incrementCents)?data.incrementCents:requested&&numeric(record(requested.payload).incrementCents)?record(requested.payload).incrementCents as number:undefined;
 let lead='';
 if(message.type==='rfq')lead=`Requesting quotes for ${raw.length} ${raw.length===1?'product':'products'}.`;
 if(message.type==='quote')lead=`Offering ${raw.length} ${raw.length===1?'product':'products'} at the prices below.`;
 if(message.type==='counteroffer')lead=raw.length===1&&numeric(raw[0].casePriceCents)?`Counteroffer: ${money(raw[0].casePriceCents)} per case for ${itemFor(raw[0].skuId)?.name||String(raw[0].skuId)}${numeric(raw[0].cases)?` · ${cases(raw[0].cases)}`:''}.`:`Proposing new prices for ${raw.length} products.`;
 if(message.type==='budget_request')lead=`Requesting ${increment!==undefined?`${money(increment)} in additional budget`:'additional budget'}${names?` for ${names}`:''}.`;
 if(message.type==='budget_decision')lead=`${data.approve===true?'Approved':data.approve===false?'Declined':'Responded to'} ${increment!==undefined?`an additional ${money(increment)}`:'the additional budget request'}${names?` for ${names}`:''}.`;
 if(message.type==='accept_quote')lead=`Recording a purchase commitment${numeric(data.quantity)?` for ${quantity(data.quantity,item)}`:names?` for ${names}`:''}${numeric(data.committedCostCents)?` at ${money(data.committedCostCents)} total`:''}.`;
 if(data.kind==='purchase_receipt')lead=data.accepted===true?`Acknowledging the purchase commitment${names?` for ${names}`:''}.`:data.accepted===false?`Not acknowledging the purchase commitment${names?` for ${names}`:''}.`:'Returning a purchase receipt.';
 return <div className="readable-message"><p className="message-lead">{lead||'Recorded decision.'}</p>{message.type==='accept_quote'&&<p className="message-context">Buyer commitment; supplier acknowledgment is recorded separately.</p>}{data.kind==='purchase_receipt'&&<p className="message-context">Supplier receipt of the commitment; this does not confirm delivery.</p>}{reason(data)&&<p className="recorded-reason"><strong>Reason:</strong> {reason(data)}</p>}{raw.length>0&&<div className="readable-lines">{shown.map((line,index)=>{const product=itemFor(line.skuId),spec=record(line.specification),quoted=message.type==='quote',lineReason=reason(line);return <article className="readable-line" data-sku-id={String(line.skuId||'')} key={`${String(line.skuId)}-${index}`}><div className="readable-line-top"><strong>{product?.name||String(line.skuId||'Product')}</strong>{numeric(line.casePriceCents)&&<span>{money(line.casePriceCents)} <small>per case</small></span>}</div><p>{[numeric(line.cases)?cases(line.cases):null,numeric(line.quantity)?quantity(line.quantity,product):null].filter(Boolean).join(' · ')}</p>{quoted&&numeric(line.landedCostCents)&&<p className="line-total"><strong>{money(line.landedCostCents)} total</strong>{numeric(line.freightCents)?` · includes ${money(line.freightCents)} freight`:''}</p>}<div className="readable-terms">{typeof(line.grade??spec.grade)==='string'&&<span>{String(line.grade??spec.grade)}</span>}{typeof(line.organic??spec.organic)==='boolean'&&<span>{(line.organic??spec.organic)?'Organic':'Conventional'}</span>}{numeric(line.unitsPerCase??spec.unitsPerCase)&&<span>{String(line.unitsPerCase??spec.unitsPerCase)} {product?.unit||'units'} per case</span>}{typeof line.deliveryDate==='string'&&<span>Delivery {day(line.deliveryDate)}</span>}{numeric(line.shelfLifeDays)&&<span>{line.shelfLifeDays} days shelf life</span>}{numeric(line.availableUnits)&&<span>{quantity(line.availableUnits,product)} available</span>}{numeric(line.minimumCases)&&<span>Minimum {cases(line.minimumCases)}</span>}{typeof line.expiresAt==='string'&&<span>Offer expires {new Date(line.expiresAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'America/Los_Angeles',timeZoneName:'short'})}</span>}</div>{lineReason&&<p className="recorded-reason"><strong>Reason:</strong> {lineReason}</p>}</article>})}</div>}{raw.length>shown.length||expanded?<button className="message-expand" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{expanded?'Show fewer products':`Show all ${raw.length} ${message.type==='quote'?'offers':'products'}`}</button>:null}{!expanded&&raw.length>selected.length&&<p className="message-context">Showing the selected product. Expand to read the complete message.</p>}{numeric(data.round)&&data.round>0&&<p className="message-context">Negotiation round {data.round}</p>}</div>;
}
