import {
  readLaboratoryEvidenceDispatchBinding,
  type LaboratoryEvidenceDispatch
} from "./laboratoryEvidenceDispatch.js";
import {
  admitLaboratoryMoveEvidenceRequest,
  assertLaboratoryMoveExecutionReceipt,
  issueLaboratoryMovePreviewLineage
} from "./laboratoryMoveEvidence.js";
import { callRevit } from "./revitClient.js";
import { runWithRevitToolAlias } from "./toolExposurePolicy.js";

/** Exact evidence-only analogue of the public typed move wrapper. */
export async function callLaboratoryMoveOneEvidence<T = unknown>(input: {
  evidenceDispatch: LaboratoryEvidenceDispatch;
  request: unknown;
}): Promise<Readonly<{ result: T; previewReceipt?: string }>> {
  const dispatch = readLaboratoryEvidenceDispatchBinding(input.evidenceDispatch);
  const admission = admitLaboratoryMoveEvidenceRequest(input);
  const result = await runWithRevitToolAlias("revit_move_one_certified", async () => callRevit<T>("/revit/move-elements", "POST", admission.outboundBody, {
    channel: "typed_mcp",
    workflow: dispatch.workflow,
    laboratoryEvidenceDispatch: input.evidenceDispatch,
    laboratoryMoveEvidenceAdmission: admission
  }));
  if (admission.request.request.phase === "preview") {
    return Object.freeze({ result, previewReceipt: issueLaboratoryMovePreviewLineage(admission, result) });
  }
  assertLaboratoryMoveExecutionReceipt(admission, result);
  return Object.freeze({ result });
}
