using System;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;
namespace RevitBridge.Common.Tests
{
    public sealed class NativeSystemBrowserObservationTests
    {
        [Fact] public void CompletePublicRowsRetainIdentityAndNativeMetadata()
        {
            var native = new { elementId=900, uniqueId="native-browser", viewType="SystemBrowser", name="System Browser", isTemplate=false,
                metadata=new { elementId=900, uniqueId="native-browser", parameters=new[] { new { id=-1, readOnly=true, storage="String", value="System Browser" } }, dependentIds=new[] { 900,901 } } };
            using var json=JsonDocument.Parse(JsonSerializer.Serialize(NativeSystemBrowserObservation.Capture(new[] { native }, x=>(object)x)));
            Assert.True(json.RootElement.GetProperty("complete").GetBoolean());
            Assert.Equal(JsonSerializer.Serialize(native),json.RootElement.GetProperty("items")[0].GetRawText());
            Assert.Equal("system_browser_public_state_not_hidden_state",json.RootElement.GetProperty("scope").GetString());
        }
        [Fact] public void GetterFailureDoesNotBecomeAnEmptyCompleteSnapshot()
        { Assert.Throws<InvalidOperationException>(()=>NativeSystemBrowserObservation.Capture(new[] { 1 }, _=>throw new InvalidOperationException("native unavailable"))); }
        [Fact] public void BoundsFailBeforeReadingRows()
        { var reads=0;Assert.Throws<InvalidOperationException>(()=>NativeSystemBrowserObservation.Capture(Enumerable.Range(0,9), n=>{reads++;return n;}));Assert.Equal(0,reads); }
        [Fact] public void EmptyActualInventoryIsExplicitAndNotInferredFromFailure()
        { using var json=JsonDocument.Parse(JsonSerializer.Serialize(NativeSystemBrowserObservation.Capture(Array.Empty<int>(), n=>(object)n)));
          Assert.Equal(0,json.RootElement.GetProperty("items").GetArrayLength());Assert.True(json.RootElement.GetProperty("complete").GetBoolean()); }
    }
}
