using System;
using System.Collections.Generic;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorPrintSettingsGuardTests
    {
        [Fact]
        public void StagedFileSettingsAreAppliedBeforeGlobalReadbackAndRestoredAfterSubmission()
        {
            var global = new Dictionary<string, object> { ["PrintToFile"] = false, ["PrintToFileName"] = "old.pdf" };
            var local = new Dictionary<string, object>(global);
            var applies = 0;
            void Apply() { foreach (var pair in local) global[pair.Key] = pair.Value; applies++; }
            var guard = new OperatorPrintSettingsGuard(new[] { "PrintToFile", "PrintToFileName" }, name => global[name],
                (name, value) => local[name] = value, Apply);
            local["PrintToFile"] = true; local["PrintToFileName"] = "M000-singlecopy-check.pdf";
            Assert.False((bool)global["PrintToFile"]); // The old pre-Apply validation rejects this valid staged change.
            var submissions = 0;
            try
            {
                OperatorPrintSettingsGuard.ApplyAndValidateOutput(Apply, () => (bool)global["PrintToFile"],
                    () => (string)global["PrintToFileName"], "M000-singlecopy-check.pdf");
                Assert.Equal(1, applies); submissions++;
            }
            finally { Assert.True(guard.Restore(out var errors)); Assert.Empty(errors); }
            Assert.Equal(1, submissions); Assert.Equal(2, applies);
            Assert.False((bool)global["PrintToFile"]); Assert.Equal("old.pdf", global["PrintToFileName"]);
        }

        [Theory]
        [InlineData("ignored")]
        [InlineData("wrong_path")]
        [InlineData("apply_throws")]
        [InlineData("read_throws")]
        public void UnacceptedOrUnreadableAppliedSettingsPreventSubmissionAndStillRestore(string failure)
        {
            var global = new Dictionary<string, object> { ["PrintToFile"] = false, ["PrintToFileName"] = "old.pdf" };
            var guard = new OperatorPrintSettingsGuard(new[] { "PrintToFile", "PrintToFileName" }, name => global[name],
                (name, value) => global[name] = value, () => { });
            var submissions = 0;
            void Apply()
            {
                if (failure == "ignored") return;
                global["PrintToFile"] = true;
                global["PrintToFileName"] = failure == "wrong_path" ? "wrong.pdf" : "requested.pdf";
                if (failure == "apply_throws") throw new InvalidOperationException("apply failed after changes");
            }
            try
            {
                Assert.Throws<InvalidOperationException>(() =>
                {
                    OperatorPrintSettingsGuard.ApplyAndValidateOutput(Apply,
                        () => failure == "read_throws" ? throw new InvalidOperationException("read failed") : (bool)global["PrintToFile"],
                        () => (string)global["PrintToFileName"], "requested.pdf");
                    submissions++;
                });
            }
            finally { Assert.True(guard.Restore(out var errors)); Assert.Empty(errors); }
            Assert.Equal(0, submissions); Assert.False((bool)global["PrintToFile"]); Assert.Equal("old.pdf", global["PrintToFileName"]);
        }

        [Theory]
        [InlineData(true, 1, false, 1)]
        [InlineData(false, 1, false, 1)]
        [InlineData(true, 1, false, 2)]
        [InlineData(true, 2, false, 1)]
        [InlineData(true, 2, true, 2)]
        public void ExplicitInapplicableCollationDoesNotReadOrWriteUnavailableSetting(bool requested, int views, bool individual, int copies)
        {
            var effective = OperatorPrintSettingsGuard.EffectiveCollation(requested, views, individual, copies);
            Assert.Null(effective);
            var fields = OperatorPrintSettingsGuard.FieldsForPrint(!individual, effective.HasValue);
            var global = new Dictionary<string, object>();
            foreach (var name in fields) global[name] = "original " + name;
            object Read(string name) => name == "Collate"
                ? throw new InvalidOperationException("Collate is only available when there are more than 1 views and more than 1 copies.")
                : global[name];
            var writes = new List<string>();
            var guard = new OperatorPrintSettingsGuard(fields, Read, (name, value) => { writes.Add(name); global[name] = value; }, () => { });
            global["PrintToFileName"] = "artifacts/prints/M000-collate-check.pdf";
            Assert.True(guard.Restore(out var errors)); Assert.Empty(errors);
            Assert.Equal("original PrintToFileName", global["PrintToFileName"]);
            Assert.DoesNotContain("Collate", writes);
        }

        [Theory]
        [InlineData(true)]
        [InlineData(false)]
        [InlineData(null)]
        public void MultipleCopiesOfMultipleViewsPreserveExplicitCollationIntent(bool? requested)
        {
            Assert.Equal(requested, OperatorPrintSettingsGuard.EffectiveCollation(requested, 2, false, 2));
        }

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public void SingleCopyPrintDoesNotReadUnavailableUnrequestedCollation(bool selectedSet)
        {
            var fields = OperatorPrintSettingsGuard.FieldsForPrint(selectedSet, false);
            var global = new Dictionary<string, object>();
            foreach (var name in fields) global[name] = "original " + name;
            object Read(string name) => name == "Collate"
                ? throw new InvalidOperationException("Collate is only available when there are more than 1 views and more than 1 copies.")
                : global[name];
            var guard = new OperatorPrintSettingsGuard(fields, Read, (name, value) => global[name] = value, () => { });
            global["PrintToFileName"] = "M000-driver-check.pdf";
            Assert.True(guard.Restore(out var errors)); Assert.Empty(errors);
            Assert.Equal("original PrintToFileName", global["PrintToFileName"]);
            Assert.Equal(selectedSet, global.ContainsKey("ViewSelection"));
            Assert.Throws<InvalidOperationException>(() => new OperatorPrintSettingsGuard(
                OperatorPrintSettingsGuard.FieldsForPrint(selectedSet, true), Read, (_, __) => throw new Exception("must not write"),
                () => throw new Exception("must not apply")));
        }

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
