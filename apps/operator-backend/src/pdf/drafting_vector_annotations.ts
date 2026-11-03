import type {VectorNativePlan} from './drafting_vector_native_plan.js';

export const VECTOR_ANNOTATION_RENDERER='operator.vector-drafting-annotations-native.v1';
export const VECTOR_ANNOTATION_PART_SIZE=40;

/** A representation of the complete immutable source, never a caller-selected subset. */
export function draftingVectorAnnotations(plan:VectorNativePlan){
 const entities=plan.entities.filter(e=>e.kind==='text'||e.kind==='fill'||e.kind==='dot');
 if(!entities.length||entities.length>80000)throw Error('Source annotations require 1 through 80000 complete text/fill/dot entities.');
 return entities;
}
