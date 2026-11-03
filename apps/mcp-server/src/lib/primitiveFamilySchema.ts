import { z } from "zod";

const length = z.number().finite().min(1 / 192).max(1000);
const shape = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/).default("body"),
  kind: z.enum(["box", "cylinder"]).default("box"),
  widthFt: length.optional(), depthFt: length.optional(), diameterFt: length.optional(),
  heightFt: length,
  // Homogeneous fixed-length array: equivalent coordinate validation, with an
  // object-valued items schema accepted by the pinned dynamic-tool consumer.
  originFeet: z.array(z.number().finite().min(-10000).max(10000)).length(3).default([0, 0, 0]),
  rotationDegrees: z.number().finite().min(-360).max(360).default(0),
}).strict().superRefine((s, ctx) => {
  if (s.kind === "box" ? s.widthFt === undefined || s.depthFt === undefined || s.diameterFt !== undefined
    : s.diameterFt === undefined || s.widthFt !== undefined || s.depthFt !== undefined)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Box needs widthFt/depthFt only; cylinder needs diameterFt only." });
});

export const primitiveFamilyDefinitionSchema = z.object({
  category: z.enum(["Generic Models", "Mechanical Equipment", "Electrical Equipment", "Plumbing Fixtures"]).default("Generic Models"),
  typeName: z.string().min(1).max(100).refine(s => s.trim().length > 0 && !/[\\/:{}\[\]|;<>?`~\x00-\x1f\x7f]/.test(s), "Valid Revit type name required").default("Generic"),
  instanceDimensions: z.boolean().default(true),
  shapes: z.array(shape).min(1).max(16),
}).strict().superRefine((d, ctx) => {
  if (new Set(d.shapes.map(s => s.id.toLowerCase())).size !== d.shapes.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Shape IDs must be distinct parameter prefixes." });
});
