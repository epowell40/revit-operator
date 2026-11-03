using System;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

public sealed class OperatorNativeProgramCourierRequestTests
{
    private static string Body(string mode="read", string year="2024", string fingerprint="") => JsonSerializer.Serialize(new {
        source="public class Query {}",targetRevitYear=year,
        expectedDocumentFingerprint=string.IsNullOrEmpty(fingerprint)?"sha256:"+new string('a',64):fingerprint,
        nativeProgram=new {entryType="Query",mode},workerDeadlineMs=15000
    });
    [Theory][InlineData(false)][InlineData(true)]
    public void ReadAndWriteTransportKeepTheirNativeMode(bool write)
    {
        var path=write?OperatorNativeProgramCourierRequest.ApplyPath:OperatorNativeProgramCourierRequest.ReadPath;
        Assert.True(OperatorNativeProgramCourierRequest.IsRoute("POST",path));
        Assert.False(OperatorNativeProgramCourierRequest.IsRoute("GET",path));
        Assert.Equal(write?"write":"read",OperatorNativeProgramCourierRequest.Validate(path,Body(write?"write":"read")).GetProperty("nativeProgram").GetProperty("mode").GetString());
        Assert.Equal("extended",OperatorActionDeadlinePolicy.Resolve("POST",path,"low").DeadlineClass);
    }
    [Theory]
    [InlineData("2023")][InlineData("2024")][InlineData("2025")][InlineData("2026")][InlineData("2027")]
    public void SupportedYearsRemainExplicitInReadAndWriteRequests(string year)
    {
        foreach(var write in new[]{false,true}) {
            var path=write?OperatorNativeProgramCourierRequest.ApplyPath:OperatorNativeProgramCourierRequest.ReadPath;
            var request=OperatorNativeProgramCourierRequest.Validate(path,Body(write?"write":"read",year));
            Assert.Equal(year,request.GetProperty("targetRevitYear").GetString());
        }
    }
    [Fact]
    public void UnknownSourceFieldsWrongDocumentYearAndWriteDisguisedAsReadAreRejected()
    {
        var path=OperatorNativeProgramCourierRequest.ReadPath;
        Assert.Throws<ArgumentException>(()=>OperatorNativeProgramCourierRequest.Validate(path,Body("write")));
        Assert.Throws<ArgumentException>(()=>OperatorNativeProgramCourierRequest.Validate(path,Body(year:"2022")));
        Assert.Throws<ArgumentException>(()=>OperatorNativeProgramCourierRequest.Validate(path,Body(fingerprint:"foreign")));
        Assert.Throws<ArgumentException>(()=>OperatorNativeProgramCourierRequest.Validate(path,Body().Replace("\"source\":","\"executable\":\"cmd.exe\",\"source\":")));
        Assert.Throws<ArgumentException>(()=>OperatorNativeProgramCourierRequest.Validate("/revit/other",Body()));
        Assert.Throws<ArgumentException>(()=>OperatorNativeProgramCourierRequest.Validate(path,Body().Replace("\"mode\":\"read\"","\"mode\":\"read\",\"assembly\":\"untrusted\"")));
    }
}
