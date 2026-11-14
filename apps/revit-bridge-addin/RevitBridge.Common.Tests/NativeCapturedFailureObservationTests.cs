using System;
using System.Reflection;
using System.Text.Json;
using Xunit;

namespace RevitBridge.Common.Tests;

public sealed class NativeCapturedFailureObservationTests
{
    [Fact]
    public void ActualNativeFailureProducerRetainsLocationsAndDefinitionAlongsideTheMessage()
    {
        // Instantiate the real collector DTO, not a copied test representation.
        // This checks native receipt serialization without creating Revit failures.
        var type = Assembly.Load("DynamicRevitHost").GetType("RevitBridge.Logic.Handlers.DynamicRuntime.DynamicCapturedFailure", true)!;
        var value = Activator.CreateInstance(type, nonPublic: true)!;
        type.GetProperty("severity")!.SetValue(value, "error");
        type.GetProperty("message")!.SetValue(value, "Can't keep elements joined.");
        type.GetProperty("elementIds")!.SetValue(value, new long[] { 71, 72 });
        type.GetProperty("failureDefinitionId")!.SetValue(value, "c4e32a23-52e6-455b-949d-89e0c4eb78ab");
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(value, type));
        Assert.Equal(71, json.RootElement.GetProperty("elementIds")[0].GetInt64());
        Assert.Equal(72, json.RootElement.GetProperty("elementIds")[1].GetInt64());
        Assert.Equal("c4e32a23-52e6-455b-949d-89e0c4eb78ab", json.RootElement.GetProperty("failureDefinitionId").GetString());
        Assert.Equal("Can't keep elements joined.", json.RootElement.GetProperty("message").GetString());
    }
}
