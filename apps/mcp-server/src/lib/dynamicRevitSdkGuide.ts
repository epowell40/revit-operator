export const DYNAMIC_REVIT_READ_SAMPLE = `using System;
using System.Linq;
using RevitOperator.DynamicRevitSdk;
public sealed class SampleReport : IDynamicRevitProgram {
  public DynamicProgramResult Execute(DynamicRevitContext c) {
    c.Report("Inspected", c.Elements.Count.ToString());
    foreach (var group in c.Elements.GroupBy(e => e.TypeName ?? "(unnamed)"))
      c.Report("Type: " + group.Key, group.Count().ToString());
    c.Report("Limit", "Bounded snapshot sample; not a complete model inventory.");
    return c.Complete();
  }
}`;

export const DYNAMIC_REVIT_SOURCE_GUIDE = `C# 12; exactly one public IDynamicRevitProgram implementation with DynamicProgramResult Execute(DynamicRevitContext c), using RevitOperator.DynamicRevitSdk. The generated program runs outside Revit with DTOs, not Autodesk.Revit.DB/doc/Document or Python. No filesystem, network, processes, reflection, or dynamic binding. No shell or local SDK search is needed.
Basic SDK: c.Input.Document has Title, ProjectFingerprint, SessionId, ActiveViewName. c.Elements is IReadOnlyList<DynamicElementDto>: UniqueId:string, ElementId:long, Category:string, FamilyName/TypeName:string?, Parameters:Dictionary<string,string?>, WritableParameters:string[], Location:DynamicPointDto? (X,Y,Z in feet), IsPinned/IsGrouped:bool. c.Report(string key,string value) retains up to 64 entries (key<=128,value<=1024); c.Log(string) retains up to 64 bounded lines; return c.Complete(). LINQ and ordinary deterministic C# algorithms are supported. Only when edits are authorized: c.Plan.MoveElement(element,xFeet,yFeet,zFeet), c.Plan.SetParameter(element,parameter,value). Report-only programs must leave the graph empty. Set category=OST_DuctCurves and snapshot_limit=20 for a bounded duct sample; do not call the sample a census.
Working report example:
${DYNAMIC_REVIT_READ_SAMPLE}
Use mode:"read" for reports. Omit optional time limits normally; worker_deadline_ms is 1000..30000 and apply_deadline_ms is 100..5000. operation_budget is 1..256 even for an empty report graph; it also caps native affected elements, including Revit's dependent changes. The successful raw tool payload contains report and logs at its root. For canonical result delivery select resultItems path:["report"] from the returned Observation ID, without adding a payload wrapper.
Advanced: IDynamicResultReferenceRevitProgramV1 uses result_reference, c.Fact(...), c.TraceStep(...), c.Require(...), c.NeedFacts(...) or c.Complete(). Use its exact domain contract before composing MEP/annotation graphs. Repair a compile error with changed source and resume:{prior_run_id,prior_evidence_sha256,mode:"repair"}; five attempts share one evidence-bound loop.`;

// Some code-mode clients omit property descriptions when generating TypeScript
// declarations. Keep the executable contract at tool level as well.
export const DYNAMIC_REVIT_TOOL_GUIDE = `Compile and run bounded generated C# on the trusted workstation. read permits reports only; preview rolls back model operations; apply requires fresh host authorization, commit and readback. Machine access stays restricted. In code mode, print text(result) directly: the tool result can already be rendered text, so do not assume result.content or stringify a rendered string. On failure, inspect failure/diagnostics before another execution. Runtime errors include generated source locations when available. PROGRAM_PARTIAL_OUTPUT contains bounded, unverified logs/report from a failed replay; it is not proof of inspected targets, completed calculations, or model changes. Use the exact retained repair lineage for corrected source. Leave operation_budget at its default normally; one direct edit can affect multiple dependent Revit elements, so operation_budget:1 does not express a one-target constraint. Constrain the generated graph to that one target instead. Five evidence-bound repair attempts form one loop; committed_verified checkpoints permit up to 64 separately verified steps. Certified-only exposure remains fail-closed.\n\n${DYNAMIC_REVIT_SOURCE_GUIDE}`;
