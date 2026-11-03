using System;
using System.Collections.Generic;
using System.IO;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class TeeTakeoffSettlementOrderTests
    {
        private static string Source()
        {
            for(var directory=new DirectoryInfo(AppContext.BaseDirectory);directory!=null;directory=directory.Parent)
                foreach(var prefix in new[]{"apps/revit-bridge-addin","revit-bridge-addin"})
                {
                    var file=Path.Combine(directory.FullName,prefix,"RevitBridge.Logic/Handlers/MEP/ConnectExistingMepBranchHandler.ReplaceTee.cs");
                    if(File.Exists(file))return File.ReadAllText(file);
                }
            throw new InvalidOperationException("Actual native producer source unavailable.");
        }

        [Fact] public void ActualReplacementVerifiesResolvedMetadataOnlyAfterChildCommitBeforeOuterSettlement()
        {
            var source=Source();var start=source.IndexOf("execution=NativeAtomicTransactionGroup.Execute",StringComparison.Ordinal);
            var end=source.IndexOf("finally { app.Application.DocumentChanged-=Changed; }",start,StringComparison.Ordinal);
            var body=source.Substring(start,end-start);var commit=body.IndexOf("if(tx.Commit()!=TransactionStatus.Committed)",StringComparison.Ordinal);
            var verify=body.IndexOf("VerifyReplacement();",StringComparison.Ordinal);
            Assert.True(commit>=0&&verify>commit,"Do not read unresolved new-duct system metadata before the child commit.");
            Assert.Equal(verify,body.LastIndexOf("VerifyReplacement();",StringComparison.Ordinal));
            Assert.True(body.IndexOf("TeeTakeoffPreservation.RequireTransition",StringComparison.Ordinal)>verify);
            Assert.True(body.IndexOf("TeeTakeoffPreservation.RequireFootprint",StringComparison.Ordinal)>verify);
            Assert.True(body.IndexOf("verified=true",StringComparison.Ordinal)>verify);
            Assert.True(body.IndexOf("NativeTransactionDisposition.Rollback",StringComparison.Ordinal)>verify);
            Assert.Contains("ReplacementMetadata(bridge)!=metadata[p.mainElementId]",source);
        }

        [Fact] public void ActualBridgeFailureExplainsGeometryAndMetadataWithoutAcceptingEither()
        {
            var source=Source();
            Assert.Contains("InlineAccessoryMetadataDiagnostic.Describe(metadata[p.mainElementId],ReplacementMetadata(bridge))",source);
            Assert.Contains("bridgeStartErrorFt=",source);Assert.Contains("bridgeEndErrorFt=",source);
            Assert.Contains("line.GetEndPoint(0).DistanceTo(originA)>p.originToleranceFt",source);
            Assert.Contains("line.GetEndPoint(1).DistanceTo(originB)>p.originToleranceFt",source);
        }

        [Theory]
        [InlineData("712041","RolledBack",true)]
        [InlineData(null,"RolledBack",false)]
        [InlineData("712042","RolledBack",false)]
        [InlineData(null,"Pending",false)]
        public void ChildCommitDoesNotBypassPreservationOrUnknownSettlement(string? resolvedSystem,string rollbackStatus,bool matches)
        {
            var childCommitted=false;var outerCommits=0;var rollbacks=0;var status="Started";
            var response=OperatorNativeTransactionExecution.Execute(()=>"Started",
                ()=>{outerCommits++;return status="Committed";},()=>{rollbacks++;return status=rollbackStatus;},()=>status,
                ()=>{childCommitted=true;if(resolvedSystem!="712041")throw new InvalidOperationException("Preservation rejected after child commit");return new Dictionary<string,object?>{["success"]=true};},
                ()=>OperatorNativeTransactionReceipt.CommittedChanges(new[]{20L,21L},new[]{11L,12L,13L},new[]{10L}));
            Assert.True(childCommitted);Assert.Equal(matches?1:0,outerCommits);Assert.Equal(matches?0:1,rollbacks);Assert.Equal(matches,response["success"]);
            if(!matches){var settlement=OperatorAttemptSuccessfulSettlement.Classify(response,"apply","POST","/revit/connect-existing-mep-branch");Assert.Equal(rollbackStatus=="RolledBack"?"none":"unknown",settlement.EffectState);Assert.Empty(settlement.AffectedTargetIdentities);}
        }
    }
}
