using System;
using System.IO;
using Xunit;
namespace RevitBridge.Common.Tests
{
 public sealed class TextMoveSchedulePreservationContractTests
 {
  private static string Source(string relative)
  {
   for(var d=new DirectoryInfo(AppContext.BaseDirectory);d!=null;d=d.Parent)
    foreach(var prefix in new[]{"apps/revit-bridge-addin","revit-bridge-addin"})
    {var f=Path.Combine(d.FullName,prefix,relative);if(File.Exists(f))return File.ReadAllText(f);}
   throw new FileNotFoundException(relative);
  }
  [Fact] public void TextMoveCapturesBeforeTransactionAndReusesBoundedCollector()
  {
   var s=Source("RevitBridge.Logic/Handlers/MoveElementsHandler.cs");
   var capture=s.IndexOf("AnnotationSchedulePreservation.CaptureBefore(doc)",StringComparison.Ordinal);
   Assert.True(capture>=0 && capture<s.IndexOf("NativeSingleTransaction.Execute",StringComparison.Ordinal));
   Assert.Contains("!p.dryRun",s);Assert.Contains("is TextNote",s);Assert.Contains("AnnotationSchedulePreservation.AttachResult",s);
   Assert.Contains("OperatorNativeTransactionExecution.ReadCommitted",s);
  }
  [Fact] public void SummaryKeepsLegacyArrayAndAddsExplicitIndependentScheduleScope()
  {
   var s=Source("RevitBridge.Logic/Handlers/GetElementSummaryHandler.cs");
   Assert.Contains("List<long>? preservationScheduleIds",s);Assert.Contains("AnnotationSchedulePreservation.AttachRead",s);
   Assert.Contains("return Task.FromResult<object>(results)",s);
  }
 }
}
