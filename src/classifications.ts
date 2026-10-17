import {z} from 'zod';
import type {Database} from './db.js';

export const classificationText=z.string().transform(v=>v.replace(/\s+/g,' ').trim()).pipe(z.string().max(80));
export const requiredCategory=classificationText.pipe(z.string().min(1));

// Use the existing spelling when the administrator types a known option.
// New values are persisted by the offer trigger only when the offer is saved.
export async function resolveClassification(db:Pick<Database,'query'>,category:string,subcategory=''){
 let name=requiredCategory.parse(category),child=classificationText.parse(subcategory);
 const known=(await db.query("SELECT category FROM offer_category_options WHERE lower(category)=lower($1) AND subcategory=''",[name])).rows[0];
 if(known)name=known.category;
 if(child){const knownChild=(await db.query('SELECT subcategory FROM offer_category_options WHERE lower(category)=lower($1) AND lower(subcategory)=lower($2)',[name,child])).rows[0];if(knownChild)child=knownChild.subcategory;}
 return {category:name,subcategory:child};
}
