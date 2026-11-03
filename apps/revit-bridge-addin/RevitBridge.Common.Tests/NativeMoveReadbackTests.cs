using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class NativeMoveReadbackTests
    {
        private static void ReadCommitted(Dictionary<string,object?> result,IEnumerable<long> ids,double[] vector,Func<Dictionary<string,object?>> readback)
        { OperatorNativeTransactionExecution.ReadCommitted(result,readback);NativeMoveReadback.VerifyCommitted(result,ids,vector); }
        private static Dictionary<string,object?> Run(string snapshots, long[]? ids=null, double[]? delta=null, bool success=true)
        {
            using var document=JsonDocument.Parse(snapshots);
            var response=new Dictionary<string,object?>{["success"]=success,["transaction"]=OperatorNativeTransactionReceipt.Committed(new[]{7L})};
            ReadCommitted(response,ids??new[]{7L},delta??new[]{1d,2d,3d},()=>new Dictionary<string,object?>{["snapshots"]=document.RootElement.Clone()});
            return response;
        }
        private static string PointRows(string kind="LocationPoint",string field="pointXyz",string after="[2,4,6]") =>
            "[{\"id\":7,\"before\":{\"kind\":\""+kind+"\",\""+field+"\":[1,2,3]},\"after\":{\"kind\":\""+kind+"\",\""+field+"\":"+after+"}}]";
        [Theory]
        [InlineData("LocationPoint","pointXyz")][InlineData("TextAnchor","pointXyz")][InlineData("TagHead","pointXyz")]
        [InlineData("ScheduleInsertion","pointXyz")][InlineData("PanelScheduleOrigin","pointXyz")]
        [InlineData("ViewportBoxCenter","pointXyz")][InlineData("ViewportProjectionOrigin","pointXyz")][InlineData("BboxCenter","centerXyz")]
        public void ActualRequestedAnchorTranslationsKeepSuccess(string kind,string field)
        { var r=Run(PointRows(kind,field));Assert.Equal(true,r["verified"]);Assert.Equal(true,r["ok"]); }
        [Fact] public void BothCurveEndpointsMustTranslate()
        {
            const string rows="[{\"id\":7,\"before\":{\"kind\":\"LocationCurve\",\"startXyz\":[1,2,3],\"endXyz\":[5,6,7]},\"after\":{\"kind\":\"LocationCurve\",\"startXyz\":[2,4,6],\"endXyz\":[6,8,10]}}]";
            Assert.Equal(true,Run(rows)["verified"]);Assert.Equal(false,Run(rows.Replace("[6,8,10]","[5,6,7]"))["verified"]);
        }
        [Theory][InlineData("[1,2,3]")][InlineData("[2,2,3]")][InlineData("[2,4,6.0001]")][InlineData("[2,4]")][InlineData("[2,4,\"NaN\"]")]
        public void UnchangedPartialWrongOrMalformedTranslationFails(string after)
        { var r=Run(PointRows(after:after));Assert.Equal(false,r["verified"]);Assert.Equal(false,r["success"]);Assert.Equal(true,r["applied"]);Assert.True(r.ContainsKey("snapshots")); }
        [Fact] public void ZeroRequestedTranslationAndNumericalToleranceAreNotFalseFailures()
        { Assert.Equal(true,Run(PointRows(after:"[1,2,3]"),delta:new double[3])["verified"]);Assert.Equal(true,Run(PointRows(after:"[2.00000001,4,6]"))["verified"]); }
        [Fact] public void MissingSkippedDuplicateAndForeignRowsCannotEstablishTheRequestedSet()
        {
            Assert.Equal(false,Run(PointRows(),new[]{7L,8L})["verified"]);
            Assert.Equal(false,Run("[]")["verified"]);
            Assert.Equal(false,Run(PointRows().Replace("\"id\":7","\"id\":8"))["verified"]);
            Assert.Equal(false,Run("["+PointRows().Trim('[',']')+","+PointRows().Trim('[',']')+"]")["verified"]);
        }
        [Fact] public void GroupRequestRequiresEveryMemberAndExistingFailureCannotBecomeSuccess()
        {
            var both="["+PointRows().Trim('[',']')+","+PointRows().Trim('[',']').Replace("\"id\":7","\"id\":8")+"]";
            Assert.Equal(true,Run(both,new[]{7L,8L})["verified"]);
            Assert.Equal(false,Run(PointRows(),success:false)["verified"]);
        }
        [Fact] public void UnknownAnchorChangedIdentityAndInvalidVectorRemainUnverified()
        {
            Assert.Equal(false,Run(PointRows("Unknown"))["verified"]);
            Assert.Equal(false,Run(PointRows().Replace("\"after\":{","\"after\":{\"ownerViewId\":99,"))["verified"]);
            Assert.Equal(false,Run(PointRows(),delta:new[]{double.NaN,0,0})["verified"]);
        }
        [Fact] public void TranslationDoesNotPermitRotationOrProjectionFrameChanges()
        {
            var rows=PointRows().Replace("\"before\":{","\"before\":{\"rotationRadians\":0,").Replace("\"after\":{","\"after\":{\"rotationRadians\":1,");
            Assert.Equal(false,Run(rows)["verified"]);
            Assert.Equal(true,Run(rows.Replace("\"rotationRadians\":1","\"rotationRadians\":6.283185307179586"))["verified"]);
            rows=PointRows("ViewportProjectionOrigin").Replace("\"before\":{","\"before\":{\"basisXXyz\":[1,0,0],").Replace("\"after\":{","\"after\":{\"basisXXyz\":[0,1,0],");
            Assert.Equal(false,Run(rows)["verified"]);
        }
        [Fact] public void PersistedReadFailureAndUncertainTransactionDoNotLoseNativeHistory()
        {
            var committed=new Dictionary<string,object?>{["success"]=true,["transaction"]=OperatorNativeTransactionReceipt.Committed(new[]{7L})};
            ReadCommitted(committed,new[]{7L},new[]{1d,2d,3d},()=>throw new InvalidOperationException("retained read failure"));
            Assert.Equal(false,committed["verified"]);Assert.Contains("retained read failure",(string)committed["error"]!);Assert.Equal(true,committed["applied"]);
            var uncertain=OperatorNativeTransactionExecution.Execute(()=>"Started",()=>"Pending",()=>"RolledBack",()=>"Pending",()=>new Dictionary<string,object?>(),()=>throw new Exception());
            bool read=false;ReadCommitted(uncertain,new[]{7L},new[]{1d,2d,3d},()=>{read=true;return new Dictionary<string,object?>();});
            Assert.False(read);Assert.Equal(false,uncertain["verified"]);Assert.Null(uncertain["applied"]);Assert.False(uncertain.ContainsKey("movePostcondition"));
        }
        [Fact] public void ProducerUsesRequestedVectorAndKeepsExistingConnectionGuard()
        {
            var directory=new DirectoryInfo(AppContext.BaseDirectory);while(directory!=null&&!File.Exists(Path.Combine(directory.FullName,"RevitBridge.Logic","Handlers","MoveElementsHandler.cs")))directory=directory.Parent;
            Assert.NotNull(directory);var source=File.ReadAllText(Path.Combine(directory!.FullName,"RevitBridge.Logic","Handlers","MoveElementsHandler.cs"));
            Assert.Contains("OperatorNativeTransactionExecution.ReadCommitted(response,",source);
            Assert.Contains("NativeMoveReadback.VerifyCommitted(response, p.ids, new[] { vector.X, vector.Y, vector.Z }",source);
            Assert.True(source.IndexOf("NativeMoveReadback.VerifyCommitted",StringComparison.Ordinal)>source.IndexOf("OperatorNativeTransactionExecution.ReadCommitted",StringComparison.Ordinal));
            Assert.Contains("connectedScope!.ReadAndVerify(true)",source);
        }
        [Fact]
        public void Retained114CommittedUnchangedAnchorCannotBeVerifiedAsMoved()
        {
            using var fixture=JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Fixtures","move-no-displacement114.json")));
            var f=fixture.RootElement;
            var response=new Dictionary<string,object?> { ["success"]=true,
                ["transaction"]=OperatorNativeTransactionReceipt.Committed(Array.Empty<long>()).WithNativeModifiedElements(f.GetProperty("modifiedIds").EnumerateArray().Select(x=>x.GetInt64())) };
            ReadCommitted(response,new[]{1456396L},new[]{0d,-1d/3,0d},()=>new Dictionary<string,object?>{["snapshots"]=f.GetProperty("snapshots").Clone()});
            Assert.Equal(false,response["verified"]);
            Assert.Equal(false,response["success"]);
            Assert.Equal(true,response["applied"]);
            Assert.Equal("applied",OperatorAttemptSuccessfulSettlement.Classify(response,"apply","POST","/revit/move-elements").EffectState);
            Assert.True(response.ContainsKey("snapshots"));
        }
    }
}
