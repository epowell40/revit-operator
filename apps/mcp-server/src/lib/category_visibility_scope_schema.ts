import { z } from 'zod';

export const categoryVisibilityScopeSchemaV1=z.object({
 kind:z.literal('category_visibility_v1'),category:z.string().min(1).max(256).refine(v=>v.trim()===v&&!/[\u0000-\u001f\u007f]/.test(v)&&(!/^OST_/i.test(v)||/^OST_[A-Za-z0-9_]+$/.test(v))),
 disciplines:z.array(z.enum(['Architectural','Structural','Mechanical','Electrical','Plumbing','Coordination'])).min(1).max(6).refine(v=>new Set(v).size===v.length),
 view_types:z.array(z.enum(['FloorPlan','CeilingPlan','EngineeringPlan','Section','Elevation','ThreeD'])).min(1).max(6).refine(v=>new Set(v).size===v.length),
 hidden:z.boolean(),sheet_ids:z.array(z.number().int().positive()).min(1).max(32).refine(v=>new Set(v).size===v.length).optional()
}).strict().describe('Check desired stored category visibility, even if already correct with no edit. Optional sheet_ids require exact complete native /revit/sheets action=detail + includeViewportGeometry:true; host derives every placed model view. Also require a complete /revit/views includeTemplates:true census and fresh /revit/visibility action=get categoryName/includeCategoryState:true for each candidate, AFTER final edits and SaveAs. Omit operationIds for current-native-reference selection. Counts and controlling templates come from retained native bytes; this does not certify source interpretation, filtered/linked appearance, or unrelated-state preservation.');
