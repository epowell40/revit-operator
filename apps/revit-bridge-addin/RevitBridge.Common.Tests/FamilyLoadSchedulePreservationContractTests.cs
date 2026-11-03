using System;using System.IO;using Xunit;
namespace RevitBridge.Common.Tests
{
 public sealed class FamilyLoadSchedulePreservationContractTests
 {
  [Fact] public void NewFileLoadCapturesBeforeMutationAndAttachesExistingBoundedObservationAfterCommit()
  {
   string? source=null;
   for(var d=new DirectoryInfo(AppContext.BaseDirectory);d!=null&&source==null;d=d.Parent)
    foreach(var prefix in new[]{"apps/revit-bridge-addin","revit-bridge-addin"})
    {var f=Path.Combine(d.FullName,prefix,"RevitBridge.Logic/Handlers/LoadFamilyHandler.cs");if(File.Exists(f)){source=File.ReadAllText(f);break;}}
   Assert.NotNull(source);var s=source!;
   var capture=s.IndexOf("AnnotationSchedulePreservation.CaptureBefore(doc)",StringComparison.Ordinal);
   Assert.True(capture>=0&&capture<s.IndexOf("enterNativeScope();",StringComparison.Ordinal));
   Assert.True(s.IndexOf("AnnotationSchedulePreservation.AttachResult",StringComparison.Ordinal)>s.IndexOf("OperatorNativeTransactionExecution.ReadCommitted",StringComparison.Ordinal));
   Assert.Contains("!p.overwriteParameterValues",s);Assert.Contains("!beforeIds.Contains(familyId)",s);
   Assert.Contains("NativeSingleTransaction.Execute",s);
  }
 }
}
