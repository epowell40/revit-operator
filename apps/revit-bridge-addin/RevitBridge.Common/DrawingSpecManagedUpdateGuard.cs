using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    public static class DrawingSpecManagedUpdateGuard
    {
        private static bool Hash(string? value) => value != null && value.Length == 64 && value.All(c => "0123456789abcdef".Contains(c));

        public static void RequireCurrent(string? expectedSource, string? expectedNative, string retainedSource, string retainedNative, string currentNative)
        {
            if (!Hash(expectedSource) || !Hash(expectedNative) || !Hash(retainedSource) || !Hash(retainedNative) || !Hash(currentNative))
                throw new ArgumentException("Managed update requires complete lowercase source and native SHA256 snapshots.");
            if (expectedSource != retainedSource || expectedNative != retainedNative || currentNative != retainedNative)
                throw new InvalidOperationException("Drawing specifications changed. Inspect and reconcile the current source/native state before updating; no text was replaced.");
        }

        public static void RequireExactDeletion(IEnumerable<long> ownedNotes, IEnumerable<long> deleted)
        {
            var expected = ownedNotes.ToArray(); var actual = deleted.ToArray();
            if (expected.Length == 0 || expected.Any(id => id <= 0) || expected.Distinct().Count() != expected.Length ||
                actual.Any(id => id <= 0) || actual.Distinct().Count() != actual.Length || !new HashSet<long>(expected).SetEquals(actual))
                throw new InvalidOperationException("Text replacement would delete missing or unrelated dependent elements. Roll back the entire managed update.");
        }
    }
}
