import { z } from 'zod';

const nativeId = z.number().int().positive().safe();
const instance = z.object({
  x: z.number().finite(), y: z.number().finite(), z: z.number().finite(),
  coordinateMode: z.enum(['absolute_model', 'legacy_level_offset']).optional(),
  levelName: z.string().optional(),
  rotationDegrees: z.number().finite().optional(),
  hostElementId: nativeId.optional(),
  linkedHostElementId: nativeId.optional(),
  parameters: z.record(z.string()).optional(),
}).superRefine((value, ctx) => {
  if (value.linkedHostElementId !== undefined && value.hostElementId === undefined)
    ctx.addIssue({code: z.ZodIssueCode.custom, path: ['hostElementId'], message: 'The linked host requires its RevitLinkInstance hostElementId.'});
});

export const familyPlacementToolShape = {
  levelName: z.string().optional(), viewId: nativeId.optional(),
  familySymbolId: nativeId.optional(), familyName: z.string().optional(), symbolName: z.string().optional(),
  worksetId: nativeId.optional(), worksetName: z.string().optional(),
  allowUnhostedWorkPlanePlacement: z.boolean().optional(),
  instances: z.array(instance).min(1).max(500),
  dryRun: z.boolean().default(false),
  idempotency: z.object({enabled: z.boolean().default(true), toleranceFt: z.number().finite().positive().default(0.01)}).default({}),
  behavior: z.enum(['allOrNothing', 'bestEffort']).default('allOrNothing'),
};
