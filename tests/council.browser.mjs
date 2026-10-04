/** Read-only council smoke. Requires an existing stable live run; never starts or modifies a run. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const base=process.env.BASE_URL||'http://localhost:3001',output=process.env.SCREENSHOT_DIR||'/tmp/grove-council-ui';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
const page=await browser.newPage({viewport:{width:1440,height:1060}}),errors=[],writes=[];
page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(!['GET','HEAD','OPTIONS'].includes(request.method()))writes.push(request.url());});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
try{
 const boot=await(await page.request.get(`${base}/api/bootstrap`)).json();const run=boot.currentRun;
 assert.ok(run&&['reviewing','complete','flyer_ready'].includes(run.status));
 const before=await(await page.request.get(`${base}/api/runs/${run.id}`)).json();
 const transcript=await(await page.request.get(`${base}/api/runs/${run.id}/messages`)).json();
 const council=transcript.messages.filter(message=>['budget_request','budget_decision'].includes(message.type)&&((message.from==='manager'&&['fruit-buyer','vegetable-buyer'].includes(message.to))||(message.to==='manager'&&['fruit-buyer','vegetable-buyer'].includes(message.from))));
 assert.ok(council.length>0);
 await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForFunction(id=>document.querySelector('main')?.dataset.runId===id,run.id);
 await page.locator('.nav-item').filter({hasText:'Agent network'}).click();await page.getByRole('button',{name:'View purchaser council',exact:true}).click();
 await page.getByRole('heading',{name:'Budget discussions, together.',exact:true}).waitFor();await page.getByText('Actual Band records',{exact:true}).waitFor();
 assert.equal(await page.locator('.chat-message').count(),council.length);
 for(const role of ['manager','fruit-buyer','vegetable-buyer']){const count=council.filter(message=>message.from===role).length;const member=page.locator('.council-members>div').filter({has:page.locator(`.council-avatar.${role}`)});assert.ok((await member.innerText()).includes(`${count} recorded contribution`));}
 for(const message of council){const card=page.locator(`[data-message-id="${message.id}"]`);assert.equal(await card.count(),1);if(message.type==='budget_request')assert.ok((await card.locator('.chat-text').innerText()).includes((message.payload.incrementCents/100).toFixed(2)));if(message.type==='budget_decision')assert.ok((await card.locator('.chat-text').innerText()).includes(message.payload.approve?'Approved':'Declined'));}
 await page.screenshot({path:`${output}/01-council-desktop.png`,fullPage:false});
 const first=page.locator('.chat-message').first();await first.locator('.chat-details>summary').click();await first.locator('.message-json>summary').focus();await page.keyboard.press('Enter');const id=await first.getAttribute('data-message-id');assert.deepEqual(JSON.parse(await first.locator('pre').textContent()),council.find(message=>message.id===id).payload);
 await page.getByLabel('Filter messages by product').selectOption('strawberries');assert.equal(await page.locator('.chat-message').count(),council.filter(message=>message.skuIds.includes('strawberries')).length);
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.locator('.council-heading').scrollIntoViewIfNeeded();await page.screenshot({path:`${output}/02-council-mobile.png`,fullPage:false});
 await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(id=>document.querySelector('main')?.dataset.runId===id,run.id);await page.locator('.nav-item').filter({hasText:'Activity'}).click();await page.getByRole('button',{name:'Council',exact:true}).click();await page.getByText('Actual Band records',{exact:true}).waitFor();
 const after=await(await page.request.get(`${base}/api/runs/${run.id}`)).json();assert.equal(hash(before),hash(after));assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 const report={passed:true,runId:run.id,status:run.status,councilMessages:council.length,beforeHash:hash(before),afterHash:hash(after),checks:['Agent network entry and Activity tab','Only existing buyer-manager budget exchanges','Actual amount and manager decision','Honest per-role contribution counts','Keyboard stored JSON exact match','Product filter and mobile containment','Reload, unchanged run, no mutations or browser errors'],errors,writes};await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
