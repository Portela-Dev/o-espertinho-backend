import {setTimeout as sleep} from 'node:timers/promises';
import type {Database} from './db.js';
import type {Config} from './config.js';
import type {ProviderService} from './providers.js';
import {workerTick} from './offers.js';
import {tickOfferRefresh,offerRefreshDelay} from './offer-refresh.js';

export function startWorker(db:Database,config:Config,providers:ProviderService){
 const controller=new AbortController(),signal=controller.signal;
 const loop=async(task:()=>Promise<void>,delay:()=>Promise<number>)=>{
  while(!signal.aborted){
   let wait=1000;
   try{await task();wait=await delay();}catch{console.error('Falha no worker; uma nova tentativa ocorrerá em breve.');}
   if(!signal.aborted)try{await sleep(wait,undefined,{signal});}catch{if(!signal.aborted)throw new Error('Falha na espera do worker.');}
  }
 };
 // Independent cadences: millisecond offer pauses do not repeat maintenance queries.
 const tasks=[loop(()=>workerTick(db,config,providers),async()=>config.WORKER_INTERVAL_SECONDS*1000),loop(()=>tickOfferRefresh(db,config,providers),()=>offerRefreshDelay(db))];
 return async()=>{controller.abort();await Promise.all(tasks);};
}
