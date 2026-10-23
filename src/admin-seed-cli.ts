import 'dotenv/config';
import {createDatabase} from './db.js';
import {applyAdminSeed,readAdminSeed} from './admin-seed.js';

const args=process.argv.slice(2);
if(args.some(arg=>arg!=='--dry-run'))throw new Error('Use db:seed:admin ou db:seed:admin -- --dry-run.');
if(!process.env.MIGRATION_DATABASE_URL)throw new Error('Configure MIGRATION_DATABASE_URL; o seed não usa a conta de runtime.');
const db=createDatabase(process.env.MIGRATION_DATABASE_URL);
try{
 const result=await applyAdminSeed(db,await readAdminSeed(),{dryRun:args.includes('--dry-run')});
 console.log(JSON.stringify(result));
}catch{
 // Do not print DB errors, SQL parameters, URLs with credentials or the seed contents.
 console.error('Seed não aplicado: verifique migrations, banco vazio e configurações divergentes. Nenhuma alteração parcial foi mantida.');
 process.exitCode=1;
}finally{await db.end();}
