using System;
using System.Collections.Generic;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class NativeProgramViewRefreshTests
    {
        private static void Refresh(Dictionary<string,object?> result, Action refresh)
        {
            var method=typeof(OperatorNativeProgramExecution).GetMethod("RefreshCommittedView");
            Assert.NotNull(method);
            method!.Invoke(null,new object[]{result,refresh});
        }

        [Fact]
        public void Confirmed_commit_refreshes_once_without_claiming_pixels_or_verification()
        {
            var receipt=OperatorNativeTransactionReceipt.Committed(new long[]{12});
            var result=new Dictionary<string,object?>{{"success",true},{"transaction",receipt},{"program_result","text changed"}};
            var calls=0;Refresh(result,()=>calls++);
            Assert.Equal(1,calls);Assert.Same(receipt,result["transaction"]);
            Assert.Equal(true,result["success"]);
            var feedback=Assert.IsType<Dictionary<string,object?>>(result["view_refresh"]);
            Assert.Equal("requested",feedback["state"]);Assert.Equal(false,feedback["pixels_verified"]);
        }

        [Fact]
        public void Paint_failure_does_not_undo_or_reclassify_committed_work()
        {
            var receipt=OperatorNativeTransactionReceipt.Committed(new long[]{12});
            var result=new Dictionary<string,object?>{{"success",true},{"transaction",receipt}};
            Refresh(result,()=>throw new InvalidOperationException("paint unavailable"));
            Assert.Same(receipt,result["transaction"]);Assert.Equal(true,result["success"]);
            var feedback=Assert.IsType<Dictionary<string,object?>>(result["view_refresh"]);
            Assert.Equal("unavailable",feedback["state"]);Assert.Equal("InvalidOperationException",feedback["error_type"]);
        }

        [Theory]
        [InlineData("rolled_back")]
        [InlineData("missing")]
        [InlineData("untrusted")]
        [InlineData("failed")]
        public void Unsettled_or_unsuccessful_work_never_refreshes(string kind)
        {
            var result=new Dictionary<string,object?>{{"success",kind!="failed"}};
            if(kind=="rolled_back")result["transaction"]=OperatorNativeTransactionReceipt.RolledBack(new long[]{12});
            if(kind=="untrusted")result["transaction"]=new{status="committed",committed=true};
            if(kind=="failed")result["transaction"]=OperatorNativeTransactionReceipt.Committed(new long[]{12});
            var calls=0;Refresh(result,()=>calls++);
            Assert.Equal(0,calls);Assert.False(result.ContainsKey("view_refresh"));
        }
    }
}
