using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;
namespace RevitBridge.Common.Tests
{
 public sealed class NativePreservationSnapshotCodecTests
 {
  private static JsonElement Pack(object value) {
   var type=typeof(InlineAccessoryBookkeeping).Assembly.GetType("RevitBridge.Common.NativePreservationSnapshotCodec");
   Assert.NotNull(type);return JsonSerializer.SerializeToElement(type!.GetMethod("Pack")!.Invoke(null,new[]{value}));
  }
  private static byte[] Unzip(string text){using var input=new MemoryStream(Convert.FromBase64String(text));using var gz=new GZipStream(input,CompressionMode.Decompress);using var o=new MemoryStream();gz.CopyTo(o);return o.ToArray();}
  [Fact] public void Exact151SnapshotRoundTripsWithinExistingRetainedBound() {
   using var fixture=JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"Fixtures","native-placement-snapshot151.json")));
   var bytes=Unzip(fixture.RootElement.GetProperty("gzipBase64").GetString()!);using var document=JsonDocument.Parse(bytes);
   // The producer serializes native objects with System.Text.Json. Equivalent
   // Node fixture escapes are not its byte representation; compare those actual
   // native serialization bytes and also every parsed source value below.
   var nativeBytes=JsonSerializer.SerializeToUtf8Bytes(document.RootElement);
   var packed=Pack(document.RootElement);Assert.Equal("operator.native_preservation_json.v1",packed.GetProperty("schema").GetString());
   var decoded=Unzip(packed.GetProperty("data").GetString()!);
   Assert.Equal(nativeBytes,decoded);
   Assert.True(System.Text.Json.Nodes.JsonNode.DeepEquals(System.Text.Json.Nodes.JsonNode.Parse(bytes),System.Text.Json.Nodes.JsonNode.Parse(decoded)));
   Assert.Equal(nativeBytes.Length,packed.GetProperty("uncompressedBytes").GetInt32());
   Assert.Equal(XlsxTablePlanCodec.Hash(nativeBytes),packed.GetProperty("sha256").GetString());
   Assert.True(Encoding.UTF8.GetByteCount(packed.GetRawText())*2+128000<2000000);
  }
  [Fact] public void SmallSnapshotStaysOrdinaryJson(){var p=Pack(new {complete=true,value="small"});Assert.True(p.GetProperty("complete").GetBoolean());Assert.False(p.TryGetProperty("encoding",out _));}
  [Fact] public void OversizedSnapshotIsRejectedBeforeNativePlacement(){var e=Assert.Throws<System.Reflection.TargetInvocationException>(()=>Pack(new {value=new string('x',2000001)}));Assert.IsType<InvalidOperationException>(e.InnerException);}
 }
}
