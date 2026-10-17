import {loadConfig} from './config.js';
import {createDatabase} from './db.js';
import {ProviderService} from './providers.js';
import {startWorker} from './worker-runtime.js';
const config=loadConfig(),db=createDatabase(config.DATABASE_URL),providers=new ProviderService();
const stop=startWorker(db,config,providers);
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{if(stopping)return;stopping=true;void stop().then(()=>db.end());});
