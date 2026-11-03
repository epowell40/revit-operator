using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.Json;
using Xunit;
namespace RevitBridge.Common.Tests
{
 public sealed class NativePlacementSnapshotTransportTests
 {
  static JsonElement Pack(object value){var m=typeof(RevitBridge.Common.NativePreservationSnapshotCodec).GetMethod("PackPlacement");Assert.NotNull(m);return JsonSerializer.SerializeToElement(m!.Invoke(null,new[]{value}));}
  static byte[] Unzip(string s){using var i=new MemoryStream(Convert.FromBase64String(s));using var g=new GZipStream(i,CompressionMode.Decompress);using var o=new MemoryStream();g.CopyTo(o);return o.ToArray();}
  [Fact] public void LargeSnapshotPreservesEveryByteAcrossBoundedSegments()
  {
   var source=new{schema="native-test",rows=Enumerable.Range(1,2909).Select(id=>new{id,uid="native-"+id,peer=id+1,flow=0.0334201407958809,text=new string('x',4500)+"é💧"}).ToArray()};
   var expected=JsonSerializer.SerializeToUtf8Bytes(source);Assert.True(expected.Length>12000000);
   var p=Pack(source);Assert.Equal("operator.native_preservation_json.v2",p.GetProperty("schema").GetString());
   Assert.Equal(expected.Length,p.GetProperty("uncompressedBytes").GetInt32());
   using var joined=new MemoryStream();var index=0;
   foreach(var part in p.GetProperty("segments").EnumerateArray()){
    Assert.Equal(index++,part.GetProperty("index").GetInt32());var bytes=Unzip(part.GetProperty("data").GetString()!);
    Assert.InRange(bytes.Length,1,2000000);Assert.Equal(bytes.Length,part.GetProperty("uncompressedBytes").GetInt32());
    Assert.Equal(RevitBridge.Common.XlsxTablePlanCodec.Hash(bytes),part.GetProperty("sha256").GetString());joined.Write(bytes,0,bytes.Length);
   }
   Assert.Equal(expected,joined.ToArray());Assert.Equal(RevitBridge.Common.XlsxTablePlanCodec.Hash(expected),p.GetProperty("sha256").GetString());
   Assert.True(JsonSerializer.SerializeToUtf8Bytes(p).Length<=900000);
  }
  [Fact] public void LegacyPayloadRepresentationAndLimitAreUnchanged(){var v=new{a="small",b=42};Assert.Equal(JsonSerializer.Serialize(RevitBridge.Common.NativePreservationSnapshotCodec.Pack(v)),JsonSerializer.Serialize(Pack(v)));Assert.Throws<InvalidOperationException>(()=>RevitBridge.Common.NativePreservationSnapshotCodec.Pack(new{x=new string('x',2000001)}));}
  [Fact] public void PlacementEnvelopeCarriesBoundedLowRedundancySystemRecords()
  {
   var rng=new Random(175);var b=new byte[1200000];rng.NextBytes(b);
   var source=new{records=Convert.ToBase64String(b),padding=new string('x',800000)};
   var expected=JsonSerializer.SerializeToUtf8Bytes(source);var packed=Pack(source);
   Assert.InRange(JsonSerializer.SerializeToUtf8Bytes(packed).Length,900001,3000000);
   using var joined=new MemoryStream();foreach(var part in packed.GetProperty("segments").EnumerateArray()){
    var raw=Unzip(part.GetProperty("data").GetString()!);joined.Write(raw,0,raw.Length);
   }Assert.Equal(expected,joined.ToArray());
  }
  [Fact] public void SegmentedTotalAndEncodedBoundsFailClosed(){Assert.Throws<System.Reflection.TargetInvocationException>(()=>Pack(new{x=new string('x',64000001)}));var rng=new Random(172);var b=new byte[2500000];rng.NextBytes(b);Assert.Throws<System.Reflection.TargetInvocationException>(()=>Pack(new{x=Convert.ToBase64String(b)}));}
 }
}
