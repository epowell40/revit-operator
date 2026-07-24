import { resolveExistingFileUnderWorkspace, resolveFileUnderWorkspace } from "../workspace.js";
import {
  buildExistingConditionsSourceTargetManifestV1,
  type ExistingConditionsSourceTargetManifestV1
} from "../existing_conditions/source_target_manifest_ledger.js";
import {
  validateSheetCandidatePresenceV1,
  validateSheetPixelEvidenceV1,
  type SheetCandidatePresenceReceiptV1,
  type SheetPixelEvidenceReceiptV1
} from "../existing_conditions/sheet_pixel_evidence.js";
import {
  compileSheetPixelInterpretationV1,
  type SheetPixelInterpretationContextV1,
  type SheetPixelInterpretationInputV1
} from "../existing_conditions/sheet_pixel_interpretation.js";

export type CompileSheetInterpretationActionV1 = {
  interpretation_file_path: string;
  context_file_path: string;
  source_image_path: string;
  source_view_key?: string;
  overlay_output_path?: string;
  receipt_output_path?: string;
};

type WorkbenchReadFile = {
  pathRel: string;
  content: string;
  bytes: number;
  truncated: boolean;
};

type CompileSheetInterpretationResult = {
  ok: boolean;
  summary: string;
  details?: Record<string, unknown>;
};

function hydrateSheetEvidenceReceiptFiles(
  context: SheetPixelInterpretationContextV1,
  maxBytes: number,
  readFile: (path: string, maximumBytes: number) => WorkbenchReadFile
): { context?: SheetPixelInterpretationContextV1; error?: string } {
  const receiptPaths = context.evidence_receipt_file_paths ?? [];
  if (!Array.isArray(receiptPaths) || receiptPaths.length > 24) {
    return { error: "Sheet trusted context evidence_receipt_file_paths must contain at most 24 entries." };
  }
  const rasterEvidence = [...(context.raster_evidence_receipts ?? [])];
  const candidatePresence = [...(context.candidate_presence_receipts ?? [])];
  for (const [index, value] of receiptPaths.entries()) {
    if (typeof value !== "string" || !value.trim()) return { error: `Sheet evidence receipt path ${index} is invalid.` };
    let file: WorkbenchReadFile;
    try {
      file = readFile(value, maxBytes);
    } catch {
      return { error: `Sheet evidence receipt ${value} is not a readable Workspace file.` };
    }
    if (file.truncated) return { error: `Sheet evidence receipt ${value} exceeds the configured workbench read limit.` };
    let document: Record<string, unknown>;
    try {
      document = JSON.parse(file.content) as Record<string, unknown>;
    } catch {
      return { error: `Sheet evidence receipt ${value} is not valid JSON.` };
    }
    const raster = document.raster_evidence as SheetPixelEvidenceReceiptV1 | undefined;
    const candidate = document.candidate_presence as SheetCandidatePresenceReceiptV1 | undefined;
    if (!raster && !candidate) return { error: `Sheet evidence receipt ${value} contains neither raster_evidence nor candidate_presence.` };
    if (raster) rasterEvidence.push(raster);
    if (candidate) candidatePresence.push(candidate);
  }
  return {
    context: {
      ...context,
      raster_evidence_receipts: rasterEvidence,
      candidate_presence_receipts: candidatePresence
    }
  };
}

export async function executeCompileSheetInterpretationActionV1(args: {
  action: CompileSheetInterpretationActionV1;
  maxReadBytes: number;
  readFile: (path: string, maximumBytes: number) => WorkbenchReadFile;
  writeFile: (path: string, content: string) => { pathRel: string; bytes: number };
  registerSourceTargetManifest?: (
    manifest: ExistingConditionsSourceTargetManifestV1
  ) => Promise<Record<string, unknown>>;
}): Promise<CompileSheetInterpretationResult> {
  const { action, maxReadBytes } = args;
  const interpretationPath = (action.interpretation_file_path ?? "").trim();
  const contextPath = (action.context_file_path ?? "").trim();
  const imagePath = (action.source_image_path ?? "").trim();
  if (!interpretationPath || !contextPath || !imagePath) {
    return {
      ok: false,
      summary: "compile_existing_conditions_sheet_interpretation requires interpretation_file_path, context_file_path, and source_image_path."
    };
  }
  const interpretationFile = args.readFile(interpretationPath, maxReadBytes);
  const contextFile = args.readFile(contextPath, maxReadBytes);
  if (interpretationFile.truncated || contextFile.truncated) {
    return { ok: false, summary: "Sheet interpretation inputs exceed the configured workbench read limit." };
  }
  let interpretation: SheetPixelInterpretationInputV1;
  let context: SheetPixelInterpretationContextV1;
  try {
    const interpretationDocument = JSON.parse(interpretationFile.content) as Record<string, unknown>;
    interpretation = (
      interpretationDocument?.interpretation &&
      typeof interpretationDocument.interpretation === "object" &&
      !Array.isArray(interpretationDocument.interpretation)
        ? interpretationDocument.interpretation
        : interpretationDocument
    ) as SheetPixelInterpretationInputV1;
    context = JSON.parse(contextFile.content) as SheetPixelInterpretationContextV1;
  } catch {
    return { ok: false, summary: "Sheet interpretation or trusted context is not valid JSON." };
  }
  if (
    interpretation?.schema_version !== 1 ||
    !Array.isArray(interpretation.view_keys) ||
    !Array.isArray(interpretation.primitives) ||
    !context ||
    !Array.isArray(context.trusted_views)
  ) {
    return { ok: false, summary: "Sheet interpretation or trusted context does not satisfy the schema-v1 input contract." };
  }
  const hydratedContext = hydrateSheetEvidenceReceiptFiles(context, maxReadBytes, args.readFile);
  if (!hydratedContext.context) {
    return { ok: false, summary: hydratedContext.error ?? "Sheet evidence receipt hydration failed." };
  }
  context = hydratedContext.context;
  const resolvedImagePath = resolveExistingFileUnderWorkspace(imagePath);
  const requestedViewKey = (action.source_view_key ?? "").trim();
  const effectiveViewKey = requestedViewKey || (interpretation.view_keys.length === 1 ? interpretation.view_keys[0]! : "");
  const viewInterpretation: SheetPixelInterpretationInputV1 = effectiveViewKey
    ? {
        ...interpretation,
        view_keys: [effectiveViewKey],
        source_marks: interpretation.source_marks.filter(mark => mark.source_view_key === effectiveViewKey),
        primitives: interpretation.primitives.filter(primitive => primitive.source_view_key === effectiveViewKey)
      }
    : interpretation;
  const priorReceipt = (context.raster_evidence_receipts ?? []).find(receipt =>
    !effectiveViewKey || receipt.source_view_key === effectiveViewKey
  );
  const trustedRasterPolicy = context.raster_evidence_policy_by_view?.[effectiveViewKey];
  const overlayPath = (action.overlay_output_path ?? "").trim();
  const rasterReceipt = await validateSheetPixelEvidenceV1({
    image_path: resolvedImagePath,
    interpretation: viewInterpretation,
    ...(effectiveViewKey ? { source_view_key: effectiveViewKey } : {}),
    ...(trustedRasterPolicy || priorReceipt?.policy
      ? { policy: { ...(priorReceipt?.policy ?? {}), ...(trustedRasterPolicy ?? {}) } }
      : {}),
    ...(overlayPath ? { overlay_path: resolveFileUnderWorkspace(overlayPath) } : {})
  });
  const trustedView = context.trusted_views.find(value => value.source_view.view_key === rasterReceipt.source_view_key);
  const candidateRaster = context.candidate_raster_by_view?.[rasterReceipt.source_view_key];
  const candidatePresence = candidateRaster && trustedView
    ? await validateSheetCandidatePresenceV1({
        image_path: resolveExistingFileUnderWorkspace(candidateRaster.image_path),
        expected_image_sha256: candidateRaster.image_sha256,
        candidate_frame: candidateRaster.frame,
        source_frame: trustedView.frame,
        interpretation: viewInterpretation,
        source_evidence: rasterReceipt,
        policy: candidateRaster.policy ?? trustedRasterPolicy ?? priorReceipt?.policy,
        ...(candidateRaster.overlay_output_path
          ? { overlay_path: resolveFileUnderWorkspace(candidateRaster.overlay_output_path) }
          : {})
      })
    : undefined;
  const compiled = compileSheetPixelInterpretationV1(interpretation, {
    ...context,
    raster_evidence_receipts: [
      ...(context.raster_evidence_receipts ?? []).filter(receipt => receipt.source_view_key !== rasterReceipt.source_view_key),
      rasterReceipt
    ],
    ...(candidatePresence
      ? {
        candidate_presence_receipts: [
          ...(context.candidate_presence_receipts ?? []).filter(receipt => receipt.source_view_key !== candidatePresence.source_view_key),
          candidatePresence
        ]
      }
      : {})
  });
  const receipt = {
    schema_version: 1,
    interpretation_path: interpretationFile.pathRel,
    context_path: contextFile.pathRel,
    raster_evidence: rasterReceipt,
    ...(candidatePresence ? { candidate_presence: candidatePresence } : {}),
    compilation: compiled
  };
  const topology = compiled.compiled_topology;
  const ok = topology.status === "ready" || topology.status === "partially_ready";
  const manifest = ok
    ? buildExistingConditionsSourceTargetManifestV1({ interpretation, context, compiled, sourceReceipt: receipt })
    : undefined;
  const receiptOutputPath = (action.receipt_output_path ?? "").trim();
  const persisted = receiptOutputPath
    ? args.writeFile(receiptOutputPath, `${JSON.stringify(receipt, null, 2)}\n`)
    : undefined;
  const manifestRegistration = manifest && args.registerSourceTargetManifest
    ? await args.registerSourceTargetManifest(manifest)
    : undefined;
  return {
    ok,
    summary:
      `Sheet interpretation compiled; status=${topology.status}, accepted_routes=${rasterReceipt.route_evidence.filter(value => value.status === "accepted_raster_support").length}, ` +
      `rejected_routes=${rasterReceipt.route_evidence.filter(value => value.status === "rejected_raster_extent").length}, ` +
      `accepted_points=${(rasterReceipt.point_evidence ?? []).filter(value => value.status === "accepted_raster_support").length}, ` +
      `rejected_points=${(rasterReceipt.point_evidence ?? []).filter(value => value.status === "rejected_raster_extent").length}, ` +
      `existing_points=${candidatePresence?.existing_candidate_visible_primitive_ids.length ?? 0}, ` +
      `source_targets=${manifest?.target_count ?? 0}, identity_groups=${compiled.candidate_identity_groups.length}, junctions=${topology.junctions.length}.`,
    details: {
      ...receipt,
      ...(manifest ? { source_target_manifest: manifest } : {}),
      ...(manifestRegistration ? { source_target_manifest_registration: manifestRegistration } : {}),
      ...(persisted ? { persisted_receipt: persisted } : {})
    }
  };
}
