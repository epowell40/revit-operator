using System;
using System.Collections.Generic;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorPrintSettingsGuardTests
    {
        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public void SubmissionSuccessOrFailureStillRequiresGlobalSettingsRestoration(bool submitFailed)
        {
            var global = new Dictionary<string, object> { ["printer"] = "Original", ["file"] = "old.pdf", ["copies"] = 1 };
            var local = new Dictionary<string, object>();
            var applies = 0;
            var guard = new OperatorPrintSettingsGuard(new[] { "printer", "file", "copies" }, name => global[name],
                (name, value) => local[name] = value, () => { foreach (var pair in local) global[pair.Key] = pair.Value; applies++; });
            try { global["printer"] = "PDF"; global["file"] = "new.pdf"; if (submitFailed) throw new InvalidOperationException("submission failed after changing globals"); }
            catch (InvalidOperationException) { }
            Assert.True(guard.Restore(out var errors)); Assert.Empty(errors); Assert.Equal(1, applies);
            Assert.Equal("Original", global["printer"]); Assert.Equal("old.pdf", global["file"]); Assert.Equal(1, global["copies"]);
        }

        [Fact]
        public void SetterOrApplyFailureCannotPretendRestorationAndOtherFieldsAreStillAttempted()
        {
            var global = new Dictionary<string, object> { ["printer"] = "Original", ["file"] = "old.pdf" };
            var guard = new OperatorPrintSettingsGuard(new[] { "printer", "file" }, name => global[name],
                (name, value) => { if (name == "printer") throw new InvalidOperationException("restore denied"); global[name] = value; }, () => { });
            global["printer"] = "PDF"; global["file"] = "new.pdf";
            Assert.False(guard.Restore(out var errors)); Assert.NotEmpty(errors); Assert.Equal("old.pdf", global["file"]);
        }

        [Fact]
        public void ApplyFailureOrStaleGlobalReadbackCannotProveRestoration()
        {
            foreach (var throws in new[] { false, true })
            {
                object global = "original";
                var guard = new OperatorPrintSettingsGuard(new[] { "file" }, _ => global, (_, __) => { },
                    () => { if (throws) throw new InvalidOperationException("apply failed"); });
                global = "changed";
                Assert.False(guard.Restore(out var errors)); Assert.NotEmpty(errors);
            }
        }

        [Fact]
        public void UnreadableInitialStateFailsBeforeAnyWriteOrApply()
        {
            var writes = 0;
            Assert.Throws<InvalidOperationException>(() => new OperatorPrintSettingsGuard(new[] { "printer" },
                _ => throw new InvalidOperationException("unreadable"), (_, __) => writes++, () => writes++));
            Assert.Equal(0, writes);
        }
    }
}
