using System.Collections.Generic;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class MepNetworkApplyPolicyTests
    {
        [Fact]
        public void Verify_Passes_When_All_Created_Ids_Exist_And_Audits_Are_Not_Negative()
        {
            var result = MepNetworkApplyPolicy.Verify(
                new long[] { 101, 102, 103 },
                new long[] { 103, 101, 102, 999 },
                new string?[] { "Ok", "Passed" },
                verifyAudits: true);

            Assert.True(result.Pass);
            Assert.Empty(result.MissingElementIds);
            Assert.Empty(result.FailedAuditBranchIndices);
        }

        [Fact]
        public void Verify_Fails_When_Any_Created_Id_Is_Missing()
        {
            var result = MepNetworkApplyPolicy.Verify(
                new long[] { 101, 102, 103 },
                new long[] { 101, 103 },
                new string?[] { "Ok" },
                verifyAudits: true);

            Assert.False(result.Pass);
            Assert.Equal(new long[] { 102 }, result.MissingElementIds);
        }

        [Fact]
        public void Verify_Fails_When_A_Branch_Audit_Explicitly_Fails()
        {
            var result = MepNetworkApplyPolicy.Verify(
                new long[] { 101 },
                new long[] { 101 },
                new string?[] { "Ok", "Failed", "BlockedByConnectorAudit" },
                verifyAudits: true);

            Assert.False(result.Pass);
            Assert.Equal(new[] { 1, 2 }, result.FailedAuditBranchIndices);
        }

        [Fact]
        public void Verify_Fails_Closed_When_A_Branch_Audit_Is_Missing_Or_Unknown()
        {
            var result = MepNetworkApplyPolicy.Verify(
                new long[] { 101 },
                new long[] { 101 },
                new string?[] { null, "Maybe" },
                verifyAudits: true);

            Assert.False(result.Pass);
            Assert.Equal(new[] { 0, 1 }, result.FailedAuditBranchIndices);
        }

        [Fact]
        public void Verify_Ignores_Audit_Statuses_When_Explicit_Audit_Is_Disabled()
        {
            var result = MepNetworkApplyPolicy.Verify(
                new long[] { 101 },
                new long[] { 101 },
                new string?[] { "Failed" },
                verifyAudits: false);

            Assert.True(result.Pass);
        }
    }
}
