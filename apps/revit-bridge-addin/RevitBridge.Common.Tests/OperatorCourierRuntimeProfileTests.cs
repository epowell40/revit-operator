using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorCourierRuntimeProfileTests
    {
        private const string Hash1 = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
        private const string Hash2 = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

        [Fact]
        public void Hosted_general_agent_job_binds_route_alias_and_token_digest()
        {
            using var document = JsonDocument.Parse("{" +
                "\"method\":\"POST\"," +
                "\"path\":\"/revit/query\"," +
                "\"turn_token_sha256\":\"" + Hash1 + "\"," +
                "\"general_agent_admission\":{" +
                    "\"schema\":\"revit-operator.general-agent-courier-admission.v1\"," +
                    "\"source\":\"backend_general_agent\"," +
                    "\"runtime_mode\":\"hosted\"," +
                    "\"exposure_profile\":\"general\"," +
                    "\"capability_profile\":\"general_agent\"," +
                    "\"general_agent_ready\":true," +
                    "\"method\":\"POST\"," +
                    "\"path\":\"/revit/query\"," +
                    "\"channel\":\"typed_mcp\"," +
                    "\"alias\":\"revit_query_elements\"," +
                    "\"request_hash\":\"" + Hash1 + "\"," +
                    "\"effect_hash\":\"" + Hash2 + "\"" +
                "}}" );

            Assert.True(OperatorCourierRuntimeProfile.TryValidateGeneralAgentJob(document.RootElement, out var error), error);
        }

        [Theory]
        [InlineData("\"turn_token\":\"secret\",")]
        [InlineData("")]
        public void Hosted_general_agent_job_rejects_raw_or_missing_token_digest(string tokenFields)
        {
            using var document = JsonDocument.Parse("{" + tokenFields +
                "\"method\":\"GET\",\"path\":\"/revit/ping\"," +
                "\"general_agent_admission\":{" +
                    "\"schema\":\"revit-operator.general-agent-courier-admission.v1\",\"source\":\"backend_general_agent\"," +
                    "\"runtime_mode\":\"hosted\",\"exposure_profile\":\"general\",\"capability_profile\":\"general_agent\",\"general_agent_ready\":true," +
                    "\"method\":\"GET\",\"path\":\"/revit/ping\",\"channel\":\"typed_mcp\",\"alias\":\"revit_ping\"," +
                    "\"request_hash\":\"" + Hash1 + "\",\"effect_hash\":\"" + Hash2 + "\"}}" );

            Assert.False(OperatorCourierRuntimeProfile.TryValidateGeneralAgentJob(document.RootElement, out _));
        }
    }
}
