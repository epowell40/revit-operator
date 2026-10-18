using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    public static class DrawingSpecManagedUpdateGuard
    {
        // Canonical settlement requires a complete bounded affected-target set.
        // Check the known native inventory inside the transaction, before commit.
        public static void RequireBoundedInventory(IEnumerable<long> affected)
        {
            if (affected.Where(id => id > 0).Distinct().Take(4097).Count() > 4096)
                throw new InvalidOperationException("Drawing-spec change exceeds the complete settlement inventory bound. Roll back and split the source into separately managed sections.");
        }

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
