import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startWorker} from '../dist/worker-runtime.js';
import {testConfig} from './helpers.mjs';
test('backend worker only performs API maintenance and never claims price jobs',async()=>{
 const statements=[];let finish;const done=new Promise(resolve=>{finish=resolve;});
 const db={query:async sql=>{statements.push(sql);if(sql.startsWith('DELETE FROM audit_logs'))finish();return {rows:[]};}};
 const stop=startWorker(db,testConfig());try{await done;}finally{await stop();}
 assert.ok(statements.length>0);assert.equal(statements.some(sql=>sql.includes('offer_refresh')),false);assert.ok(statements.some(sql=>sql.startsWith('DELETE FROM offer_price_history')));
});
