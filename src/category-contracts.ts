import {z} from 'zod';
import {requiredCategory} from './classifications.js';
export const categoryOperation=z.strictObject({
 action:z.enum(['rename','move','merge','delete']),
 sourceId:z.uuid(),name:requiredCategory.optional(),
 parentId:z.uuid().nullable().optional(),targetId:z.uuid().nullable().optional(),
});
export const categoryApply=categoryOperation.extend({revision:z.string().regex(/^[a-f0-9]{64}$/),confirm:z.literal(true)});
export type CategoryOperation=z.infer<typeof categoryOperation>;
export interface CategoryNode {id:string;path:string[];normalized_path:string[]}
