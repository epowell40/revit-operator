using System;
using System.Collections.Generic;
using RevitBridge.Common;
using Xunit;

public sealed class OperatorWorkbookPresentationTests
{
    [Fact]
    public void RequestedColumnsPreserveOrderNumbersZeroAndMissingWithoutRelabelingHeight()
    {
        IReadOnlyList<object?>[] rows = {
            new object?[20],
            new object?[]{"u1","1","Rooms","A","A","","A","ok",0d,"square feet [unit]","0 SF","ok",8d,"feet [unit]","8'","ok",null,"","","unset"},
            new object?[]{"u2","2","Rooms","B","=text","","=text","ok",20d,"square feet [unit]","20 SF","ok",9d,"feet [unit]","9'","ok",180d,"cubic feet [unit]","180 CF","ok"}
        };
        var table=OperatorWorkbookPresentation.Build(new[]{"Name","Area","Unbounded Height","Volume"},rows);
        Assert.Equal("Table",table.Name);
        Assert.Equal(new object?[]{"Name","Area (square feet)","Unbounded Height (feet)","Volume (cubic feet)"},table.Rows[0]);
        Assert.Equal(new object?[]{"A",0d,8d,null},table.Rows[1]);
        Assert.Equal(new object?[]{"=text",20d,9d,180d},table.Rows[2]);
        Assert.Equal(3,table.Rows.Count);
    }
    [Fact]
    public void MixedUnitsRetainFormattedValuesAndMalformedSourceRejects()
    {
        IReadOnlyList<object?>[] rows={new object?[8],new object?[]{"u","1","Rooms","A",1d,"feet","1 ft","ok"},new object?[]{"v","2","Rooms","B",2d,"meters","2 m","ok"}};
        var table=OperatorWorkbookPresentation.Build(new[]{"Height"},rows);
        Assert.Equal("Height (mixed units; see Elements)",table.Rows[0][0]);
        Assert.Equal("1 ft",table.Rows[1][0]);Assert.Equal("2 m",table.Rows[2][0]);
        Assert.Throws<ArgumentException>(()=>OperatorWorkbookPresentation.Build(new[]{"Height"},new IReadOnlyList<object?>[]{new object?[4]}));
    }
}
