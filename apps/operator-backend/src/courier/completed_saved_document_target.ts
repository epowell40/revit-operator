import {canonicalJsonV2} from '../domain/assignment-kernel/canonical.js';
import type {RevitToolJob} from './revit_tool_jobs.js';

export type CompletedSavedDocumentTarget = {
  session_id:string;executor_id:string;title:string|undefined;path:string;body:unknown;
};

/** Exact read-only transport provenance, never a grant or a job mutation.
 * The store supplies its existing validated job/result readers unchanged. */
export function matchesCompletedSavedDocumentTarget(
  operationId:string,
  expected:CompletedSavedDocumentTarget,
  readJob:(id:string)=>RevitToolJob|null,
  readTerminalResult:(job:RevitToolJob)=>{status:string;outcome_unknown?:boolean}|null,
  supportedVersions:readonly string[]
):boolean {
  try {
    // The MCP publisher keys V2 jobs by the canonical operation digest;
    // the native request/correlation ID is a different identity.
    if(!/^opv2_[a-f0-9]{64}$/.test(operationId))return false;
    const jobId=operationId.slice('opv2_'.length);
    const job=readJob(jobId);
    if(!job||!supportedVersions.includes(job.version)
      ||(job as {assignment_operation_id?:unknown}).assignment_operation_id!==operationId
      ||job.status!=='succeeded'||job.session_id!==expected.session_id||job.correlation_id!==jobId
      ||job.method!=='POST'||job.path!=='/revit/save-as'||job.target_executor_id!==expected.executor_id
      ||job.claim?.executor_id!==expected.executor_id||job.target_document_title!==expected.title
      ||(job.target_document_path??'').replaceAll('\\','/').toLowerCase()!==expected.path.replaceAll('\\','/').toLowerCase()
      ||canonicalJsonV2(job.body)!==canonicalJsonV2(expected.body))return false;
    const result=readTerminalResult(job);
    return result?.status==='succeeded'&&result.outcome_unknown!==true;
  } catch {return false;}
}
