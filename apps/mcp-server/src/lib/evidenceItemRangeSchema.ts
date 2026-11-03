import { z } from "zod";

export const evidenceItemRangeSchema = z.object({
  path: z.string(), start: z.number().int().min(0), count: z.number().int().min(1).max(256),
  fields: z.array(z.string()).min(1).max(64).optional(),
  filters: z.array(z.object({ field:z.string().min(1).max(512), op:z.enum(["eq","ne","lt","lte","gt","gte"]),
    value:z.union([z.string().max(512),z.number().finite(),z.boolean(),z.null()]) }).strict()).min(1).max(8).optional(),
  orderBy: z.object({ field:z.string().min(1).max(512),direction:z.enum(["asc","desc"]) }).strict().optional()
});
