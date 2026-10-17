using System;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorDocumentChangeObservationTests
    {
        private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-17T10:00:00Z");
        private static void Add(OperatorDocumentChangeObservationStore store, string doc = "document-a", long id = 41)
            => store.Record(doc, "TransactionCommitted", new[] { "Schedule appearance" }, Array.Empty<long>(), new[] { id }, Array.Empty<long>(), Now);

        [Fact] public void NativeEventsHaveMonotonicIdentityAndNoActorOrVerificationAuthority()
        {
            var store = new OperatorDocumentChangeObservationStore(17); Add(store); Add(store, id:42);
            using var json = JsonDocument.Parse(store.ReadJson("document-a")); var s = json.RootElement;
            Assert.Equal("observed_changes_only", s.GetProperty("authority").GetString());
            Assert.Equal(2, s.GetProperty("throughSequence").GetInt64());
            Assert.Equal(new long[] { 1,2 },s.GetProperty("events").EnumerateArray().Select(e=>e.GetProperty("sequence").GetInt64()));
            Assert.DoesNotContain("committed_operation", store.ReadJson("document-a"));
            Assert.DoesNotContain("actor_id", store.ReadJson("document-a"));
            Assert.Equal(41,s.GetProperty("events")[0].GetProperty("modifiedIds")[0].GetInt64());
        }
        [Fact] public void RingRetentionAndGlobalSequenceExposeMissingIntervalsWithoutMixingDocuments()
        {
            var store = new OperatorDocumentChangeObservationStore(17);
            for(var i=0;i<20;i++) Add(store,i%2==0?"document-a":"document-b",i+1);
            using var json = JsonDocument.Parse(store.ReadJson("document-a"));var s=json.RootElement;
            Assert.Equal(5,s.GetProperty("retainedFromSequence").GetInt64());Assert.Equal(20,s.GetProperty("throughSequence").GetInt64());
            Assert.All(s.GetProperty("events").EnumerateArray(),e=>Assert.Equal("document-a",e.GetProperty("documentSessionId").GetString()));
            Assert.Equal(8,s.GetProperty("events").GetArrayLength());
        }
        [Fact] public void TruncationAndCaptureFailureNeverMasqueradeAsAnExhaustiveDelta()
        {
            var store=new OperatorDocumentChangeObservationStore(17);
            store.Record("a","TransactionCommitted",Enumerable.Repeat(new string('x',130),10),Enumerable.Range(1,1000).Select(n=>(long)n),new long[]{9000},new long[]{9001},Now);
            store.RecordCaptureFailure(Now);
            using var json=JsonDocument.Parse(store.ReadJson("a"));var es=json.RootElement.GetProperty("events");
            Assert.Equal(64,es[0].GetProperty("addedIds").GetArrayLength());Assert.False(es[0].GetProperty("complete").GetBoolean());
            Assert.Empty(es[0].GetProperty("modifiedIds").EnumerateArray());Assert.True(es[0].GetProperty("transactionNamesTruncated").GetBoolean());
            Assert.Equal(4,es[0].GetProperty("transactionNames").GetArrayLength());Assert.False(es[1].GetProperty("complete").GetBoolean());
            Assert.Equal(JsonValueKind.Null,es[1].GetProperty("documentSessionId").ValueKind);
        }
        [Fact] public void SaveAsOrReopenSessionCannotReadOldSessionChangesAsItsOwn()
        {
            var store=new OperatorDocumentChangeObservationStore(17);Add(store);
            using var json=JsonDocument.Parse(store.ReadJson("new-session"));Assert.Empty(json.RootElement.GetProperty("events").EnumerateArray());
            var fresh=new OperatorDocumentChangeObservationStore(17);
            using var second=JsonDocument.Parse(fresh.ReadJson("document-a"));using var first=JsonDocument.Parse(store.ReadJson("document-a"));
            Assert.NotEqual(first.RootElement.GetProperty("epoch").GetString(),second.RootElement.GetProperty("epoch").GetString());
        }
        [Fact] public void InvalidIdsRemainIncompleteAndInputCollectionsCannotMutateRetainedEvents()
        {
            var store=new OperatorDocumentChangeObservationStore(17);var ids=new long[]{41,-1};
            store.Record("a","TransactionUndone",Array.Empty<string>(),Array.Empty<long>(),ids,Array.Empty<long>(),Now);ids[0]=9000;
            using var json=JsonDocument.Parse(store.ReadJson("a"));var e=json.RootElement.GetProperty("events")[0];
            Assert.False(e.GetProperty("complete").GetBoolean());Assert.Equal(41,e.GetProperty("modifiedIds")[0].GetInt64());
        }
        [Fact] public void ConcurrentReadersReceiveCompleteSerializedSnapshots()
        {
            var store=new OperatorDocumentChangeObservationStore(17);
            Parallel.For(0,100,i=>{if(i%2==0)Add(store,id:i+1);using var json=JsonDocument.Parse(store.ReadJson("document-a"));Assert.True(json.RootElement.GetProperty("events").GetArrayLength()<=16);});
        }
    }
}
