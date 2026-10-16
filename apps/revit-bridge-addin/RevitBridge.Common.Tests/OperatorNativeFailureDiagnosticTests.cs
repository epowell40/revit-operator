using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorNativeFailureDiagnosticTests
    {
        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void Fail() => throw new InvalidOperationException("Private message must not appear");

        [Fact]
        public void NativeFailureContextIsBoundedAndDoesNotSerializeMessagesOrData()
        {
            try { Fail(); }
            catch (Exception error)
            {
                error.Data["private"] = "private-value";
                var value = JsonSerializer.SerializeToElement(OperatorNativeFailureDiagnostic.Capture(error, "insert_binding"));
                Assert.Equal("insert_binding", value.GetProperty("stage").GetString());
                Assert.Equal(typeof(InvalidOperationException).FullName, value.GetProperty("exceptionType").GetString());
                Assert.Contains(nameof(Fail), value.GetProperty("stackMethods")[0].GetString());
                Assert.InRange(value.GetProperty("stackMethods").GetArrayLength(), 1, 24);
                Assert.DoesNotContain("Private message", value.GetRawText());
                Assert.DoesNotContain("private-value", value.GetRawText());
                Assert.False(value.TryGetProperty("transaction", out _));
                Assert.False(value.TryGetProperty("verified", out _));
            }
        }

        [Fact]
        public void DiagnosticCannotChangeRolledBackNativeAuthorityOrSalvageTransientResults()
        {
            object? diagnostic = null;
            var status = "Uninitialized";
            var result = OperatorNativeTransactionExecution.Execute(
                () => status = "Started", () => status = "Committed", () => status = "RolledBack", () => status,
                () => { try { Fail(); return new Dictionary<string, object?> { ["parameter"] = 42 }; }
                    catch (Exception error) { diagnostic = OperatorNativeFailureDiagnostic.Capture(error, "lookup_parameter"); throw; } },
                () => OperatorNativeTransactionReceipt.Committed(Array.Empty<long>()));
            result["failureDiagnostic"] = diagnostic;
            Assert.False((bool)result["success"]!);
            Assert.Equal("Blocked", OperatorNativeTransactionExecution.OutcomeStatus(result, "Success"));
            Assert.Equal("rolled_back", ((OperatorNativeTransactionReceipt)result["transaction"]!).Status);
            Assert.False(result.ContainsKey("parameter"));
            Assert.NotNull(diagnostic);
        }

        [Theory]
        [InlineData("input with spaces")]
        [InlineData("C:\\private\\path")]
        [InlineData("")]
        public void InvalidStageIsNotEchoed(string stage)
        {
            var value = JsonSerializer.SerializeToElement(OperatorNativeFailureDiagnostic.Capture(new Exception("unused"), stage));
            Assert.Equal("unknown", value.GetProperty("stage").GetString());
        }
    }
}
