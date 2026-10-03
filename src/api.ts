import type { Bootstrap, GodSnapshot, RunSnapshot } from '../shared/types';
export async function request<T>(path:string, options:RequestInit={}):Promise<T>{
  const response=await fetch(path,{...options,credentials:'same-origin',headers:{'Content-Type':'application/json',...options.headers}});
  const body=await response.json().catch(()=>({error:'The server returned an unreadable response.'}));
  if(!response.ok) throw new Error(typeof body.error==='string'?body.error:body.message||`Request failed (${response.status})`);
  return body as T;
}
export const api={bootstrap:()=>request<Bootstrap>('/api/bootstrap'),snapshot:(id:string)=>request<RunSnapshot>(`/api/runs/${id}`),god:(id:string)=>request<GodSnapshot>(`/api/runs/${id}/god`)};
export const money=(cents:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format((cents||0)/100);
export const number=(value:number)=>new Intl.NumberFormat('en-US').format(value||0);
export const day=(date:string)=>{const value=new Date(date.length===10?`${date}T12:00:00`:date);return Number.isNaN(value.getTime())?date:value.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'America/Los_Angeles'});};
export const time=(date:string)=>new Date(date).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/Los_Angeles'});
export const productEmoji=(name:string):string=>{const n=name.toLowerCase();return n.includes('apple')?'🍎':n.includes('banana')?'🍌':n.includes('strawber')?'🍓':n.includes('blueber')?'🫐':n.includes('raspber')?'🫐':n.includes('grape')?'🍇':n.includes('orange')||n.includes('mandarin')?'🍊':n.includes('lemon')?'🍋':n.includes('lime')?'🍋‍🟩':n.includes('pear')?'🍐':n.includes('avocado')?'🥑':n.includes('tomato')?'🍅':n.includes('romaine')||n.includes('spinach')||n.includes('kale')?'🥬':n.includes('broccoli')?'🥦':n.includes('potato')?'🥔':n.includes('onion')?'🧅':n.includes('carrot')?'🥕':n.includes('cucumber')||n.includes('zucchini')?'🥒':n.includes('pepper')?'🫑':n.includes('mushroom')?'🍄':'🌱';};
export const roleName=(role:string)=>role==='manager'?'Store manager':role==='fruit-buyer'?'Fruit buyer':role==='vegetable-buyer'?'Vegetable buyer':role==='system'?'Grove':role.replace('supplier-','').replaceAll('-',' ');
