using System;
using System.Collections.Generic;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class TextNoteOrientationReadbackTests
    {
        [Fact]
        public void PlanTextRetainsNativePositionAndRotatedBasis()
        {
            var angle = Math.PI / 6;
            var position = new[] { 4.0, -5.0, 0.0 };
            var result = TextNoteOrientationReadback.Create(position,
                new[] { Math.Cos(angle), Math.Sin(angle), 0.0 },
                new[] { -Math.Sin(angle), Math.Cos(angle), 0.0 });
            position[0] = 100;
            Assert.Equal(4.0, result.pointXyz[0]);
            Assert.Equal(Math.Sin(angle), result.baseDirectionXyz[1]);
            Assert.Equal(-Math.Sin(angle), result.upDirectionXyz[0]);
            using var json = JsonDocument.Parse(JsonSerializer.Serialize(result));
            Assert.Equal("TextNote", json.RootElement.GetProperty("kind").GetString());
            Assert.False(json.RootElement.TryGetProperty("rotationRadians", out _));
        }

        [Fact]
        public void SectionTextDoesNotInferWorldXyRotation()
        {
            var result = TextNoteOrientationReadback.Create(new[] { 2.0, 8.0, 12.0 },
                new[] { 0.0, 1.0, 0.0 }, new[] { 0.0, 0.0, 1.0 });
            Assert.Equal(new[] { 0.0, 1.0, 0.0 }, result.baseDirectionXyz);
            Assert.Equal(new[] { 0.0, 0.0, 1.0 }, result.upDirectionXyz);
        }

        [Theory]
        [InlineData(double.NaN)]
        [InlineData(double.PositiveInfinity)]
        [InlineData(double.NegativeInfinity)]
        public void NonFiniteNativePositionIsNotKnownReadback(double value)
        {
            Assert.Throws<InvalidOperationException>(() => TextNoteOrientationReadback.Create(
                new[] { value, 0.0, 0.0 }, new[] { 1.0, 0.0, 0.0 }, new[] { 0.0, 1.0, 0.0 }));
        }

        [Fact]
        public void MissingZeroParallelAndOverflowingDirectionsFailClosed()
        {
            var point = new[] { 0.0, 0.0, 0.0 };
            var basis = new[] { 1.0, 0.0, 0.0 };
            Assert.Throws<InvalidOperationException>(() => TextNoteOrientationReadback.Create(point, new[] { 1.0 }, basis));
            Assert.Throws<InvalidOperationException>(() => TextNoteOrientationReadback.Create(point, point, basis));
            Assert.Throws<InvalidOperationException>(() => TextNoteOrientationReadback.Create(point, basis, basis));
            Assert.Throws<InvalidOperationException>(() => TextNoteOrientationReadback.Create(point,
                new[] { double.MaxValue, double.MaxValue, 0.0 }, new[] { 0.0, 0.0, 1.0 }));
        }

        [Fact]
        public void FailedPostCommitTextReadbackPreservesCommittedEffectWithoutRetry()
        {
            var response = new Dictionary<string, object?>
            {
                ["success"] = true,
                ["applied"] = true,
                ["transaction"] = OperatorNativeTransactionReceipt.FromObservedStatus("Committed", new[] { 41L })
            };
            var reads = 0;
            OperatorNativeTransactionExecution.ReadCommitted(response, () =>
            {
                reads++;
                // Retained failure: a committed TextNote rotation had no generic
                // Location or model bbox. That error must never erase its effect.
                throw new InvalidOperationException("Native location readback is unavailable.");
            });
            Assert.Equal(1, reads);
            Assert.Equal(true, response["applied"]);
            Assert.Equal(false, response["success"]);
            Assert.Equal("applied", OperatorAttemptSuccessfulSettlement.Classify(response,
                "apply", "POST", "/revit/rotate-elements").EffectState);
            // A later native annotation read is new evidence, not a rewrite of
            // the historical committed-with-readback-error response.
            var fresh = TextNoteOrientationReadback.Create(new[] { 4.0, 5.0, 0.0 },
                new[] { 0.0, 1.0, 0.0 }, new[] { -1.0, 0.0, 0.0 });
            Assert.Equal("TextNote", fresh.kind);
            Assert.Equal(false, response["success"]);
            Assert.Equal(1, reads);
        }
    }
}
