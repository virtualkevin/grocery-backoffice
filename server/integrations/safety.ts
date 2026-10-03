import { ROLE_IDS, type AgentEnvelope } from '../../shared/types.js';

export class IntegrationError extends Error {
  constructor(public readonly code:string, public readonly provider:string, public readonly retryable=false) {
    super(`${provider}: ${code}`); this.name='IntegrationError';
  }
}

/** Do not echo provider error bodies, prompts, request headers, or private reasoning. */
export function safeError(error:unknown, provider:string):IntegrationError {
  if(error instanceof IntegrationError) return error;
  const e=error as {status?:number;statusCode?:number;response?:{status?:number};code?:string;type?:string;name?:string};
  const status=Number(e?.status??e?.statusCode??e?.response?.status)||0;
  const code=e?.name==='AbortError'||e?.name==='TimeoutError'?'timeout':status?`http_${status}`:'request_failed';
  return new IntegrationError(code,provider,status===429||status>=500||code==='timeout');
}

export function parseDecisionJSON(text:string):unknown {
  const trimmed=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  if(trimmed.length>150_000) throw new IntegrationError('response_too_large','zoowork');
  let parsed:unknown;
  try { parsed=JSON.parse(trimmed); } catch { throw new IntegrationError('invalid_json','zoowork'); }
  if(parsed===null||typeof parsed!=='object') throw new IntegrationError('expected_json_object','zoowork');
  return parsed;
}

export function isEnvelope(value:unknown):value is AgentEnvelope {
  if(!value||typeof value!=='object') return false;
  const v=value as AgentEnvelope;
  return typeof v.id==='string'&&v.id.length>0&&typeof v.runId==='string'&&Number.isInteger(v.runGeneration)
    &&ROLE_IDS.includes(v.from)&&ROLE_IDS.includes(v.to)&&v.from!==v.to
    &&['rfq','quote','counteroffer','budget_request','budget_decision','accept_quote','decision'].includes(v.type)
    &&typeof v.correlationId==='string'&&typeof v.createdAt==='string';
}

/** A permit covers a provider call only, never a wait for another agent's message. */
export class Semaphore {
  private active=0;
  private queue:Array<()=>void>=[];
  constructor(private readonly limit=4) {}
  async run<T>(fn:()=>Promise<T>):Promise<T> {
    await new Promise<void>(resolve=>{ if(this.active<this.limit){this.active++;resolve();}else this.queue.push(resolve); });
    try{return await fn();}finally{const next=this.queue.shift();if(next)next();else this.active--;}
  }
  status(){return {active:this.active,queued:this.queue.length,limit:this.limit};}
}
