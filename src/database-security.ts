import type {Database} from './db.js';
export async function assertRestrictedDatabase(db:Pick<Database,'query'>){
 const r=(await db.query(`SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
 EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS member,
 EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspowner=r.oid AND n.nspname !~ '^pg_temp') AS owns_schema,
 EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relowner=r.oid AND n.nspname='public') AS owns_table,
 has_schema_privilege(current_user,'public','CREATE') AS can_create
 FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
 if(!r||Object.values(r).some(v=>v===true))throw new Error('A conexão de produção deve usar uma conta restrita, sem privilégios administrativos, associação a outras roles ou propriedade de tabelas. Execute o provisionamento com a conta de migrations.');
}
