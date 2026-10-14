/** A worker-selected search domain, not a source interpretation certificate. */
export type TagScopeRequestV1 = Readonly<{
  category: string; view_ids: readonly number[];
  family_names?: readonly string[]; subject_family_names?: readonly string[];
  has_leader: boolean;
}>;
export type WorkPlanScopeRequestV1 = Readonly<{
  item_id: string; scope: WorkPlanScopeV1; operation_ids: readonly string[]; requested_at: string;
  read_selection?: 'current_native_reads_v1';
}>;
export const MODEL_VIEW_TYPES_V1 = ['FloorPlan','CeilingPlan','EngineeringPlan','Section','Elevation','ThreeD'] as const;
export const VIEW_DISCIPLINES_V1 = ['Architectural','Structural','Mechanical','Electrical','Plumbing','Coordination'] as const;
/** Checks stored controlling category properties. It deliberately does not
 * certify effective linked graphics, source interpretation or hidden-state preservation. */
export type CategoryGraphicsScopeV1 = Readonly<{
  kind: 'category_graphics_v1'; category: string;
  disciplines: readonly string[]; view_types: readonly string[];
  halftone: boolean; hidden_policy: 'exclude_hidden';
}>;
/** A declared model-view domain; native sheet placement inventories can bound it.
 * Checking stored visibility does not establish source interpretation or appearance. */
export type CategoryVisibilityScopeV1 = Readonly<{
  kind: 'category_visibility_v1'; category: string;
  disciplines: readonly string[]; view_types: readonly string[];
  hidden: boolean; sheet_ids?: readonly number[];
}>;
export type WorkPlanScopeV1 = TagScopeRequestV1 | CategoryGraphicsScopeV1 | CategoryVisibilityScopeV1;
export function validCategoryVisibilityScopeV1(value: unknown): value is CategoryVisibilityScopeV1 {
  if (!value || typeof value!=='object' || Array.isArray(value)) return false;
  const v=value as CategoryVisibilityScopeV1;
  const {kind,hidden,sheet_ids,...domain}=v;
  return Object.keys(v).every(k=>['kind','category','disciplines','view_types','hidden','sheet_ids'].includes(k))
    &&kind==='category_visibility_v1'&&typeof hidden==='boolean'
    &&validCategoryGraphicsScopeV1({...domain,kind:'category_graphics_v1',halftone:false,hidden_policy:'exclude_hidden'})
    &&(sheet_ids===undefined||Array.isArray(sheet_ids)&&sheet_ids.length>0&&sheet_ids.length<=32
      &&new Set(sheet_ids).size===sheet_ids.length&&sheet_ids.every(n=>Number.isSafeInteger(n)&&n>0));
}
export function validCategoryGraphicsScopeV1(value: unknown): value is CategoryGraphicsScopeV1 {
  if (!value || typeof value!=='object' || Array.isArray(value)) return false;
  const v=value as CategoryGraphicsScopeV1;
  const choices=(x:unknown,allowed:readonly string[])=>Array.isArray(x)&&x.length>0&&x.length<=allowed.length
    &&new Set(x).size===x.length&&x.every(n=>allowed.includes(n));
  return Object.keys(v).every(k=>['kind','category','disciplines','view_types','halftone','hidden_policy'].includes(k))
    &&v.kind==='category_graphics_v1'&&typeof v.category==='string'&&v.category.trim()===v.category
    &&v.category.length>0&&v.category.length<=256&&!/[\u0000-\u001f\u007f]/.test(v.category)
    &&(!/^OST_/i.test(v.category)||/^OST_[A-Za-z0-9_]+$/.test(v.category))
    &&choices(v.disciplines,VIEW_DISCIPLINES_V1)&&choices(v.view_types,MODEL_VIEW_TYPES_V1)
    &&typeof v.halftone==='boolean'&&v.hidden_policy==='exclude_hidden';
}
export function validWorkPlanScopeV1(value: unknown): value is WorkPlanScopeV1 {
  return validTagScopeRequestV1(value)||validCategoryGraphicsScopeV1(value)||validCategoryVisibilityScopeV1(value);
}
export function validTagScopeRequestV1(value: unknown): value is TagScopeRequestV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v=value as TagScopeRequestV1;
  const names=(x:unknown)=>Array.isArray(x)&&x.length>0&&x.length<=32&&new Set(x).size===x.length
    &&x.every(n=>typeof n==='string'&&n.trim()===n&&n.length>0&&n.length<=240);
  return Object.keys(v).every(k=>['category','view_ids','family_names','subject_family_names','has_leader'].includes(k))
    && typeof v.category==='string' && v.category.length<=100 && /^OST_[A-Za-z0-9]+Tags$/.test(v.category) && typeof v.has_leader==='boolean'
    && Array.isArray(v.view_ids)&&v.view_ids.length>0&&v.view_ids.length<=128
    &&new Set(v.view_ids).size===v.view_ids.length&&v.view_ids.every(n=>Number.isSafeInteger(n)&&n>0)
    &&(v.family_names===undefined||names(v.family_names))&&(v.subject_family_names===undefined||names(v.subject_family_names));
}
