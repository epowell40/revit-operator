using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class OperatorDeletedTypeContextTests
    {
        private static OperatorDeletedTypeContext.Identity Identity(long id) => new OperatorDeletedTypeContext.Identity
            { Id=id,UniqueId="native-"+id,ClassName="FamilySymbol",Name="Elbow",FamilyName="Round Elbow" };
        private static Dictionary<string,object?> Result(OperatorNativeTransactionReceipt receipt, bool success=true)
            => new Dictionary<string,object?>{{"success",success},{"transaction",receipt}};
        private static JsonElement Context(OperatorDeletedTypeContext snapshot, Dictionary<string,object?> result)
        { snapshot.Attach(result); return JsonSerializer.SerializeToElement(result["deleted_type_context"]); }

        [Fact]
        public void Committed_deletion_retains_before_type_identity_without_safety_or_instance_claims()
        {
            var snapshot=OperatorDeletedTypeContext.Capture(new long[]{7},Identity,()=>12);
            var receipt=OperatorNativeTransactionReceipt.CommittedChanges(new long[]{9},Array.Empty<long>(),new long[]{7,8});
            var result=Result(receipt);var context=Context(snapshot,result);
            Assert.Same(receipt,result["transaction"]);Assert.Equal(true,result["success"]);
            Assert.False(context.GetProperty("deletion_safety_verified").GetBoolean());
            Assert.Equal("native-7",context.GetProperty("rows")[0].GetProperty("unique_id").GetString());
            Assert.Equal("not_observed_as_type",context.GetProperty("rows")[1].GetProperty("state").GetString());
            Assert.Equal(12,context.GetProperty("elapsed_milliseconds").GetInt32());
        }

        [Fact]
        public void Failed_reads_and_incomplete_type_baseline_never_invent_identity()
        {
            var snapshot=OperatorDeletedTypeContext.Capture(new long[]{7},id=>throw new InvalidOperationException(),()=>0);
            var context=Context(snapshot,Result(OperatorNativeTransactionReceipt.CommittedChanges(Array.Empty<long>(),Array.Empty<long>(),new long[]{7})));
            Assert.Equal("read_errors",context.GetProperty("baseline_coverage").GetString());
            Assert.Equal(1,context.GetProperty("read_errors").GetInt32());
            Assert.Equal("not_observed_as_type",context.GetProperty("rows")[0].GetProperty("state").GetString());
        }

        [Fact]
        public void Baseline_and_returned_deletions_are_bounded()
        {
            var snapshot=OperatorDeletedTypeContext.Capture(Enumerable.Range(1,5000).Select(i=>(long)i),Identity,()=>0);
            var context=Context(snapshot,Result(OperatorNativeTransactionReceipt.CommittedChanges(Array.Empty<long>(),Array.Empty<long>(),Enumerable.Range(1,30).Select(i=>(long)i))));
            Assert.Equal(4096,snapshot.Examined);Assert.Equal("count_limited",snapshot.Coverage);
            Assert.Equal(30,context.GetProperty("deleted_count").GetInt32());Assert.Equal(16,context.GetProperty("returned_count").GetInt32());
            var reads=0;var timed=OperatorDeletedTypeContext.Capture(new long[]{7},id=>{reads++;return Identity(id);},()=>250);
            Assert.Equal("time_limited",timed.Coverage);Assert.Equal(0,reads);
        }

        [Fact]
        public void Invalid_identity_and_enumerator_errors_remain_diagnostic()
        {
            var snapshot=OperatorDeletedTypeContext.Capture(new long[]{7,7,8,9},id=>id==8?Identity(999):id==9?
                new OperatorDeletedTypeContext.Identity{Id=9,UniqueId="",ClassName="FamilySymbol"}:Identity(id),()=>0);
            Assert.Equal(3,snapshot.ReadErrors);
            var broken=OperatorDeletedTypeContext.Capture(Broken(),Identity,()=>0);
            Assert.Equal("read_errors",broken.Coverage);Assert.Equal(1,broken.ReadErrors);
        }
        private static IEnumerable<long> Broken(){yield return 7;throw new InvalidOperationException();}

        [Fact]
        public void Unknown_rollback_failed_read_and_no_deletion_do_not_get_a_deletion_diagnosis()
        {
            var snapshot=OperatorDeletedTypeContext.Capture(new long[]{7},Identity,()=>0);
            foreach(var receipt in new[]{OperatorNativeTransactionReceipt.NotStarted(),OperatorNativeTransactionReceipt.RolledBack(new long[]{7}),
                OperatorNativeTransactionReceipt.Unknown("unknown"),OperatorNativeTransactionReceipt.Committed(new long[]{7})})
            {var result=Result(receipt);snapshot.Attach(result);Assert.False(result.ContainsKey("deleted_type_context"));}
            var failed=Result(OperatorNativeTransactionReceipt.CommittedChanges(Array.Empty<long>(),Array.Empty<long>(),new long[]{7}),false);
            snapshot.Attach(failed);Assert.False(failed.ContainsKey("deleted_type_context"));
            var forged=new Dictionary<string,object?>{{"success",true},{"transaction",new{status="committed",committed=true,deleted_element_ids=new[]{7}}}};
            snapshot.Attach(forged);Assert.False(forged.ContainsKey("deleted_type_context"));
        }
    }
}
