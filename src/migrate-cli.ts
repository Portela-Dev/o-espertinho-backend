import {loadConfig} from './config.js';
import {createDatabase} from './db.js';
import {provisionDatabase} from './provision-database.js';
const config=loadConfig(),migrationUrl=process.env.MIGRATION_DATABASE_URL;
if(!migrationUrl)throw new Error('Configure MIGRATION_DATABASE_URL separada da conta de runtime antes de aplicar migrations.');
const db=createDatabase(migrationUrl);
try{await provisionDatabase(db,config.DATABASE_URL);console.log('Migrations e grants da conta restrita conferidos.');}finally{await db.end();}
