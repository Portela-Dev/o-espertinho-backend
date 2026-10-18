import {z} from 'zod';
import type {Database} from './db.js';
export interface Page<T=Record<string,unknown>> {items:T[];total:number;page:number;pageSize:number}
export function wantsPage(query:Record<string,unknown>) { return query.paginate==='true'; }
export async function pagedQuery(db:Pick<Database,'query'>,query:Record<string,unknown>,sql:string,args:unknown[]=[],legacyLimit?:number):Promise<any> {
 if(!wantsPage(query))return (await db.query(sql+(legacyLimit ? ` LIMIT ${legacyLimit}` : ''),args)).rows;
 const input=z.object({page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().int().min(1).max(50).default(20)}).parse(query);
 const total=(await db.query(`SELECT count(*)::int AS total FROM (${sql}) AS page_source`,args)).rows[0].total;
 const page=Math.min(input.page,Math.max(1,Math.ceil(total/input.pageSize)));
 const items=(await db.query(`${sql} LIMIT $${args.length+1} OFFSET $${args.length+2}`,[...args,input.pageSize,(page-1)*input.pageSize])).rows;
 return {items,total,page,pageSize:input.pageSize};
}
