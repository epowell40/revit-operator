import { z } from 'zod';
export const familyStaticTextScopeSchemaV1=z.object({
 kind:z.literal('family_static_text_v1'),
 category:z.string().min(1).max(256).refine(v=>v.trim()===v&&!/[\u0000-\u001f\u007f]/.test(v)&&(!/^OST_/i.test(v)||/^OST_[A-Za-z0-9_]+$/.test(v))),
 expected_text:z.string().min(1).max(2048).refine(v=>v.trim()===v&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v))
}).strict().describe('Check shared static family wording across the entire host category, including already-correct text. Collect complete unfiltered /revit/find-elements category census (limit/includeGeometry only), then unfiltered /revit/inspect-family-content for one discovered instance per type with maxElements:2000. Do this AFTER final edits, reloads and SaveAs, then check_scope. Host derives every instance/type; no actor count or subset. expected_text is exact case/punctuation with whitespace normalized and must occur together in one static text object. Omit operationIds for fresh-reference selection. Does not certify effective instance appearance, formatting/layout, labels, linked models or original source-comment completion.');
