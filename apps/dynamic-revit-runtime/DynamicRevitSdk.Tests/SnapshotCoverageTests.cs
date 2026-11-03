using RevitOperator.DynamicRevitSdk;
using Xunit;

namespace DynamicRevitSdk.Tests;

public sealed class SnapshotCoverageTests
{
    [Fact]
    public void ReadScopeCanDescribeTwoThousandRowsWithoutClaimingLinkedOrParameterCompleteness()
    {
        var coverage = DynamicSnapshotCoverage.Create("OST_Rooms", new[] { "Name" }, 4096, 2000, false);
        coverage.Validate(2000);
        Assert.Equal("active_document_non_type_elements", coverage.SourceScope);
        Assert.False(coverage.HasMore);
        Assert.Equal(2000, coverage.ReturnedCount);
        Assert.Equal(new[] { "Name" }, coverage.ParameterNames);
    }

    [Fact]
    public void TruncationIsExplicitAndIncompleteFieldsCannotPretendToBeACompleteCohort()
    {
        var coverage = DynamicSnapshotCoverage.Create("OST_Rooms", new[] { "Name" }, 1000, 1000, true);
        Assert.True(coverage.HasMore);
        Assert.Throws<ArgumentException>(() => coverage.Validate(999));
        Assert.Throws<ArgumentException>(() => DynamicSnapshotCoverage.Create("OST_Rooms", new[] { "Name" }, 1000, 999, true));
        Assert.Throws<ArgumentException>(() => DynamicSnapshotCoverage.Create("OST_Rooms", new[] { "Name" }, 4097, 2000, false));
        coverage.SourceScope = "linked_document";
        Assert.Throws<ArgumentException>(() => coverage.Validate(1000));
    }

    [Fact]
    public void CoverageAndRequestedFieldsAreBoundToInputHashWhileOldInputsRemainUsable()
    {
        var input = new DynamicTaskInput();
        var oldHash = DynamicWire.InputHash(input);
        input.Coverage = DynamicSnapshotCoverage.Create("OST_Rooms", new[] { "Name" }, 200, 0, false);
        var coveredHash = DynamicWire.InputHash(input);
        Assert.NotEqual(oldHash, coveredHash);
        input.Coverage.Category = "OST_MEPSpaces";
        Assert.NotEqual(coveredHash, DynamicWire.InputHash(input));
        input.Coverage.Category = "OST_Rooms";
        input.Coverage.ParameterNames = new[] { "Number" };
        Assert.NotEqual(coveredHash, DynamicWire.InputHash(input));
        input.Coverage = null;
        Assert.Equal(oldHash, DynamicWire.InputHash(input));
    }
}
