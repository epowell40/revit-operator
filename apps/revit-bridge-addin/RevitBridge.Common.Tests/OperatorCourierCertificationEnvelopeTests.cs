using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorCourierCertificationEnvelopeTests
    {
        private const string Hash1 = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
        private const string Hash2 = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
        private const string Hash3 = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
        private const string Hash4 = "sha256:4444444444444444444444444444444444444444444444444444444444444444";
        private const string Hash5 = "sha256:5555555555555555555555555555555555555555555555555555555555555555";
        private const string Hash6 = "sha256:6666666666666666666666666666666666666666666666666666666666666666";
        private const string Hash7 = "sha256:7777777777777777777777777777777777777777777777777777777777777777";
        private const string Hash8 = "sha256:8888888888888888888888888888888888888888888888888888888888888888";

        [Fact]
        public void Canonicalizer_matches_the_fixed_MCP_envelope_and_idempotency_UTF8_vectors()
        {
            // Exact literals from apps/mcp-server/src/lib/revitCourier.test.ts.
            // Literal U+2028/U+2029 are intentionally not JSON escaped.
            var lineSeparator = char.ConvertFromUtf32(0x2028);
            var paragraphSeparator = char.ConvertFromUtf32(0x2029);
            var envelopeInput = new Dictionary<string, object?>
            {
                ["workflow"] = "W \"q\" \\ root\r\nCafe\u0301 " + lineSeparator + "mid" + paragraphSeparator + "end",
                ["version"] = 1,
                ["schema"] = OperatorCourierCertificationEnvelope.Schema,
                ["runtime_mode"] = "develop" + lineSeparator + "ment" + paragraphSeparator,
                ["request_hash"] = Hash1,
                ["policy_trust_source"] = "deployment",
                ["policy_record_hash"] = Hash2,
                ["policy_hash"] = Hash3,
                ["path"] = "/revit/context",
                ["method"] = "GET",
                ["evidence_record_hash"] = Hash4,
                ["effect_hash"] = Hash5,
                ["channel"] = "typed_mcp",
                ["canonicalization"] = OperatorCourierCertificationEnvelope.Canonicalization,
                ["body_sha256"] = Hash6,
                ["body_present"] = true,
                ["alias"] = "revit_ping"
            };
            var expectedEnvelope = "{\"alias\":\"revit_ping\",\"body_present\":true,\"body_sha256\":\"" + Hash6 + "\",\"canonicalization\":\"revit-operator.canonical-json.nfc-key-sorted.v1\",\"channel\":\"typed_mcp\",\"effect_hash\":\"" + Hash5 + "\",\"evidence_record_hash\":\"" + Hash4 + "\",\"method\":\"GET\",\"path\":\"/revit/context\",\"policy_hash\":\"" + Hash3 + "\",\"policy_record_hash\":\"" + Hash2 + "\",\"policy_trust_source\":\"deployment\",\"request_hash\":\"" + Hash1 + "\",\"runtime_mode\":\"develop" + lineSeparator + "ment" + paragraphSeparator + "\",\"schema\":\"revit-operator.revit-tool-certification-envelope.v1\",\"version\":1,\"workflow\":\"W \\\"q\\\" \\\\ root\\nCafé " + lineSeparator + "mid" + paragraphSeparator + "end\"}";
            using (var envelopeDocument = JsonDocument.Parse(JsonSerializer.Serialize(envelopeInput)))
            {
                var canonical = OperatorCourierCertificationEnvelopeVerifier.Canonicalize(envelopeDocument.RootElement);
                Assert.Equal(expectedEnvelope, canonical);
                Assert.Equal("sha256:1af08aa7b5e8ddb26b89b65e1454bc0ee54476f6f9f3e7f382e908b6f19e5b9d", OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(canonical));
                Assert.Contains(lineSeparator, canonical);
                Assert.Contains(paragraphSeparator, canonical);
            }

            var idempotencyInput = new Dictionary<string, object?>
            {
                ["target_document_title"] = "楼层 Cafe\u0301 " + lineSeparator + "Sheet" + paragraphSeparator,
                ["turn_token_sha256"] = Hash7,
                ["target_document_path"] = "C:\\模型\\Cafe\u0301\\A\"B\\sheet.rvt",
                ["schema"] = OperatorCourierCertificationEnvelope.IdempotencySchema,
                ["session_id"] = "session-α",
                ["path"] = "/revit/context",
                ["method"] = "GET",
                ["message_id"] = "message \"q\" \\ " + lineSeparator + paragraphSeparator,
                ["canonicalization"] = OperatorCourierCertificationEnvelope.Canonicalization,
                ["certification_envelope_hash"] = Hash8,
                ["body_sha256"] = Hash6,
                ["body_present"] = true,
                ["target_executor_id"] = "executor-β"
            };
            var expectedIdempotency = "{\"body_present\":true,\"body_sha256\":\"" + Hash6 + "\",\"canonicalization\":\"revit-operator.canonical-json.nfc-key-sorted.v1\",\"certification_envelope_hash\":\"" + Hash8 + "\",\"message_id\":\"message \\\"q\\\" \\\\ " + lineSeparator + paragraphSeparator + "\",\"method\":\"GET\",\"path\":\"/revit/context\",\"schema\":\"revit-operator.revit-tool-job-idempotency.v2\",\"session_id\":\"session-α\",\"target_document_path\":\"C:\\\\模型\\\\Café\\\\A\\\"B\\\\sheet.rvt\",\"target_document_title\":\"楼层 Café " + lineSeparator + "Sheet" + paragraphSeparator + "\",\"target_executor_id\":\"executor-β\",\"turn_token_sha256\":\"" + Hash7 + "\"}";
            using (var idempotencyDocument = JsonDocument.Parse(JsonSerializer.Serialize(idempotencyInput)))
            {
                var canonical = OperatorCourierCertificationEnvelopeVerifier.Canonicalize(idempotencyDocument.RootElement);
                Assert.Equal(expectedIdempotency, canonical);
                Assert.Equal("0e7ab16c4f9d7c74943d26351aff93945a7cd1d765026b51396a700aec66efe5", Sha256Hex(canonical));
            }
        }

        [Fact]
        public void V2_job_accepts_only_the_verified_body_json_and_returns_a_cloned_parsed_body()
        {
            var job = CreateValidJob(bodyPresent: true, bodyJson: "{\n  \"z\": \"line\\nA\", \"a\": \"\\\\\", \"order\": [2, 1]\n}");
            using (var document = JsonDocument.Parse(job))
            {
                var result = OperatorCourierCertificationEnvelopeVerifier.VerifyJob(document.RootElement);
                Assert.True(result.IsValid, result.Code + ": " + result.Error);
                Assert.NotNull(result.Envelope);
                Assert.True(result.ParsedBody.HasValue);
                Assert.Equal("line\nA", result.ParsedBody!.Value.GetProperty("z").GetString());
                Assert.Equal(2, result.ParsedBody!.Value.GetProperty("order")[0].GetInt32());
                Assert.Equal("typed_mcp", result.Envelope!.Channel);
                Assert.Equal("certified", result.Envelope.ExposureProfile);
            }
        }

        [Fact]
        public void Canonicalizer_rejects_NFC_normalized_key_collisions()
        {
            using (var document = JsonDocument.Parse("{\"Cafe\\u0301\":1,\"Café\":2}"))
            {
                var error = Assert.ThrowsAny<Exception>(() => OperatorCourierCertificationEnvelopeVerifier.Canonicalize(document.RootElement));
                Assert.Contains("duplicate normalized object key", error.Message);
            }
        }

        [Theory]
        [InlineData("policy_hash")]
        [InlineData("policy_record_hash")]
        [InlineData("evidence_record_hash")]
        [InlineData("request_hash")]
        [InlineData("effect_hash")]
        [InlineData("body_sha256")]
        [InlineData("method")]
        [InlineData("path")]
        [InlineData("channel")]
        [InlineData("alias")]
        [InlineData("workflow")]
        [InlineData("runtime_mode")]
        [InlineData("exposure_profile")]
        [InlineData("policy_trust_source")]
        public void Any_immutable_envelope_field_mutation_fails_closed(string field)
        {
            var job = CreateValidJob(bodyPresent: true, bodyJson: "{\"a\":1}", workflow: "schedule_cell_update_runtime");
            var replacement = field.EndsWith("hash", StringComparison.Ordinal) || field == "body_sha256"
                ? "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                : field == "method" ? "POST"
                : field == "path" ? "/revit/other"
                : field == "channel" ? "generic_call"
                : field == "alias" ? "revit_call_tool"
                : field == "workflow" ? "other_workflow"
                : field == "runtime_mode" ? "production"
                : field == "exposure_profile" ? "laboratory"
                : "bundled";
            var mutated = MutateEnvelope(job, field, JsonSerializer.Serialize(replacement));

            var result = OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(mutated);
            Assert.False(result.IsValid);
            Assert.Null(result.ParsedBody);
            Assert.NotEqual("CERT_COURIER_ENVELOPE_VALID", result.Code);
        }

        [Fact]
        public void Body_presence_and_exact_raw_bytes_are_part_of_the_verified_contract()
        {
            var absent = CreateValidJob(bodyPresent: false, bodyJson: "");
            Assert.True(OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(absent).IsValid);

            var nullBody = CreateValidJob(bodyPresent: true, bodyJson: "null");
            var nullResult = OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(nullBody);
            Assert.True(nullResult.IsValid, nullResult.Code);
            Assert.Equal(JsonValueKind.Null, nullResult.ParsedBody!.Value.ValueKind);

            var presentMismatch = MutateTopLevel(absent, "body_present", "true");
            Assert.Equal("CERT_COURIER_BODY_PRESENCE_MISMATCH", OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(presentMismatch).Code);

            var rawBytesMutated = MutateTopLevel(CreateValidJob(bodyPresent: true, bodyJson: "{\"a\":1,\"b\":2}"), "body_json", "\"{\\\"b\\\":2,\\\"a\\\":1}\"");
            Assert.Equal("CERT_COURIER_BODY_HASH_MISMATCH", OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(rawBytesMutated).Code);

            var absentNotEmpty = MutateTopLevel(absent, "body_json", "\"null\"");
            Assert.Equal("CERT_COURIER_BODY_PRESENCE_INVALID", OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(absentNotEmpty).Code);

            var bodyNull = MutateTopLevel(absent, "body_json", "null");
            Assert.Equal("CERT_COURIER_JOB_FIELD_INVALID", OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(bodyNull).Code);

            var invalidJson = CreateValidJob(bodyPresent: true, bodyJson: "not-json");
            Assert.Equal("CERT_COURIER_BODY_JSON_INVALID", OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(invalidJson).Code);
        }

        [Fact]
        public void Malformed_legacy_unknown_missing_and_duplicate_envelopes_are_terminal_no_execute_results()
        {
            Assert.Equal("CERT_COURIER_JOB_MALFORMED", OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson("not-json").Code);
            Assert.Equal("CERT_COURIER_LEGACY_JOB_REJECTED", OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson("{\"version\":\"revit-operator.revit-tool-job.v1\"}").Code);

            var valid = CreateValidJob(bodyPresent: false, bodyJson: "");
            var unknown = valid.Replace("\"envelope_hash\":", "\"unexpected\":true,\"envelope_hash\":");
            Assert.Equal("CERT_COURIER_ENVELOPE_UNKNOWN_FIELD", OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(unknown).Code);

            var missing = valid.Replace("\"alias\":\"revit_ping\",", "");
            Assert.Equal("CERT_COURIER_ENVELOPE_FIELD_MISSING", OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(missing).Code);

            var duplicate = valid.Replace("\"alias\":\"revit_ping\",", "\"alias\":\"revit_ping\",\"alias\":\"revit_ping\",");
            Assert.Equal("CERT_COURIER_ENVELOPE_DUPLICATE_KEY", OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(duplicate).Code);
        }

        [Fact]
        public void Idempotency_identity_and_token_digest_are_required_and_raw_token_is_forbidden()
        {
            var valid = CreateValidJob(bodyPresent: false, bodyJson: "");
            var idMismatch = MutateTopLevel(valid, "id", "\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"");
            Assert.Equal("CERT_COURIER_IDEMPOTENCY_MISMATCH", OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(idMismatch).Code);

            var rawToken = valid.Replace("\"turn_token_sha256\":", "\"turn_token\":\"secret\",\"turn_token_sha256\":");
            Assert.Equal("CERT_COURIER_RAW_TOKEN_FORBIDDEN", OperatorCourierCertificationEnvelopeVerifier.VerifyJobJson(rawToken).Code);
        }

        private static string CreateValidJob(bool bodyPresent, string bodyJson, string? workflow = null)
        {
            var bodyHash = OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(bodyJson);
            var envelope = new Dictionary<string, object?>
            {
                ["schema"] = OperatorCourierCertificationEnvelope.Schema,
                ["version"] = 1,
                ["canonicalization"] = OperatorCourierCertificationEnvelope.Canonicalization,
                ["policy_hash"] = Hash1,
                ["policy_record_hash"] = Hash2,
                ["evidence_record_hash"] = Hash3,
                ["request_hash"] = Hash4,
                ["effect_hash"] = Hash5,
                ["method"] = "GET",
                ["path"] = "/revit/ping",
                ["body_present"] = bodyPresent,
                ["body_sha256"] = bodyHash,
                ["channel"] = "typed_mcp",
                ["alias"] = "revit_ping",
                ["runtime_mode"] = "hosted",
                ["exposure_profile"] = "certified",
                ["policy_trust_source"] = "deployment"
            };
            if (workflow != null) envelope.Add("workflow", workflow);
            var payload = JsonSerializer.Serialize(envelope);
            using (var payloadDocument = JsonDocument.Parse(payload))
            {
                envelope.Add("envelope_hash", OperatorCourierCertificationEnvelopeVerifier.Sha256Prefixed(OperatorCourierCertificationEnvelopeVerifier.Canonicalize(payloadDocument.RootElement)));
            }

            var idempotency = OperatorCourierCertificationEnvelopeVerifier.ComputeV2IdempotencyKey(
                (string)envelope["envelope_hash"]!,
                "GET",
                "/revit/ping",
                "session-a",
                "message-a",
                Hash6,
                "executor-a",
                "model-a",
                "C:\\models\\model-a.rvt",
                bodyPresent,
                bodyHash);
            var job = new Dictionary<string, object?>
            {
                ["version"] = OperatorCourierCertificationEnvelope.JobVersion,
                ["id"] = idempotency,
                ["idempotency_key"] = idempotency,
                ["session_id"] = "session-a",
                ["message_id"] = "message-a",
                ["turn_token_sha256"] = Hash6,
                ["method"] = "GET",
                ["path"] = "/revit/ping",
                ["target_executor_id"] = "executor-a",
                ["target_document_title"] = "model-a",
                ["target_document_path"] = "C:\\models\\model-a.rvt",
                ["body_present"] = bodyPresent,
                ["body_json"] = bodyJson,
                ["body"] = "untrusted legacy/display body must not be read",
                ["certification_envelope"] = envelope
            };
            return JsonSerializer.Serialize(job);
        }

        private static string MutateEnvelope(string job, string field, string replacementJson)
        {
            var marker = "\"" + field + "\":";
            var envelopeStart = job.IndexOf("\"certification_envelope\":", StringComparison.Ordinal);
            var start = envelopeStart < 0 ? -1 : job.IndexOf(marker, envelopeStart, StringComparison.Ordinal);
            Assert.True(start >= 0, "Envelope field was not found: " + field);
            start += marker.Length;
            var end = FindJsonValueEnd(job, start);
            return job.Substring(0, start) + replacementJson + job.Substring(end);
        }

        private static string MutateTopLevel(string job, string field, string replacementJson)
        {
            var marker = "\"" + field + "\":";
            var start = job.IndexOf(marker, StringComparison.Ordinal);
            Assert.True(start >= 0, "Top-level field was not found: " + field);
            start += marker.Length;
            var end = FindJsonValueEnd(job, start);
            return job.Substring(0, start) + replacementJson + job.Substring(end);
        }

        private static int FindJsonValueEnd(string json, int start)
        {
            if (json[start] != '\"')
            {
                var comma = json.IndexOf(',', start);
                var close = json.IndexOf('}', start);
                if (comma < 0) return close;
                if (close < 0) return comma;
                return Math.Min(comma, close);
            }
            var escaped = false;
            for (var index = start + 1; index < json.Length; index++)
            {
                if (escaped)
                {
                    escaped = false;
                    continue;
                }
                if (json[index] == '\\')
                {
                    escaped = true;
                    continue;
                }
                if (json[index] == '\"') return index + 1;
            }
            throw new InvalidOperationException("Unterminated JSON string.");
        }

        private static string Sha256Hex(string value)
        {
            using (var sha = SHA256.Create())
            {
                var bytes = sha.ComputeHash(new UTF8Encoding(false, true).GetBytes(value));
                var builder = new StringBuilder(bytes.Length * 2);
                foreach (var valueByte in bytes) builder.Append(valueByte.ToString("x2"));
                return builder.ToString();
            }
        }
    }
}
