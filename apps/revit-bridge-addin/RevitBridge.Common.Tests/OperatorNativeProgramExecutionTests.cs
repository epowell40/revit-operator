using System;
using System.Collections.Generic;
using RevitBridge.Common;
using Xunit;

public sealed class OperatorNativeProgramExecutionTests
{
    private sealed class UnreadableDiagnosticException : Exception
    { public override System.Collections.IDictionary Data => throw new InvalidOperationException("unreadable diagnostic"); }
    [Fact] public void DiagnosticReadFailureCannotHideOriginalResult()
    {
        var result=new Dictionary<string,object?>{{"success",false},{"error","original"}};
        OperatorNativeProgramExecution.AppendRuntimeDiagnostic(result,new UnreadableDiagnosticException());
        Assert.Equal("original",result["error"]);
    }
    [Fact]
    public void RuntimeRepairHintPreservesFailureAndUnknownSettlement()
    {
        var error=new ArgumentNullException(null,"Value cannot be null.");
        error.Data["revit_operator.native_source_line.v1"]=1;
        error.Data["revit_operator.native_source_column.v1"]=5125;
        var status="Uninitialized";
        var result=OperatorNativeProgramExecution.ExecuteWrite(()=>status="Started",()=>"Committed",()=>"Committed",
            ()=>throw new Exception("rollback failed"),()=>status,()=>throw error,
            ()=>Array.Empty<long>(),()=>Array.Empty<long>(),()=>Array.Empty<long>(),Array.Empty<long>(),true,1);
        var receipt=Receipt(result);
        var original=(string)result["error"]!;
        OperatorNativeProgramExecution.AppendRuntimeDiagnostic(result,error);
        Assert.StartsWith(original,(string)result["error"]!);
        Assert.Contains("source line 1, column 5125",(string)result["error"]!);
        Assert.Contains("not an exact throw-site",(string)result["error"]!);
        Assert.Same(receipt,Receipt(result));Assert.Null(receipt.CommittedValue);
        Assert.False((bool)result["success"]!);Assert.False(result.ContainsKey("verified"));
    }

    [Theory]
    [InlineData("missing")][InlineData("malformed")][InlineData("negative")][InlineData("oversize")]
    [InlineData("cancel")][InlineData("timeout")][InlineData("success")]
    public void RuntimeDiagnosticCannotInventLocationOrChangeStopAndSuccess(string kind)
    {
        Exception error=kind=="cancel"?new OperationCanceledException("stop"):kind=="timeout"?new TimeoutException("stop"):new Exception("failure");
        if(kind!="missing"){
            error.Data["revit_operator.native_source_line.v1"]=kind=="malformed"?(object)"1":kind=="negative"?-1:kind=="oversize"?200001:1;
            error.Data["revit_operator.native_source_column.v1"]=2;
        }
        var result=new Dictionary<string,object?>{{"success",kind=="success"},{"error","unchanged"}};
        OperatorNativeProgramExecution.AppendRuntimeDiagnostic(result,error);
        Assert.Equal("unchanged",result["error"]);
    }

    [Fact]
    public void SourceStepDiagnosticIsBoundedConservativeAndRejectsMissingOrMalformedMarkers()
    {
        foreach(var marker in new string?[]{null,"","0:4","1:0","-1:3","1:2:3","+1:2","9999999999999999:1","1:C:/private","1:2\nforged"}) {
            var error=new Exception("original");error.Data["revit_operator.native_source_line.v1"]=marker;error.Data["revit_operator.native_source_column.v1"]=4;
            var result=new Dictionary<string,object?>{{"success",false},{"error","original"}};
            OperatorNativeProgramExecution.AppendRuntimeDiagnostic(result,error);Assert.Equal("original",result["error"]);
        }
    }
    [Theory]
    [InlineData("development_laboratory_v1", null, null, true)]
    [InlineData("development_laboratory_v1", "", "", true)]
    [InlineData("development_laboratory_v1", "local", "general", true)]
    [InlineData(null, "development", "laboratory", true)]
    [InlineData(null, null, null, true)]
    [InlineData(null, "", "", true)]
    [InlineData(null, "local", "general", true)]
    [InlineData(null, "self_hosted", "general", true)]
    [InlineData(null, "local", "certified", false)]
    [InlineData(null, "self_hosted", "laboratory", false)]
    [InlineData(null, "hosted", "general", true)]
    [InlineData(null, "production", "general", true)]
    [InlineData(null, "hosted", "certified", false)]
    [InlineData(null, "Local", "general", false)]
    [InlineData(null, "local ", "general", false)]
    [InlineData("1", null, null, false)]
    [InlineData("Development_laboratory_v1", null, null, false)]
    [InlineData(" development_laboratory_v1", null, null, false)]
    [InlineData("development_laboratory_v1", "hosted", "general", true)]
    [InlineData("development_laboratory_v1", "production", "general", true)]
    [InlineData("development_laboratory_v1", "local", "laboratory", false)]
    [InlineData("development_laboratory_v1", "Development", "laboratory", false)]
    public void NativeCodeOptInPreservesLocalHostIdentityAndRejectsOtherProfiles(string? optIn, string? mode, string? profile, bool allowed)
    {
        var error = Record.Exception(() => OperatorNativeProgramExecution.RequireSupportedHost(optIn, mode, profile));
        if (allowed) Assert.Null(error); else Assert.IsType<InvalidOperationException>(error);
    }

    private sealed class Host
    {
        internal string Status="Uninitialized";
        internal int Starts,Invocations,Commits,Assimilations,Rollbacks;
        internal long[] Added=Array.Empty<long>(),Modified=new long[]{7},Deleted=Array.Empty<long>();
        internal string InnerStatus="Committed";
        internal bool ProgramThrows,RollbackThrows,AssimilateThrowsAfterCommit,InventoryThrowsAfterCommit;
        internal Dictionary<string,object?> Run(bool allowCreate=false,int cap=3) => OperatorNativeProgramExecution.ExecuteWrite(
            ()=>{Starts++;return Status="Started";}, ()=>{Commits++;return InnerStatus;},
            ()=>{Assimilations++;Status="Committed";if(AssimilateThrowsAfterCommit)throw new Exception("after native commit");return Status;},
            ()=>{Rollbacks++;if(RollbackThrows)throw new Exception("rollback failed");return Status="RolledBack";},()=>Status,
            ()=>{Invocations++;if(ProgramThrows)throw new Exception("program failed after edit");return "reported value, not verification";},
            ()=>Added,()=>{if(InventoryThrowsAfterCommit && Status=="Committed")throw new Exception("inventory failed");return Modified;},()=>Deleted,
            new long[]{7},allowCreate,cap);
    }
    private static OperatorNativeTransactionReceipt Receipt(Dictionary<string,object?> result)=>(OperatorNativeTransactionReceipt)result["transaction"]!;

    [Fact] public void CommittedProgramRunsOnceAndReturnsNativeEffectsButNoSemanticVerification()
    {
        var h=new Host();var r=h.Run();Assert.True((bool)r["success"]!);Assert.Equal("committed",Receipt(r).Status);
        Assert.Equal(new long[]{7},Receipt(r).ModifiedElementIds);Assert.Equal(1,h.Invocations);Assert.Equal(1,h.Assimilations);Assert.Equal(0,h.Rollbacks);
        Assert.False(r.ContainsKey("verified"));
    }
    [Theory][InlineData("modified")][InlineData("deleted")][InlineData("created")][InlineData("cap")]
    public void CollateralIsCheckedBeforeAssimilationAndCannotBeHiddenByProgramText(string kind)
    {
        var h=new Host();if(kind=="modified")h.Modified=new long[]{7,99};if(kind=="deleted")h.Deleted=new long[]{99};
        if(kind=="created" || kind=="cap")h.Added=new long[]{8,9,10};var r=h.Run(allowCreate:kind=="cap",cap:2);
        Assert.False((bool)r["success"]!);Assert.Equal("rolled_back",Receipt(r).Status);Assert.Equal(0,h.Assimilations);Assert.Equal(1,h.Rollbacks);
        Assert.False(r.ContainsKey("program_result"));Assert.Equal(1,h.Invocations);
    }
    [Fact] public void ExceptionAfterEditRollsBackWithoutReexecutingProgram()
    {
        var h=new Host{ProgramThrows=true};var r=h.Run();Assert.Equal("rolled_back",Receipt(r).Status);
        Assert.Equal(0,h.Commits);Assert.Equal(1,h.Invocations);Assert.Equal(1,h.Rollbacks);Assert.False(r.ContainsKey("program_result"));
    }
    [Fact] public void FailedRollbackRemainsUnknownAndCannotReturnTransientProgramResult()
    {
        var h=new Host{ProgramThrows=true,RollbackThrows=true};var r=h.Run();Assert.Null(Receipt(r).CommittedValue);
        Assert.False((bool)r["success"]!);Assert.False(r.ContainsKey("program_result"));Assert.Equal(1,h.Invocations);
    }
    [Theory][InlineData("RolledBack")][InlineData("Pending")]
    public void NativeInnerFailureCannotAssimilate(string status)
    {
        var h=new Host{InnerStatus=status};var r=h.Run();Assert.False((bool)r["success"]!);Assert.Equal(0,h.Assimilations);Assert.Equal(1,h.Rollbacks);
    }
    [Theory][InlineData(true,false)][InlineData(false,true)]
    public void ErrorsAfterNativeCommitRetainCommitAndNeverBlindlyRollback(bool commitThrows,bool inventoryThrows)
    {
        var h=new Host{AssimilateThrowsAfterCommit=commitThrows,InventoryThrowsAfterCommit=inventoryThrows};var r=h.Run();
        Assert.True(Receipt(r).CommittedValue);Assert.False((bool)r["success"]!);Assert.Equal(0,h.Rollbacks);Assert.Equal(1,h.Invocations);
    }
    [Fact] public void AuthorizedCreationWithinBudgetIsNotCategoricallyRejected()
    {
        var h=new Host{Added=new long[]{8,9}};var r=h.Run(true);Assert.True((bool)r["success"]!);Assert.Equal(new long[]{8,9},Receipt(r).AddedElementIds);
    }
    [Fact] public void InvalidScopeRejectsBeforeStartingAndOversizeResultsReject()
    {
        var h=new Host();Assert.Throws<ArgumentException>(()=>h.Run(cap:65));Assert.Equal(0,h.Starts);
        Assert.Throws<InvalidOperationException>(()=>OperatorNativeProgramExecution.ValidateResult(null!));
        Assert.Throws<InvalidOperationException>(()=>OperatorNativeProgramExecution.ValidateResult(new string('x',32769)));
    }
    [Theory][InlineData("program")][InlineData("commit")][InlineData("assimilate")]
    public void CancellationAtEveryMutableBoundaryRollsBackWithoutReturningUncommittedProgramText(string phase)
    {
        var status="Uninitialized";var rollbacks=0;var assimilations=0;
        void Check(string at){if(at==phase)throw new OperationCanceledException("existing dispatch cancelled");}
        var result=OperatorNativeProgramExecution.ExecuteWrite(()=>status="Started",
            ()=>{Check("commit");return "Committed";},()=>{Check("assimilate");assimilations++;return status="Committed";},
            ()=>{rollbacks++;return status="RolledBack";},()=>status,()=>{Check("program");return "transient";},
            ()=>Array.Empty<long>(),()=>new long[]{7},()=>Array.Empty<long>(),new long[]{7},false,1);
        Assert.Equal("rolled_back",Receipt(result).Status);Assert.Equal(1,rollbacks);Assert.Equal(0,assimilations);
        Assert.False(result.ContainsKey("program_result"));
    }
}
