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
Use mode:"read" for reports. The successful raw tool payload contains report and logs at its root. For canonical result delivery select resultItems path:["report"] from the returned Observation ID, without adding a payload wrapper.
Advanced: IDynamicResultReferenceRevitProgramV1 uses result_reference, c.Fact(...), c.TraceStep(...), c.Require(...), c.NeedFacts(...) or c.Complete(). Use its exact domain contract before composing MEP/annotation graphs. Repair a compile error with changed source and resume:{prior_run_id,prior_evidence_sha256,mode:"repair"}; five attempts share one evidence-bound loop.`;
