using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;

namespace RevitOperator.DynamicRevitSandboxSupervisor.Tests;

public sealed class BootstrapReadRetryTests
{
    private const string Busy = """
        {"ok":false,"code":"revit_external_event_busy","retryable":true,"request_dispatched":false,"outcome_unknown":false,
        "canonical_attempt_settlement":{"schema":"revit-operator.native-attempt-settlement.v1","requested_effect":"read",
        "method":"POST","path":"/revit/dynamic-runtime/bootstrap","request_dispatched":false,"effect_state":"none",
        "effect_authority":"native_host","effect_reason":"revit_external_event_busy","affected_target_identities":[]}}
        """;

    [Fact]
    public async Task BusyBeforeDispatchWaitsThenReturnsTheUnmodifiedAuthenticatedBootstrap()
    {
        var calls = 0;
        var waits = new List<double>();
        var success = new HttpPostResult(true, 200, "exact authenticated bootstrap challenge");
        var result = await BootstrapReadRetry.SendAsync(() => Task.FromResult(++calls < 3 ? new HttpPostResult(false, 409, Busy) : success),
            duration => { waits.Add(duration.TotalMilliseconds); return Task.CompletedTask; });
        Assert.Equal(3, result.Attempts);
        Assert.Same(success, result.Response);
        Assert.Equal(new double[] { 500, 1000 }, waits);
    }

    [Fact]
    public async Task ExhaustedStartupProducesSerializableEvidenceWithoutWorkerOrMutationAuthority()
    {
        var calls = 0; var waited = TimeSpan.Zero;
        var result = await BootstrapReadRetry.SendAsync(() => { calls++; return Task.FromResult(new HttpPostResult(false,409,Busy)); },
            duration => { waited += duration; return Task.CompletedTask; });
        Assert.Equal(8, calls);
        Assert.Equal(TimeSpan.FromSeconds(14), waited);
        var evidence = Program.BootstrapBusyEvidence(DateTimeOffset.UtcNow, "2024", result.Attempts);
        var json = JsonSerializer.Serialize(evidence);
        using var parsed = JsonDocument.Parse(json);
        Assert.False(evidence.Ok);
        Assert.False(evidence.WorkerStarted);
        Assert.Equal(JsonValueKind.Null, parsed.RootElement.GetProperty("WorkerOutput").ValueKind);
        Assert.Null(evidence.Admission); Assert.Null(evidence.ApplyReceipt); Assert.Null(evidence.ApplyAuthorizationReceipt);
        Assert.Empty(evidence.RegistrationReceipt); Assert.Empty(evidence.HostAuthenticationReceipts);
        Assert.Equal(BootstrapReadRetry.ExhaustedFailure, evidence.Failure);
    }

    [Theory]
    [InlineData("request_dispatched", "true")]
    [InlineData("outcome_unknown", "true")]
    [InlineData("retryable", "false")]
    [InlineData("retryable", "null")]
    [InlineData("code", "\"other_busy_error\"")]
    [InlineData("canonical_attempt_settlement", "null")]
    public async Task AmbiguousOrUnsupportedHostFailuresNeverRetry(string field, string value)
    {
        var body=JsonNode.Parse(Busy)!.AsObject(); body[field]=JsonNode.Parse(value);
        await AssertNoRetry(body.ToJsonString());
    }

    [Theory]
    [InlineData("path", "\"/revit/dynamic-runtime/apply\"")]
    [InlineData("path", "\"/revit/dynamic-runtime/snapshot\"")]
    [InlineData("requested_effect", "\"apply\"")]
    [InlineData("request_dispatched", "true")]
    [InlineData("effect_state", "\"unknown\"")]
    [InlineData("effect_authority", "\"worker\"")]
    [InlineData("affected_target_identities", "[\"element:42\"]")]
    public async Task ConflictingNativeSettlementNeverPermitsReplay(string field, string value)
    {
        var body=JsonNode.Parse(Busy)!.AsObject(); body["canonical_attempt_settlement"]![field]=JsonNode.Parse(value);
        await AssertNoRetry(body.ToJsonString());
    }

    [Theory]
    [InlineData("not json",409)]
    [InlineData("[]",409)]
    [InlineData("{}",401)]
    [InlineData("{}",503)]
    public Task MalformedOrNonBusyHttpFailuresDoNotRetry(string body,int status) => AssertNoRetry(body,status);

    [Fact]
    public async Task UnknownNetworkOutcomeDoesNotRetry()
    {
        var calls=0;
        await Assert.ThrowsAsync<HttpRequestException>(() => BootstrapReadRetry.SendAsync(() => {
            calls++; throw new HttpRequestException("connection lost after dispatch");
        }, _ => throw new Exception("must not wait")));
        Assert.Equal(1,calls);
    }

    private static async Task AssertNoRetry(string body,int status=409)
    {
        var calls=0; var response=new HttpPostResult(false,status,body);
        var result=await BootstrapReadRetry.SendAsync(() => {calls++; return Task.FromResult(response);},_=>throw new Exception("must not wait"));
        Assert.Equal(1,calls); Assert.Same(response,result.Response);
    }
}
