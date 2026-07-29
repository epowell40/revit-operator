using System;
using RevitOperator.SafeReadHost.Kernel;
using Xunit;

namespace RevitOperator.SafeReadHost.Tests
{
    public sealed class DocumentBindingTests
    {
        [Fact]
        public void Session_is_stable_for_one_open_document_and_rotates_for_every_reopen_or_switch()
        {
            DocumentSessionTracker tracker = new DocumentSessionTracker();
            object firstDocument = new object();
            object secondDocument = new object();

            DocumentBinding first = tracker.Observe(Facts(firstDocument, TestFacts.ProjectFingerprint, false, false))!;
            DocumentBinding same = tracker.Observe(Facts(firstDocument, TestFacts.ProjectFingerprint, false, false))!;
            Assert.Equal(first.DocumentSessionId, same.DocumentSessionId);

            DocumentBinding switched = tracker.Observe(Facts(secondDocument, TestFacts.ProjectFingerprint, false, false))!;
            Assert.NotEqual(first.DocumentSessionId, switched.DocumentSessionId);

            DocumentBinding switchedBack = tracker.Observe(Facts(firstDocument, TestFacts.ProjectFingerprint, false, false))!;
            Assert.Equal(first.DocumentSessionId, switchedBack.DocumentSessionId);

            tracker.ClearIfCurrent(firstDocument);
            DocumentBinding reopened = tracker.Observe(Facts(firstDocument, TestFacts.ProjectFingerprint, false, false))!;
            Assert.NotEqual(first.DocumentSessionId, reopened.DocumentSessionId);
        }

        [Fact]
        public void Fingerprint_change_rotates_session_even_for_same_runtime_object()
        {
            DocumentSessionTracker tracker = new DocumentSessionTracker();
            object document = new object();
            DocumentBinding first = tracker.Observe(Facts(document, "sha256:" + new string('a', 64), false, false))!;
            DocumentBinding changed = tracker.Observe(Facts(document, "sha256:" + new string('b', 64), false, false))!;

            Assert.NotEqual(first.DocumentSessionId, changed.DocumentSessionId);
        }

        [Fact]
        public void Binding_verifier_rejects_runtime_fingerprint_session_modifiable_and_modified_drift()
        {
            object document = new object();
            DocumentBinding expected = TestFacts.Binding(document, false);

            Assert.Equal(FailureCode.None, DocumentBindingVerifier.Verify(
                expected,
                Facts(document, TestFacts.ProjectFingerprint, false, false),
                TestFacts.DocumentSessionId));
            Assert.Equal(FailureCode.DocumentChanged, DocumentBindingVerifier.Verify(
                expected,
                Facts(new object(), TestFacts.ProjectFingerprint, false, false),
                TestFacts.DocumentSessionId));
            Assert.Equal(FailureCode.DocumentChanged, DocumentBindingVerifier.Verify(
                expected,
                Facts(document, "sha256:" + new string('a', 64), false, false),
                TestFacts.DocumentSessionId));
            Assert.Equal(FailureCode.DocumentChanged, DocumentBindingVerifier.Verify(
                expected,
                Facts(document, TestFacts.ProjectFingerprint, false, false),
                TestFacts.ClientSessionId));
            Assert.Equal(FailureCode.NotReadOnly, DocumentBindingVerifier.Verify(
                expected,
                Facts(document, TestFacts.ProjectFingerprint, true, false),
                TestFacts.DocumentSessionId));
            Assert.Equal(FailureCode.DocumentChanged, DocumentBindingVerifier.Verify(
                expected,
                Facts(document, TestFacts.ProjectFingerprint, false, true),
                TestFacts.DocumentSessionId));
        }

        [Fact]
        public void Project_fingerprint_is_stable_for_equivalent_path_spelling_and_changes_with_identity()
        {
            string first = ProjectFingerprint.Compute("Project", "C:/Models/Test.rvt", "uid-1");
            string equivalent = ProjectFingerprint.Compute("Project", "c:\\models\\test.rvt", "uid-1");
            string changed = ProjectFingerprint.Compute("Project", "c:\\models\\test.rvt", "uid-2");

            Assert.Equal(first, equivalent);
            Assert.True(ProtocolValidation.IsSha256(first));
            Assert.NotEqual(first, changed);
        }

        [Fact]
        public void Sheet_kernel_excludes_placeholders_and_checks_invariants_before_inside_after()
        {
            FakeSheetIterator iterator = new FakeSheetIterator(false, true, false, true, false);
            FakeInvariantProbe probe = new FakeInvariantProbe(0, FailureCode.None);

            SheetCountOutcome outcome = SheetCountKernel.Count(iterator, probe);

            Assert.True(outcome.Succeeded);
            Assert.Equal(3, outcome.Count);
            Assert.Equal(7, probe.Calls);
        }

        [Fact]
        public void Sheet_kernel_fails_on_inside_document_drift_without_returning_partial_count()
        {
            FakeSheetIterator iterator = new FakeSheetIterator(false, false, false);
            FakeInvariantProbe probe = new FakeInvariantProbe(3, FailureCode.DocumentChanged);

            SheetCountOutcome outcome = SheetCountKernel.Count(iterator, probe);

            Assert.False(outcome.Succeeded);
            Assert.Equal(0, outcome.Count);
            Assert.Equal(FailureCode.DocumentChanged, outcome.FailureCode);
        }

        [Fact]
        public void Sheet_kernel_caps_regular_sheets_at_one_hundred_thousand()
        {
            FakeSheetIterator iterator = new FakeSheetIterator(SafeReadContract.MaximumSheetCount + 1);
            FakeInvariantProbe probe = new FakeInvariantProbe(0, FailureCode.None);

            SheetCountOutcome outcome = SheetCountKernel.Count(iterator, probe);

            Assert.False(outcome.Succeeded);
            Assert.Equal(FailureCode.CountLimitExceeded, outcome.FailureCode);
        }

        private static DocumentIdentityFacts Facts(
            object runtime,
            string fingerprint,
            bool isModifiable,
            bool isModified)
        {
            return new DocumentIdentityFacts(runtime, fingerprint, true, isModifiable, isModified);
        }

        private sealed class FakeSheetIterator : ISheetFactIterator
        {
            private readonly bool[]? _placeholderFacts;
            private readonly int _regularCount;
            private int _index = -1;

            public FakeSheetIterator(params bool[] placeholderFacts)
            {
                _placeholderFacts = placeholderFacts;
            }

            public FakeSheetIterator(int regularCount)
            {
                _regularCount = regularCount;
            }

            public bool MoveNext()
            {
                _index++;
                if (_placeholderFacts != null)
                    return _index < _placeholderFacts.Length;
                return _index < _regularCount;
            }

            public bool CurrentIsPlaceholder
            {
                get { return _placeholderFacts != null && _placeholderFacts[_index]; }
            }
        }

        private sealed class FakeInvariantProbe : IDocumentInvariantProbe
        {
            private readonly int _failOnCall;
            private readonly FailureCode _failure;

            public FakeInvariantProbe(int failOnCall, FailureCode failure)
            {
                _failOnCall = failOnCall;
                _failure = failure;
            }

            public int Calls { get; private set; }

            public FailureCode Verify()
            {
                Calls++;
                return Calls == _failOnCall ? _failure : FailureCode.None;
            }
        }
    }
}
