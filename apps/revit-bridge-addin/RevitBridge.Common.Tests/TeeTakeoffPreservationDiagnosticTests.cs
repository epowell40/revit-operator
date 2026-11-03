using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;
namespace RevitBridge.Common.Tests
{
    public class TeeTakeoffPreservationDiagnosticTests
    {
        private static string Root()
        {
            var d=new DirectoryInfo(AppContext.BaseDirectory);
            while(d!=null){if(File.Exists(Path.Combine(d.FullName,"RevitBridge.Logic","Handlers","MEP","ConnectExistingMepBranchHandler.ReplaceTee.cs")))return d.FullName;d=d.Parent;}
            throw new Exception("Native source root missing");
        }
        [Fact] public void Exact108UncoveredFootprintRemainsRejectedAndCanBeExplained()
        {
            using var doc=JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Fixtures","tee-preservation-failure108.json")));
            var f=doc.RootElement;var b=f.GetProperty("before");var child=f.GetProperty("child");
            long[] Ids(JsonElement e)=>e.EnumerateArray().Select(x=>x.GetInt64()).ToArray();
            var added=Ids(child.GetProperty("addedIds"));var deleted=Ids(child.GetProperty("deletedIds"));var modified=Ids(child.GetProperty("modifiedIds"));
            var allowed=Ids(b.GetProperty("requestedElementIds")).Concat(b.GetProperty("centerlines").EnumerateArray().Select(x=>x.GetProperty("elementId").GetInt64()))
                .Concat(added).Concat(new[]{b.GetProperty("system").GetProperty("elementId").GetInt64()}).Concat(Ids(b.GetProperty("schedulePreservation").GetProperty("requestedElementIds"))).Except(deleted).Distinct().ToArray();
            var rejected=Assert.Throws<InvalidOperationException>(()=>TeeTakeoffPreservation.RequireFootprint(added,deleted,allowed,added,deleted,modified));
            Assert.Equal(f.GetProperty("error").GetString(),rejected.Message);Assert.Equal(13,modified.Except(allowed).Count());
            var type=typeof(TeeTakeoffPreservation).Assembly.GetType("RevitBridge.Common.TeeTakeoffPreservationDiagnostic");Assert.NotNull(type);
            var footprint=JsonSerializer.SerializeToElement(new{teeId=f.GetProperty("tee").GetInt64(),bridgeId=Ids(f.GetProperty("created"))[0],fittingId=Ids(f.GetProperty("created"))[1],retainedIds=Ids(f.GetProperty("retained")),expectedAddedIds=added,expectedDeletedIds=deleted,addedIds=added,deletedIds=deleted,modifiedIds=modified,allowedModifiedIds=allowed});
            var result=(string)type!.GetMethod("Describe")!.Invoke(null,new object[]{"footprint",b,b,footprint})!;
            Assert.Contains("diagnosticOnly",result);Assert.Contains("unexpectedModifiedIds",result);Assert.Contains("1402993",result);Assert.DoesNotContain("\"success\":true",result);
        }
        [Fact] public void NativeConsumerAddsFailureDetailWithoutPromotingFailedObservation()
        {
            var source=File.ReadAllText(Path.Combine(Root(),"RevitBridge.Logic","Handlers","MEP","ConnectExistingMepBranchHandler.ReplaceTee.cs"));
            Assert.Contains("TeeTakeoffPreservationDiagnostic.Describe",source);
            Assert.Contains("preservationStage=\"footprint\"",source);
            Assert.True(source.IndexOf("preservationAfter=after;verified=true;",StringComparison.Ordinal)>source.IndexOf("TeeTakeoffPreservationDiagnostic.Describe",StringComparison.Ordinal));
            Assert.Contains("NativeTransactionDisposition.Rollback",source);
        }
    }
}
