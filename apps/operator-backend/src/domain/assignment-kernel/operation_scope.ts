import { utf8TextSha256V2 } from "./canonical.js";
import type { AssignmentSpecV2, RequestedEffectV2 } from "./assignment_spec.js";

export const OPERATION_SCOPE_SCHEMA = "revit-operator.interpreted-operation-scope/v1" as const;
// This receipt derives the canonical effect field; the bound validator below
// requires it to equal the immutable specification rather than act as a second owner.
export interface InterpretedOperationScopeV1 extends Pick<AssignmentSpecV2, "requested_effect"> {
  schema: typeof OPERATION_SCOPE_SCHEMA;
  /** Artifact export authority need not authorize persistent model changes. */
  model_effect: RequestedEffectV2;
  /** Exact clauses remain part of the user's scope, not global write vetoes. */
  protected_clauses: string[];
  prerequisites: Array<{variable_id:string;kind:"information"|"approval";question:string;source_quote:string}>;
}
export interface BoundInterpretedScopeV1 {
  source_message_id: string;
  source_request_sha256: string;
  scope: InterpretedOperationScopeV1;
}
export const OPERATION_SCOPE_JSON_SCHEMA = {
  type:"object",additionalProperties:false,required:["schema","requested_effect","model_effect","protected_clauses","prerequisites"],
  properties:{schema:{type:"string",enum:[OPERATION_SCOPE_SCHEMA]},requested_effect:{type:"string",enum:["read","preview","apply"]},
    model_effect:{type:"string",enum:["read","preview","apply"]},
    protected_clauses:{type:"array",maxItems:8,items:{type:"string",maxLength:1200}},
    prerequisites:{type:"array",maxItems:8,items:{type:"object",additionalProperties:false,
      required:["variable_id","kind","question","source_quote"],properties:{
        variable_id:{type:"string",pattern:"^[a-z][a-z0-9_]{0,159}$"},kind:{type:"string",enum:["information","approval"],description:"information supplies missing facts or design choices for already-authorized work; approval supplies permission to act. Classify the required answer, not the order in which the question must be asked."},
        question:{type:"string",maxLength:1200},source_quote:{type:"string",maxLength:1200}
      }}}
  }
} as const;
const object=(v:unknown):Record<string,any>|null=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,any>:null;
const exact=(row:Record<string,any>,keys:string[])=>keys.every(k=>Object.hasOwn(row,k))&&Object.keys(row).every(k=>keys.includes(k));
const bounded=(v:unknown):v is string=>typeof v==="string"&&!!v.trim()&&v.length<=1200;
export const operationScopeRequestHash=(text:string)=>utf8TextSha256V2(text);
export function prerequisiteValueSatisfied(kind:"information"|"approval",value:unknown):boolean {
  if(kind==="approval")return value===true;
  if(value===null||value===undefined)return false;
  if(typeof value==="string")return !!value.trim();
  if(Array.isArray(value))return value.length>0;
  if(typeof value==="object")return Object.keys(value).length>0;
  return typeof value==="boolean"||(typeof value==="number"&&Number.isFinite(value));
}

export type OperationScopeIssue={code:string;path:string;message:string};
/** Diagnostics and authority validation deliberately share this exact code. */
export function operationScopeIssues(value:unknown, source?:string):OperationScopeIssue[] {
  const row=object(value);
  const issue=(code:string,path:string,message:string)=>[{code,path:`$.operation_scope${path}`,message}];
  if(!row||!exact(row,["schema","requested_effect","model_effect","protected_clauses","prerequisites"]))return issue("scope_fields","","Use exactly the declared operation scope fields.");
  if(row.schema!==OPERATION_SCOPE_SCHEMA)return issue("scope_schema",".schema","Use the declared operation scope schema.");
  if(!["read","preview","apply"].includes(row.requested_effect))return issue("scope_effect",".requested_effect","Use a declared requested effect.");
  if(!["read","preview","apply"].includes(row.model_effect))return issue("scope_model_effect",".model_effect","Use a declared model effect.");
  if(["read","preview","apply"].indexOf(row.model_effect)>["read","preview","apply"].indexOf(row.requested_effect))return issue("model_effect_exceeds_scope",".model_effect","The model effect cannot exceed the overall authorized effect.");
  if(!Array.isArray(row.protected_clauses)||row.protected_clauses.length>8)return issue("protected_clauses_shape",".protected_clauses","Use at most eight exact source clauses.");
  for(const [i,clause] of row.protected_clauses.entries()){
    if(!bounded(clause))return issue("protected_clause_length",`.protected_clauses[${i}]`,"Each clause must be a nonempty string of at most 1200 characters.");
    if(source!==undefined&&!source.includes(clause))return issue("protected_clause_not_exact",`.protected_clauses[${i}]`,"The protected clause must be an exact substring of the original user text.");
  }
  if(!Array.isArray(row.prerequisites)||row.prerequisites.length>8)return issue("prerequisites_shape",".prerequisites","Use at most eight prerequisites.");
  const ids=new Set<string>();
  for(const [i,value] of row.prerequisites.entries()){
    const p=object(value),at=`.prerequisites[${i}]`;
    if(!p||!exact(p,["variable_id","kind","question","source_quote"]))return issue("prerequisite_fields",at,"Use exactly the declared prerequisite fields.");
    if(typeof p.variable_id!=="string"||!/^[a-z][a-z0-9_]{0,159}$/.test(p.variable_id))return issue("prerequisite_id",`${at}.variable_id`,"Use a lowercase variable identifier of at most 160 characters.");
    if(ids.has(p.variable_id))return issue("prerequisite_duplicate_id",`${at}.variable_id`,"Prerequisite identifiers must be unique.");
    if(!["information","approval"].includes(p.kind))return issue("prerequisite_kind",`${at}.kind`,"Use information or approval according to what the required answer supplies.");
    if(!bounded(p.question))return issue("prerequisite_question",`${at}.question`,"Use a nonempty question of at most 1200 characters.");
    if(!bounded(p.source_quote))return issue("prerequisite_quote_length",`${at}.source_quote`,"Use a nonempty source quote of at most 1200 characters.");
    if(source!==undefined&&!source.includes(p.source_quote))return issue("prerequisite_quote_not_exact",`${at}.source_quote`,"The source quote must be an exact substring of the original user text.");
    ids.add(p.variable_id);
  }
  return [];
}
export function validOperationScope(value:unknown, source?:string):value is InterpretedOperationScopeV1 {
  return operationScopeIssues(value,source).length===0;
}

/** This validates the immutable receipt copied by the trusted creation edge.
 * It never reads caller hints or reinterprets a saved assignment. */
export function validBoundOperationScope(spec:AssignmentSpecV2):boolean {
  const bound=spec.interpreted_scope;
  return !!bound&&typeof bound.source_message_id==="string"&&!!bound.source_message_id.trim()&&bound.source_message_id.length<=200
    &&bound.source_request_sha256===operationScopeRequestHash(spec.source_user_request)
    &&validOperationScope(bound.scope,spec.source_user_request)&&bound.scope.requested_effect===spec.requested_effect
    &&bound.scope.prerequisites.every(p=>spec.input_variables.some(v=>v.variable_id===p.variable_id&&v.required&&v.value_state==="needs_input")
      &&spec.work_units.filter(w=>w.requested_effect!=="read").every(w=>w.input_variable_ids.includes(p.variable_id)));
}
