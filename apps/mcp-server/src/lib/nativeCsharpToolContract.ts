import {z} from 'zod';
import {DYNAMIC_REVIT_NATIVE_GUIDE} from './dynamicRevitSdkGuide.js';

/** The ordinary actor writes native Revit C#. Historical graph/snapshot
 * executors remain in the runtime for retained evidence and direct callers;
 * they are not competing programming languages in this model-facing tool. */
export const NATIVE_CSHARP_SOURCE_GUIDE = 'C# source with a public class containing public static string Execute(Autodesk.Revit.DB.Document doc). Use Autodesk.Revit.DB directly. Return focused text or JSON with actual result IDs. The host owns the transaction. No IDynamicRevitProgram, c.Plan graph, nested transaction, filesystem, network, SaveAs or model lifecycle calls. Use supported native tools for those host operations.';
export const NATIVE_CSHARP_TOOL_GUIDE = `Execute native Revit C# directly in your current task: custom reads, useful construction batches and corrections. This is a compiler/executor, not another agent. Use read or apply; no separate preview is required. Native API/MCP tools remain available for host operations and useful shortcuts.
${DYNAMIC_REVIT_NATIVE_GUIDE}
For requested text edits, parameter_checks obtains separate native readback without another model turn. For other edits, result_targets identifies intended existing or returned created element IDs for independent readback; dependency notifications are audit data, not verified deliverables. Never replay a committed edit merely to add checks. Inspect actual errors and effects before correcting source. Use fresh visual review when placement or appearance matters; successful execution alone is not task completion.`;

export const NATIVE_CSHARP_TOOL_SHAPE = {
  source:z.string().min(1).max(128_000).describe(NATIVE_CSHARP_SOURCE_GUIDE),
  mode:z.enum(['read','apply']).describe('read: nonmutating native query. apply: authorized host-owned transaction followed by focused result checks.'),
  target_revit_year:z.enum(['2023','2024','2025','2026','2027']).optional(),
  native_program:z.object({
    entry_type:z.string().min(1).max(256),
    effect_scope:z.enum(['listed_elements','active_document']).optional().describe('For general writes use active_document; no predicted collateral IDs. The existing document authorization and actual effect audit still apply.'),
    allowed_existing_unique_ids:z.array(z.string().min(1).max(512)).max(64).optional(),
    allow_create:z.boolean().optional(),
    max_affected_elements:z.number().int().min(0).max(64).optional(),
    deadline_ms:z.number().int().min(250).max(10000).optional(),
    parameter_checks:z.array(z.object({element_id:z.number().int().positive(),parameter_name:z.string().min(1).max(128),expected_value:z.string().max(32768)}).strict()).min(1).max(64).optional().describe('Independent readback of declared text fields on actual modified surviving targets; grants no authority and does not check unrelated fields. Do not combine with result_targets.'),
    result_targets:z.object({element_ids:z.array(z.number().int().positive()).min(1).max(256).optional(),result_field:z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).optional()}).strict().optional().describe('Intended result elements: existing element_ids and/or a top-level JSON result_field containing created IDs. Host checks against the committed footprint and reads actual state. At most256 combined. Include intended deletions. Not authority or whole-task verification; do not combine with parameter_checks.')
  }).strict().describe('Required native C# entrypoint. Read needs no effect targets. General apply uses effect_scope active_document. Existing source/document/session/reference and transaction guards remain in force.')
};
