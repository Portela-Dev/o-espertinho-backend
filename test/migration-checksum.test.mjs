import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {migrationChecksums} from '../dist/migrate.js';

test('migration mantém integridade entre checkouts Windows/Linux sem aceitar conteúdo alterado',()=>{
 const lf="ALTER TABLE example ADD COLUMN label TEXT;\n-- Descrição preservada\n";
 const crlf=lf.replaceAll('\n','\r\n');
 const digest=value=>createHash('sha256').update(value).digest('hex');
 for(const source of [lf,crlf]){
  const checks=migrationChecksums(source);
  assert.equal(checks.canonical,digest(lf));
  assert.ok(checks.compatible.includes(digest(lf)));
  assert.ok(checks.compatible.includes(digest(crlf)));
  assert.equal(checks.compatible.includes(digest(lf.replace('label','different_column'))),false);
 }
});
