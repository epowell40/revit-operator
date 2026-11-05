import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureWorkspaceLayout } from "../workspace.js";
import {nativeDocumentCheckpointResultV2} from '@revitoperator/assignment-kernel-v2-contracts';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {canonicalJsonV2} from '../domain/assignment-kernel/canonical.js';
import {sameAssignmentBindingV2} from '../domain/assignment-kernel/identity.js';
import type {AssignmentSnapshotV2} from '../domain/assignment-kernel/snapshot.js';
import {readAuthoritativeEvidence,readEvidenceRef} from '../evidence/evidence_store.js';
import {completedRevitToolJobMatchesTarget} from './revit_tool_jobs.js';

export type RevitCourierTurnContextLease = {
  token: string;
  workspace_root: string;
  session_id: string;
  message_id: string;
  target_executor_id?: string;
  target_document_title?: string;
  target_document_path?: string;
};

const activeByWorkspace = new Map<string, RevitCourierTurnContextLease>();

function enabled(): boolean {
  return (process.env.OPERATOR_REVIT_TRANSPORT || "direct").trim().toLowerCase() === "courier";
}

function contextPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, "config", "revit-courier-context.json");
}

function writeContext(workspaceRoot: string, value: unknown): void {
  const filePath = contextPath(workspaceRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, filePath);
}

export function beginRevitCourierTurnContext(input: { session_id: string; message_id: string; ttl_ms: number; target_executor_id?: string; target_document_title?: string; target_document_path?: string }): RevitCourierTurnContextLease | null {
  if (!enabled()) return null;
  const sessionId = (input.session_id || "").trim();
  const messageId = (input.message_id || "").trim();
  if (!sessionId) throw new Error("Hosted Revit courier requires a session_id.");
  const workspaceRoot = ensureWorkspaceLayout().root;
  const existing = activeByWorkspace.get(workspaceRoot);
  if (existing) {
    throw new Error(`Hosted Revit courier is busy with session ${existing.session_id}; retry after its active Codex turn finishes.`);
  }
  const lease: RevitCourierTurnContextLease = {
    token: randomUUID(),
    workspace_root: workspaceRoot,
    session_id: sessionId,
    message_id: messageId,
    target_executor_id: (input.target_executor_id || "").trim() || undefined,
    target_document_title: (input.target_document_title || "").trim() || undefined,
    target_document_path: (input.target_document_path || "").trim() || undefined
  };
  activeByWorkspace.set(workspaceRoot, lease);
  const ttlMs = Math.max(30_000, Math.min(121 * 60_000, input.ttl_ms || 20 * 60_000));
  writeContext(workspaceRoot, {
    version: "revit-operator.revit-courier-context.v1",
    active: true,
    token: lease.token,
    session_id: sessionId,
    message_id: messageId,
    target_executor_id: lease.target_executor_id,
    target_document_title: lease.target_document_title,
    target_document_path: lease.target_document_path,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + ttlMs).toISOString()
  });
  return lease;
}

export function endRevitCourierTurnContext(lease: RevitCourierTurnContextLease | null | undefined): void {
  if (!lease) return;
  const active = activeByWorkspace.get(lease.workspace_root);
  if (!active || active.token !== lease.token) return;
  activeByWorkspace.delete(lease.workspace_root);
  writeContext(lease.workspace_root, {
    version: "revit-operator.revit-courier-context.v1",
    active: false,
    token: lease.token,
    session_id: lease.session_id,
    message_id: lease.message_id,
    target_executor_id: lease.target_executor_id,
    target_document_title: lease.target_document_title,
    target_document_path: lease.target_document_path,
    finished_at: new Date().toISOString(),
    expires_at: new Date().toISOString()
  });
}

/** Transport maintenance only. A retained native same-document SaveAs changes
 * its path/title, not the assignment, executor, permissions or lease expiry.
 * Run before dispatch, including automatic readbacks in the same invocation.
 * Never infer a new target from an actor argument or arbitrary active window. */
export function refreshRevitCourierDocumentTarget(snapshot:AssignmentSnapshotV2):boolean {
  if(!enabled()||snapshot.terminal||snapshot.outcome!=='active'||snapshot.completion_proposal
    ||snapshot.execution_control?.state==='paused'||snapshot.unresolved_unknown_operation_ids.length
    ||snapshot.in_flight_operation_ids.some(id=>snapshot.operations[id]?.requested_effect==='apply'))return false;
  const lease=activeByWorkspace.get(ensureWorkspaceLayout().root);
  if(!lease?.target_executor_id||!lease.target_document_path||lease.session_id!==snapshot.current_binding.session_id)return false;
  const normalized=(p:string)=>path.win32.normalize(p).replaceAll('\\','/').toLowerCase();
  try {
    const stored=JSON.parse(fs.readFileSync(contextPath(lease.workspace_root),'utf8'));
    if(stored.active!==true||stored.token!==lease.token||stored.session_id!==lease.session_id||stored.message_id!==lease.message_id
      ||stored.target_executor_id!==lease.target_executor_id||stored.target_document_path!==lease.target_document_path
      ||stored.target_document_title!==lease.target_document_title||!Number.isFinite(Date.parse(stored.expires_at))
      ||Date.parse(stored.expires_at)<=Date.now())return false;
    let targetPath=lease.target_document_path,targetTitle=lease.target_document_title;
    const operations=Object.values(snapshot.operations).sort((a,b)=>(a.settled_assignment_version??0)-(b.settled_assignment_version??0));
    for(const op of operations){
      const r=op.result,body=op.input.body as Record<string,unknown>|undefined;
      if(op.requested_effect!=='apply'||op.admission_state!=='admitted'||op.dispatch_authority!=='native'
        ||op.dispatch_state!=='dispatched'||op.settlement_state!=='settled'||op.persistent_effect!=='applied'
        ||op.observation_retention_error||snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
        ||!sameAssignmentBindingV2(op.binding,snapshot.current_binding)||op.target.document_fingerprint!==op.binding.document_fingerprint
        ||!Number.isSafeInteger(op.admitted_assignment_version)||!Number.isSafeInteger(op.settled_assignment_version)
        ||op.admitted_assignment_version!<=0||op.settled_assignment_version!<=op.admitted_assignment_version!
        ||op.settled_assignment_version!>snapshot.assignment_version||!r||!nativeDocumentCheckpointResultV2(r)
        ||r.operation_id!==op.operation_id||!sameAssignmentBindingV2(r.binding,op.binding)||!r.receipt_id||!r.native_correlation_id
        ||r.input_schema_gap||r.result_semantic_gap||!op.request_identity?.request_signature
        ||canonicalJsonV2(r.request_identity)!==canonicalJsonV2(op.request_identity)
        ||op.input.method!=='POST'||op.input.path!=='/revit/save-as'||op.request_identity.method!=='POST'||op.request_identity.path!==op.input.path
        ||!body||body.dryRun===true||typeof body.filePath!=='string')continue;
      const save=r.native_artifact_receipt!.save_document!,after=save.after;
      if(!after||save.project_binding_changed||save.before.project_fingerprint!==op.binding.document_fingerprint
        ||after.project_fingerprint!==op.binding.document_fingerprint||!save.document_path_changed
        ||normalized(save.before.path)!==normalized(targetPath)||!path.win32.isAbsolute(after.path)
        ||!/\.rvt$/i.test(after.path))continue;
      const expected=path.win32.isAbsolute(body.filePath)?body.filePath:path.win32.resolve(path.win32.dirname(save.before.path),body.filePath);
      if(normalized(expected)!==normalized(after.path))continue;
      if(!completedRevitToolJobMatchesTarget(op.operation_id,{session_id:lease.session_id,executor_id:lease.target_executor_id,
        title:targetTitle,path:targetPath,body:op.input.body}))continue;
      const backed=op.observation_ids.some(id=>{
        const o=snapshot.observations[id];
        if(o?.operation_id!==op.operation_id||o.authority!=='native-host'||!sameAssignmentBindingV2(o.binding,op.binding)
          ||o.raw_payload_hash!==r.raw_payload_hash||o.result_schema_id!==r.result_schema_id||!o.raw_payload_ref.startsWith('evidence:'))return false;
        try{const raw=JSON.parse(readAuthoritativeEvidence(readEvidenceRef(o.raw_payload_ref.slice(9)),{...op.binding,attempt_id:op.operation_id}).toString('utf8'));
          return payloadDigestV2(raw).digest===r.raw_payload_hash&&canonicalJsonV2(raw.artifact_receipt)===canonicalJsonV2(r.native_artifact_receipt);
        }catch{return false;}
      });
      if(backed){targetPath=after.path;targetTitle=path.win32.parse(targetPath).name;}
    }
    if(normalized(targetPath)===normalized(lease.target_document_path))return false;
    // Revit's SaveAs names the project after the saved RVT. Keep both exact
    // title and path guards; do not remove the title check to permit the move.
    const title=path.win32.parse(targetPath).name;
    if(!title||title.length>500||/[\u0000-\u001f\u007f]/.test(title))return false;
    writeContext(lease.workspace_root,{...stored,target_document_title:title,target_document_path:targetPath});
    lease.target_document_title=title;lease.target_document_path=targetPath;
    return true;
  }catch{return false;}
}
