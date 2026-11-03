using System;
using System.Collections.Generic;
using System.Linq;
using RevitBridge.Common;
using Xunit;

public sealed class NativeDocumentProgramExecutionTests
{
    private sealed class Host
    {
        public string Status="Uninitialized";
        public int Runs,Assimilations,Rollbacks;
        public long[] Added=new long[]{1001,1002},Modified=Enumerable.Range(1,120).Select(i=>(long)i).ToArray(),Deleted=Array.Empty<long>();
        public bool ThrowProgram,ThrowRollback;
        public Dictionary<string,object?> Run(bool documentScope=true,long[]? protectedIds=null) => OperatorNativeProgramExecution.ExecuteWrite(
            ()=>Status="Started",()=>"Committed",()=>{Assimilations++;return Status="Committed";},
            ()=>{Rollbacks++;if(ThrowRollback)throw new Exception("rollback failure");return Status="RolledBack";},()=>Status,
            ()=>{Runs++;if(ThrowProgram)throw new Exception("program failure");return "result is not verification";},
            ()=>Added,()=>Modified,()=>Deleted,Array.Empty<long>(),!documentScope,documentScope?0:64,
            documentScope,documentScope?(protectedIds??Array.Empty<long>()):null);
    }
    private static OperatorNativeTransactionReceipt Receipt(Dictionary<string,object?> value)=>(OperatorNativeTransactionReceipt)value["transaction"]!;

    [Fact] public void ExplicitDocumentScopeRecordsUnpredictedDependentsAndCommitsOnce()
    {
        var h=new Host();var r=h.Run();Assert.True((bool)r["success"]!);Assert.Equal("committed",Receipt(r).Status);
        Assert.Equal(h.Added,Receipt(r).AddedElementIds);Assert.Equal(h.Modified,Receipt(r).ModifiedElementIds);
        Assert.Equal(122,Receipt(r).AffectedElementIds.Count);Assert.Equal(1,h.Runs);Assert.Equal(1,h.Assimilations);Assert.Equal(0,h.Rollbacks);
        Assert.False(r.ContainsKey("verified"));
    }
    [Fact] public void LegacyListedScopeStillRejectsTheSameUnlistedChanges()
    {
        var h=new Host();var r=h.Run(false);Assert.False((bool)r["success"]!);Assert.Equal("rolled_back",Receipt(r).Status);
        Assert.Equal(0,h.Assimilations);Assert.Equal(1,h.Rollbacks);
    }
    [Theory][InlineData("modified")][InlineData("deleted")][InlineData("capacity")][InlineData("invalid")]
    public void ProtectionAndAuditCapacityStillRollback(string kind)
    {
        var h=new Host();if(kind=="deleted")h.Deleted=new long[]{1};
        if(kind=="capacity")h.Modified=Enumerable.Range(1,4097).Select(i=>(long)i).ToArray();
        if(kind=="invalid")h.Modified=new long[]{-1};
        var r=h.Run(protectedIds:kind=="modified"||kind=="deleted"?new long[]{1}:Array.Empty<long>());
        Assert.False((bool)r["success"]!);Assert.Equal("rolled_back",Receipt(r).Status);Assert.Empty(Receipt(r).AffectedElementIds);
        Assert.Equal(0,h.Assimilations);Assert.Equal(1,h.Rollbacks);Assert.False(r.ContainsKey("program_result"));
    }
    [Theory][InlineData(false)][InlineData(true)]
    public void FailedExecutionDoesNotBecomeSuccessOrInviteReplay(bool rollbackFails)
    {
        var h=new Host{ThrowProgram=true,ThrowRollback=rollbackFails};var r=h.Run();
        Assert.False((bool)r["success"]!);Assert.Equal(1,h.Runs);Assert.Equal(1,h.Rollbacks);Assert.Equal(0,h.Assimilations);
        if(rollbackFails)Assert.Null(Receipt(r).CommittedValue);else Assert.Equal("rolled_back",Receipt(r).Status);
        Assert.False(r.ContainsKey("program_result"));
    }
}
