import { isSupportedNativeTool } from "../capabilities/supported_tool_inventory.js";
import { isRevitCourierDevelopmentLaboratory, RevitCourierCertificationError } from "./revit_tool_job_certification.js";

type ClaimCandidate = {
  method: string;
  path: string;
  status: string;
  version: string;
  general_agent_admission?: unknown;
};

/** Evaluate support only after durable terminal receipts have been reconciled. */
export function admitCourierJobClaim(
  job: ClaimCandidate,
  legacyVersion: string,
  reject: (error: RevitCourierCertificationError) => void
): boolean {
  if (!isSupportedNativeTool(job.method, job.path)) {
    // A running operation may already have committed. Do not manufacture a
    // not-dispatched terminal receipt when its route is later withdrawn.
    if (job.status === "pending") reject(new RevitCourierCertificationError(
      "PRODUCT_TOOL_NOT_SUPPORTED", "The pending tool is outside the fixed supported product inventory."
    ));
    return false;
  }
  if (job.version === legacyVersion
    && job.general_agent_admission === undefined
    && !isRevitCourierDevelopmentLaboratory()) {
    reject(new RevitCourierCertificationError(
      "CERTIFICATION_LEGACY_V1_DENIED",
      "Legacy v1 Revit courier jobs require an authenticated General Agent admission or the exact development laboratory profile."
    ));
    return false;
  }
  return true;
}
