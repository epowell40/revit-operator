using System;
using System.Text;
using RevitOperator.SafeReadHost.Kernel;
using Xunit;

namespace RevitOperator.SafeReadHost.Tests
{
    public sealed class KernelFactsAndFailureBoundsTests
    {
        [Fact]
        public void Frozen_kernel_facts_are_exact()
        {
            Assert.Equal("AAFAA2C0-43F1-42A0-A6B4-D9A0C5F5CE0E", SafeReadContract.ProductId);
            Assert.Equal("POST", SafeReadContract.Method);
            Assert.Equal("/revit/certified/sheets/count", SafeReadContract.Path);
            Assert.Equal(
                "{\"schema\":\"revit-operator.safe-read.sheets-count.request.v1\"}",
                Encoding.UTF8.GetString(SafeReadContract.CopyRequestBytes()));
            Assert.Equal(5040, SafeReadContract.MinimumPort);
            Assert.Equal(5050, SafeReadContract.MaximumPort);
            Assert.Equal(100000, SafeReadContract.MaximumSheetCount);
            Assert.Equal(4096, SafeReadContract.MaximumResponseBytes);
            Assert.Equal("revit-operator.safe-read-preauthorization-request.v1", SafeReadContract.PreauthorizationRequestSchema);
            Assert.Equal("revit-operator.safe-read-preauthorization-response.v1", SafeReadContract.PreauthorizationResponseSchema);
            Assert.Equal("revit-operator.safe-read-final-authorization-request.v1", SafeReadContract.FinalAuthorizationRequestSchema);
            Assert.Equal("revit-operator.safe-read-final-authorization-receipt.v1", SafeReadContract.FinalAuthorizationReceiptSchema);
        }

        [Fact]
        public void Every_failure_is_fixed_valid_utf8_and_bounded()
        {
            FailureCode[] codes = (FailureCode[])Enum.GetValues(typeof(FailureCode));
            for (int index = 0; index < codes.Length; index++)
            {
                if (codes[index] == FailureCode.None)
                    continue;
                ResponsePayload payload = ResponsePayload.Failure(codes[index]);
                string json = new UTF8Encoding(false, true).GetString(payload.Body);
                Assert.InRange(payload.Body.Length, 1, SafeReadContract.MaximumResponseBytes);
                Assert.StartsWith("{\"schema\":\"revit-operator.safe-read.failure.v1\",\"code\":\"", json);
                Assert.EndsWith("\"}", json);
                Assert.DoesNotContain("exception", json, StringComparison.OrdinalIgnoreCase);
                Assert.DoesNotContain("stack", json, StringComparison.OrdinalIgnoreCase);
            }
        }

        [Theory]
        [InlineData((int)FailureCode.BadRequest, 400, "bad_request")]
        [InlineData((int)FailureCode.Unauthorized, 403, "unauthorized")]
        [InlineData((int)FailureCode.Busy, 409, "busy")]
        [InlineData((int)FailureCode.NoActiveDocument, 409, "no_active_document")]
        [InlineData((int)FailureCode.DocumentChanged, 409, "document_changed")]
        [InlineData((int)FailureCode.NotReadOnly, 409, "document_not_read_only")]
        [InlineData((int)FailureCode.CountLimitExceeded, 422, "sheet_count_limit_exceeded")]
        [InlineData((int)FailureCode.AuthorizationUnavailable, 503, "authorization_unavailable")]
        [InlineData((int)FailureCode.RevitUnavailable, 503, "revit_unavailable")]
        [InlineData((int)FailureCode.InternalFailure, 500, "internal_failure")]
        public void Failure_status_and_body_mapping_is_exact(int codeValue, int status, string wireCode)
        {
            FailureCode code = (FailureCode)codeValue;
            ResponsePayload payload = ResponsePayload.Failure(code);

            Assert.Equal(status, payload.StatusCode);
            Assert.Equal(
                "{\"schema\":\"revit-operator.safe-read.failure.v1\",\"code\":\"" + wireCode + "\"}",
                Encoding.UTF8.GetString(payload.Body));
        }

        [Fact]
        public void Success_is_exact_and_bounded_at_the_cap()
        {
            ResponsePayload payload = ResponsePayload.Success(SafeReadContract.MaximumSheetCount);

            Assert.Equal(200, payload.StatusCode);
            Assert.Equal(
                "{\"schema\":\"revit-operator.safe-read.sheets-count.response.v1\",\"count\":100000}",
                Encoding.UTF8.GetString(payload.Body));
            Assert.True(payload.Body.Length <= SafeReadContract.MaximumResponseBytes);
        }

        [Theory]
        [InlineData("https://operator.example", true, "https://operator.example")]
        [InlineData("https://operator.example:8443/", true, "https://operator.example:8443")]
        [InlineData("http://127.0.0.1:3000", true, "http://127.0.0.1:3000")]
        [InlineData("http://localhost:3000", false, null)]
        [InlineData("http://operator.example", false, null)]
        [InlineData("https://operator.example/path", false, null)]
        [InlineData("https://user@operator.example", false, null)]
        [InlineData(" https://operator.example", false, null)]
        public void Backend_origin_is_fixed_and_pathless(string input, bool expected, string? normalized)
        {
            FixedBackendOrigin? origin;
            bool valid = FixedBackendOrigin.TryCreate(input, out origin);

            Assert.Equal(expected, valid);
            Assert.Equal(normalized, origin == null ? null : origin.Value);
        }
    }
}
