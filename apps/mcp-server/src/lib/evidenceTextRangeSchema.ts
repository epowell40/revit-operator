import {z}from'zod';
/** Optional field path preserves old raw-artifact text ranges when omitted. */
export const evidenceTextRangeSchema=z.object({
 path:z.string().min(1).max(512).refine(v=>v===v.trim()&&!/[\u0000-\u001f]/.test(v),'Exact field path without whitespace or control characters required').optional(),
 start:z.number().int().min(0),length:z.number().int().min(1).max(1_048_576)
}).strict();
