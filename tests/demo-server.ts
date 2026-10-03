/** Isolated browser test server: no credentials, provider SDKs, external requests or production DB. */
import { Engine } from '../server/engine.js';
import { createApp } from '../server/app.js';
import { loadCachedTrendReport } from '../server/integrations/trends.js';
const engine=new Engine(':memory:',0);
const cached=loadCachedTrendReport();if(cached)engine.setTrends(cached);
const server=createApp(engine).listen(3002,'127.0.0.1',()=>console.log('Isolated demo test server: http://127.0.0.1:3002'));
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{server.closeAllConnections();server.close();engine.close();process.exit(0)});
