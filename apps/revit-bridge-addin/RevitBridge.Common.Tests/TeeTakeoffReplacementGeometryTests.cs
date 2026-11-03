using System;
using System.Text.Json;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class TeeTakeoffReplacementGeometryTests
    {
        [Fact] public void CollateralDeletionDiagnosticMatchesGoldenWithoutAllowingDeletion()
        {
            using var fixture=JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Fixtures","tee-deletion-candidate-diagnostics334.json")));
            var root=fixture.RootElement;
            var error=Assert.Throws<InvalidOperationException>(()=>TeeTakeoffReplacementGeometry.RequireOnlyRequestedDeletion(
                root.GetProperty("teeId").GetInt64(),root.GetProperty("candidateIds").EnumerateArray().Select(x=>x.GetInt64())));
            Assert.Equal(root.GetProperty("expectedError").GetString(),error.Message);
        }
        [Fact] public void CandidateDiagnosticsAreBoundedAndNeverAcceptMissingOrDuplicateTee()
        {
            var ids=new[]{10L}.Concat(Enumerable.Range(1000,100).Select(x=>(long)x)).ToArray();
            var error=Assert.Throws<InvalidOperationException>(()=>TeeTakeoffReplacementGeometry.RequireOnlyRequestedDeletion(10,ids));
            Assert.Contains("candidateCount=101; additionalCandidateCount=100",error.Message);
            Assert.Contains("additionalCandidateIds(first16)=[1000,1001,1002,1003,1004,1005,1006,1007,1008,1009,1010,1011,1012,1013,1014,1015]",error.Message);
            Assert.DoesNotContain("1099",error.Message);Assert.True(error.Message.Length<1400);
            Assert.Throws<InvalidOperationException>(()=>TeeTakeoffReplacementGeometry.RequireOnlyRequestedDeletion(10,new[]{10L,10L}));
            Assert.Throws<InvalidOperationException>(()=>TeeTakeoffReplacementGeometry.RequireOnlyRequestedDeletion(10,new[]{11L}));
            Assert.Throws<InvalidOperationException>(()=>TeeTakeoffReplacementGeometry.RequireOnlyRequestedDeletion(0,new[]{10L}));
            TeeTakeoffReplacementGeometry.RequireOnlyRequestedDeletion(10,new[]{10L});
        }
        private static BranchPoint3d P(double x,double y,double z=0)=>new BranchPoint3d(x,y,z);
        private static TeeTakeoffBridgePlan Plan(BranchPoint3d? branch=null,BranchPoint3d? secondDirection=null,
            double secondDiameter=2.0/3.0,double tolerance=0.001)=>TeeTakeoffReplacementGeometry.Plan(
                P(0,0),P(5.0/6.0,0),branch??P(5.0/12.0,0.5),P(-1,0),secondDirection??P(1,0),
                2.0/3.0,secondDiameter,0.5,0.0026,tolerance);

        [Fact] public void OpposedEightInchRunsSupportTenInchBridgeAndSixInchOffset()
        { var p=Plan();Assert.Equal(0.5,p.ProjectionFraction,8);Assert.Equal(0.5,p.BranchOffsetFt,8); }
        [Theory]
        [InlineData(0,0.5)] [InlineData(5.0/6.0,0.5)] [InlineData(-1,0.5)] [InlineData(2,0.5)] [InlineData(0.4,0)]
        public void EndOrOutsideOrAxialBranchesCannotUseTakeoff(double x,double y)
        { Assert.Throws<ArgumentException>(()=>Plan(P(x,y))); }
        [Fact] public void NonCollinearAndUnequalRunsAreNotSilentlyResizedOrRerouted()
        { Assert.Throws<ArgumentException>(()=>Plan(secondDirection:P(0,1)));Assert.Throws<ArgumentException>(()=>Plan(secondDiameter:0.5)); }
        [Theory] [InlineData(double.NaN)] [InlineData(double.PositiveInfinity)] [InlineData(0)] [InlineData(-1)] [InlineData(0.02)]
        public void UnsafeTolerancesAreRejected(double t){Assert.Throws<ArgumentException>(()=>Plan(tolerance:t));}
        [Fact] public void DisplacedWorldCoordinatesAndReverseRunOrderRetainInteriorProjection()
        {var p=TeeTakeoffReplacementGeometry.Plan(P(45.66666666666698,33.93863490109544,11.646412997721605),
            P(44.83333333333365,33.93863490109544,11.646412997721606),P(45.25000000000031,34.43863490109544,11.646412997721606),
            P(1,0),P(-1,0),2.0/3.0,2.0/3.0,0.5,0.0026,0.001);
            Assert.Equal(0.5,p.ProjectionFraction,8);Assert.Equal(0.5,p.BranchOffsetFt,8);}
        [Fact] public void DeletionCascadeCannotRemoveMainOrExistingTag()
        {TeeTakeoffReplacementGeometry.RequireOnlyRequestedDeletion(10,new[]{10L});
            Assert.Throws<InvalidOperationException>(()=>TeeTakeoffReplacementGeometry.RequireOnlyRequestedDeletion(10,new[]{10L,11L}));
            Assert.Throws<InvalidOperationException>(()=>TeeTakeoffReplacementGeometry.RequireOnlyRequestedDeletion(10,Array.Empty<long>()));}

        [Theory]
        [InlineData("{}",true)]
        [InlineData("{\"connectionMode\":\"takeoff_fitting\",\"teeElementId\":10}",false)]
        [InlineData("{\"connectionMode\":\"air_terminal_on_duct\",\"secondMainElementId\":12}",false)]
        [InlineData("{\"connectionMode\":\"replace_tee_with_takeoff\"}",false)]
        [InlineData("{\"connectionMode\":\"replace_tee_with_takeoff\",\"kind\":\"duct\",\"teeElementId\":10,\"mainElementId\":11,\"secondMainElementId\":12,\"branchElementId\":13,\"expectedTakeoffTypeId\":20}",true)]
        public void ModesCannotSilentlyIgnoreReplacementIntent(string json,bool accepted)
        {using var doc=JsonDocument.Parse(json);Assert.Equal(accepted,TeeTakeoffReplacementContract.TryValidate(doc.RootElement,out _));}

        [Theory]
        [InlineData("\"verify\":false")]
        [InlineData("\"worksetId\":7")]
        [InlineData("\"originToleranceFt\":0.02")]
        [InlineData("\"originToleranceFt\":-1")]
        [InlineData("\"branchElementId\":11")]
        [InlineData("\"kind\":\"pipe\"")]
        [InlineData("\"expectedTakeoffTypeId\":0")]
        public void ReplacementContractRejectsUnsafeOrAmbiguousRequests(string extra)
        {using var doc=JsonDocument.Parse("{\"connectionMode\":\"replace_tee_with_takeoff\",\"kind\":\"duct\",\"teeElementId\":10,\"mainElementId\":11,\"secondMainElementId\":12,\"branchElementId\":13,\"expectedTakeoffTypeId\":20,"+extra+"}");
            Assert.False(TeeTakeoffReplacementContract.TryValidate(doc.RootElement,out _));}

        [Fact] public void DeletionCascadeAfterChildMutationRollsBackTheWholeReplacement()
        {
            var status="Uninitialized";var rollback=0;
            var result=OperatorNativeTransactionExecution.Execute(()=>status="Started",()=>throw new Exception("Must not commit"),
                ()=>{rollback++;return status="RolledBack";},()=>status,
                ()=>{TeeTakeoffReplacementGeometry.RequireOnlyRequestedDeletion(10,new[]{10L,99L});return new Dictionary<string,object?>();},
                ()=>throw new Exception("No commit receipt"),()=>new[]{20L,21L},()=>new[]{11L,12L,13L},
                nativeDeletedElements:()=>new[]{10L});
            Assert.Equal(1,rollback);Assert.Equal(false,result["success"]);
            var tx=Assert.IsType<OperatorNativeTransactionReceipt>(result["transaction"]);
            Assert.Equal("rolled_back",tx.Status);Assert.Empty(tx.AddedElementIds);Assert.Empty(tx.DeletedElementIds);
        }

        [Fact] public void LostAssimilationResponseRetainsCommittedTeeDeletionAndNewBridge()
        {
            var result=OperatorNativeTransactionExecution.Execute(()=>"Started",()=>throw new Exception("Lost commit response"),
                ()=>throw new Exception("Known commit must not be rolled back"),()=>"Committed",()=>new Dictionary<string,object?>{["success"]=true},
                ()=>OperatorNativeTransactionReceipt.CommittedChanges(new[]{20L,21L},new[]{11L,12L,13L},new[]{10L}),
                ()=>new[]{20L,21L},()=>new[]{11L,12L,13L},nativeDeletedElements:()=>new[]{10L});
            var tx=Assert.IsType<OperatorNativeTransactionReceipt>(result["transaction"]);
            Assert.True(tx.CommittedValue);Assert.Equal(new[]{10L},tx.DeletedElementIds);Assert.Equal(new[]{20L,21L},tx.AddedElementIds);
            Assert.Equal(false,result["success"]);
        }
    }
}
