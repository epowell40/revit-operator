using System;
using System.Linq;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class ParameterValuePreservationDigestTests
    {
        private static PreservedParameterValue Text(long id, string value) => new PreservedParameterValue
            { Id = id, Name = "Review Note", Storage = "String", HasValue = true, Value = value, UserModifiable = true };

        [Fact]
        public void EnumerationOrderDoesNotMatterAndEqualNamesRemainDistinctParameters()
        {
            var first = Text(1, "Device A"); var second = Text(2, "Device B");
            var hash = ParameterValuePreservationDigest.Compute(new[] { first, second }, null, out var count);
            Assert.Equal(2, count);
            Assert.Equal(hash, ParameterValuePreservationDigest.Compute(new[] { second, first }, null, out _));
            second.Value = "Device A";
            Assert.NotEqual(hash, ParameterValuePreservationDigest.Compute(new[] { first, second }, null, out _));
        }

        [Fact]
        public void OnlyTheExactNewParameterIsExcludedFromTheOldDataComparison()
        {
            var old = Text(10, "Existing type note"); var added = Text(20, "");
            var before = ParameterValuePreservationDigest.Compute(new[] { old }, null, out _);
            Assert.Equal(before, ParameterValuePreservationDigest.Compute(new[] { old, added }, 20, out var count));
            Assert.Equal(1, count);
            Assert.NotEqual(before, ParameterValuePreservationDigest.Compute(new[] { old, added }, 10, out _));
            old.Value = "Unrequested type-wide edit";
            Assert.NotEqual(before, ParameterValuePreservationDigest.Compute(new[] { old, added }, 20, out _));
        }

        [Fact]
        public void RawNumericValuesAndNullEmptyUnsetStatesAreDistinct()
        {
            var p = new PreservedParameterValue { Id = 11, Name = "Offset", Storage = "Double", HasValue = true, Value = 0.125d };
            var before = ParameterValuePreservationDigest.Compute(new[] { p }, null, out _);
            p.Value = 0.126d; Assert.NotEqual(before, ParameterValuePreservationDigest.Compute(new[] { p }, null, out _));
            p = Text(11, ""); var empty = ParameterValuePreservationDigest.Compute(new[] { p }, null, out _);
            p.Value = null; var nullString = ParameterValuePreservationDigest.Compute(new[] { p }, null, out _);
            Assert.NotEqual(empty, nullString); p.HasValue = false;
            Assert.NotEqual(nullString, ParameterValuePreservationDigest.Compute(new[] { p }, null, out _));
        }

        [Fact]
        public void ParameterMetadataChangesAlsoInvalidatePreservation()
        {
            var p = Text(11, "Keep"); var before = ParameterValuePreservationDigest.Compute(new[] { p }, null, out _);
            p.IsReadOnly = true; Assert.NotEqual(before, ParameterValuePreservationDigest.Compute(new[] { p }, null, out _));
            p.IsReadOnly = false; p.UserModifiable = false; Assert.NotEqual(before, ParameterValuePreservationDigest.Compute(new[] { p }, null, out _));
        }

        [Fact]
        public void DuplicateIdsAndIncompleteOrUnboundedRawValuesAreNotHashedAsComplete()
        {
            Assert.Throws<InvalidOperationException>(() => ParameterValuePreservationDigest.Compute(new[] { Text(1, "a"), Text(1, "b") }, null, out _));
            Assert.Throws<InvalidOperationException>(() => ParameterValuePreservationDigest.Compute(Enumerable.Range(1, 2049).Select(i => Text(i, "")), null, out _));
            var p = Text(1, "a"); p.HasValue = false;
            Assert.Throws<InvalidOperationException>(() => ParameterValuePreservationDigest.Compute(new[] { p }, null, out _));
            p.HasValue = true; p.Storage = "Double"; p.Value = double.NaN;
            Assert.Throws<InvalidOperationException>(() => ParameterValuePreservationDigest.Compute(new[] { p }, null, out _));
            p.Value = double.PositiveInfinity;
            Assert.Throws<InvalidOperationException>(() => ParameterValuePreservationDigest.Compute(new[] { p }, null, out _));
        }

        [Fact]
        public void IntegerAndElementReferenceValuesRetainTheirNativeStorageKinds()
        {
            var integer = new PreservedParameterValue { Id = 1, Name = "Count", Storage = "Integer", HasValue = true, Value = 20 };
            var reference = new PreservedParameterValue { Id = 2, Name = "Level", Storage = "ElementId", HasValue = true, Value = 20L };
            Assert.NotEqual(ParameterValuePreservationDigest.Compute(new[] { integer }, null, out _),
                ParameterValuePreservationDigest.Compute(new[] { reference }, null, out _));
            reference.Value = 20;
            Assert.Throws<InvalidOperationException>(() => ParameterValuePreservationDigest.Compute(new[] { reference }, null, out _));
        }
    }
}
