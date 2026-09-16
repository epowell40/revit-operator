using System;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class OperatorWriteGrantAdmissionTests
    {
        [Fact]
        public void Repeated_automatic_renewal_does_not_revoke_a_prepared_session_request()
        {
            using var f = new WriteGrantFixture();
            var prepared = f.Store.Issue(OperatorWriteGrantMode.Session, TimeSpan.FromMinutes(15)).Token;
            for (int i = 0; i < 4; ++i)
            {
                f.Now = f.Now.AddMinutes(13);
                f.NewReader().RenewSession(TimeSpan.FromMinutes(15));
                Assert.True(f.NewReader().ValidateAndConsumeIfNeeded(prepared, out var error), error);
            }
        }

        [Fact]
        public void Explicit_reissue_and_revocation_still_reject_prepared_old_requests()
        {
            using var f = new WriteGrantFixture();
            var original = f.Store.Issue(OperatorWriteGrantMode.Session, TimeSpan.FromMinutes(15));
            var replacement = f.Store.Issue(OperatorWriteGrantMode.Session, TimeSpan.FromMinutes(15));
            Assert.NotEqual(original.Token, replacement.Token);
            Assert.False(f.NewReader().ValidateAndConsumeIfNeeded(original.Token, out _));
            Assert.True(f.NewReader().ValidateAndConsumeIfNeeded(replacement.Token, out _));
            f.Store.Clear();
            Assert.False(f.NewReader().ValidateAndConsumeIfNeeded(replacement.Token, out _));
        }

        [Fact]
        public void One_use_authority_is_consumed_once_and_foreign_or_expired_tokens_fail()
        {
            using var f = new WriteGrantFixture();
            var grant = f.Store.Issue(OperatorWriteGrantMode.Once, TimeSpan.FromMinutes(10));
            Assert.False(f.NewReader().ValidateAndConsumeIfNeeded("unrelated", out _));
            Assert.True(f.NewReader().ValidateAndConsumeIfNeeded(grant.Token, out _));
            Assert.False(f.NewReader().ValidateAndConsumeIfNeeded(grant.Token, out _));
            grant = f.Store.Issue(OperatorWriteGrantMode.Session, TimeSpan.FromMinutes(15));
            f.Now = f.Now.AddMinutes(16);
            Assert.False(f.NewReader().ValidateAndConsumeIfNeeded(grant.Token, out _));
        }
    }
}
