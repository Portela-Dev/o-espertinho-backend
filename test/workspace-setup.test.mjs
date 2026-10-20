import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceSteps} from '../scripts/workspace.mjs';
test('setup prepara apenas os três projetos ativos e sobe só PostgreSQL com detach',()=>{
 const steps=workspaceSteps('setup');assert.equal(steps.some(s=>/job-|extractor/.test(s.project)),false);
 const docker=steps.find(s=>s.docker&&s.args.includes('compose'));assert.ok(docker.args.includes('-d'));assert.equal(docker.args.at(-1),'postgres');
 assert.equal(steps.some(s=>s.args.includes('db:provision')),false);assert.ok(steps.some(s=>s.project==='o-espertinho-chrome-extension'&&s.args.includes('package')));
 assert.throws(()=>workspaceSteps('legacy:price-job:up'));
 assert.throws(()=>workspaceSteps('all:up'));
});
