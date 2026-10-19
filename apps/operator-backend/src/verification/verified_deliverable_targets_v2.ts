import type {AssignmentSnapshotV2,OperationV2,OperationResultV2} from "../domain/assignment-kernel/index.js";
import {deletionRequestV2} from "./deletion_contract_v2.js";
import {excelTableImportDeliverableTargetsV2} from "./excel_table_import_v2.js";
import {vectorDetailImportDeliverableTargetsV2} from "./vector_detail_import_v2.js";

/** Called only after the independent native postcondition has passed.
 * Platform owners/collateral are not principal work-credit targets. */
export function verifiedDeliverableTargetGroupsV2(snapshot:AssignmentSnapshotV2,verificationSubject:OperationV2|null|undefined,result:OperationResultV2):string[][] {
 const groups:string[][]=[];
    // The native sheet comparator checked every requested placement. The
    // read's containing sheet is not itself the edited deliverable. Keep
    // this platform mapping here; the generic domain consumes only the fact.
    const deletion=verificationSubject&&deletionRequestV2(verificationSubject.input);
    if(verificationSubject&&['/revit/import-excel-output','/revit/import-vector-detail'].includes(verificationSubject.request_identity?.path??'')){
      const deliverables=verificationSubject.request_identity?.path==='/revit/import-vector-detail'
        ?vectorDetailImportDeliverableTargetsV2(snapshot,verificationSubject):excelTableImportDeliverableTargetsV2(snapshot,verificationSubject);
      if(deliverables.length!==1)throw new Error('verified_deliverable_targets_invalid');
      groups.push(deliverables);
    }
    if(deletion)groups.push(deletion.ids.length<=256?deletion.ids.map(id=>'element_id:'+id):[]);
    if (verificationSubject && ["/revit/place-view", "/revit/create-text"].includes(verificationSubject.request_identity?.path ?? "")) {
      // Matching succeeded against retained authoritative commit evidence, not
      // this read's contextual sheet/view identity. A single created/moved
      // annotation is the deliverable; its owner is never continuation credit.
      const ids = verificationSubject.result?.affected_target_identities ?? [];
      const requested = verificationSubject.input.body as Record<string, unknown>;
      const contextual = new Set([`element_id:${requested?.sheetId}`, `element_id:${requested?.viewId}`]);
      const deliverables = ids.filter(id => !contextual.has(id));
      if (deliverables.length !== 1) throw new Error("verified_deliverable_targets_invalid");
      groups.push(deliverables);
    }
    if (verificationSubject?.request_identity?.path === "/revit/move-elements"
        && result.request_identity?.path === "/revit/sheets") {
      const body = verificationSubject.input?.body as Record<string, unknown> | undefined;
      const ids = body?.ids;
      if (!Array.isArray(ids) || !ids.length || ids.length > 256
          || ids.some(id => !Number.isSafeInteger(id) || Number(id) <= 0)
          || new Set(ids).size !== ids.length) throw new Error("verified_deliverable_targets_invalid");
      groups.push(ids.map(id => `element_id:${id}`));
    }
 return groups;
}
